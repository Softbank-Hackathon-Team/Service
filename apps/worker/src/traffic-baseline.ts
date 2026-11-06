import { actionsOfCommands, ALB_RATE_AWS_COMMANDS, readAlbRequestRate, type AlbRateResult } from "@svc/adapters";
import { scrubString, withTenant, writeAudit } from "@svc/core";
import type { TempRoleBroker } from "@svc/security";
import type { TrafficSwitcher } from "@svc/traffic";
import { tempRoles } from "./platform.js";

// #245: 전환 직전 출발 ALB 요청 수를 기준값으로 읽는다 (단계별 몫 확인용). 읽지 못해도 전환을 막지 않고 이유를 결과에 남긴다.
//   그 경우 출발 지표가 없으면 몫 확인이 10% 에서 멈춘다 (TRAFFIC_SHARE_NOT_REACHED). 이유는 결과 detail.sourceBaseline 에 있다
const TTL_SEC = 900;   // AWS AssumeRole 최소 시간
const DEFAULT_REGION = "ap-northeast-2";   // DRAFT(ai): 환경에 리전이 없으면 서울 (import.ts 와 같음)
const AUDIT_ACTION = "traffic.source_baseline";
export type SourceBaselineResult = AlbRateResult & { reused?: true };

interface ReadInput { tenantId: string; migrationId: string; envId: string; provider: string; region: string | null; origins: string[] }
interface ReadDeps { roles: Pick<TempRoleBroker, "issue" | "use" | "revoke">; read?: typeof readAlbRequestRate; now?: () => Date }

/** 관찰 역할을 이 읽기에 필요한 권한만으로 빌려 읽고 바로 돌려준다 */
export async function readSourceBaseline(i: ReadInput, d: ReadDeps): Promise<AlbRateResult> {
  if (i.provider !== "aws") return { error: `출발 ${i.provider} 은 CloudWatch 기준값을 읽지 않음` };
  if (i.origins.length === 0) return { error: "출발 풀의 원본 주소를 못 찾음" };
  const cred = await d.roles.issue({ tenantId: i.tenantId, envId: i.envId, provider: "aws", purpose: "observe", migrationId: i.migrationId,
    actions: actionsOfCommands("aws", ALB_RATE_AWS_COMMANDS), ttlSec: TTL_SEC }, { step: "shift" });
  try {
    if (cred.stub) return { error: "흉내 자격이라 CloudWatch 를 읽지 않음" };
    const k = d.roles.use(cred.credentialRef, i.tenantId, i.migrationId);
    if (k.kind !== "aws") return { error: "AWS 자격이 아님" };
    const region = i.region || DEFAULT_REGION;
    return await (d.read ?? readAlbRequestRate)({ origins: i.origins, region, now: (d.now ?? (() => new Date()))(),
      cliEnv: { AWS_ACCESS_KEY_ID: k.accessKeyId, AWS_SECRET_ACCESS_KEY: k.secretAccessKey, AWS_SESSION_TOKEN: k.sessionToken, AWS_REGION: region } });
  } finally {
    await d.roles.revoke(cred.credentialRef, i.tenantId, "baseline_done").catch((e) => console.error("baseline revoke", scrubString((e as Error).message)));
  }
}

/** 처음 전환 때 읽어 감사에 남기고, 다시 들어오면 그 값을 쓴다 (전환 중에는 출발 요청 수가 이미 줄어 있다) */
export async function sourceBaselineFor(tenantId: string, migrationId: string, envId: string, switcher: TrafficSwitcher, firstShift: boolean): Promise<SourceBaselineResult> {
  try {
    const { saved, env } = await withTenant(tenantId, async (tx) => ({
      saved: (await tx.query<{ detail: AlbRateResult }>(`SELECT detail FROM audit_events WHERE target = $1 AND action = $2 ORDER BY seq DESC LIMIT 1`, [migrationId, AUDIT_ACTION])).rows[0]?.detail,
      env: (await tx.query<{ provider: string; region: string | null }>(`SELECT provider, region FROM environments WHERE id = $1`, [envId])).rows[0],
    }));
    if (saved && "rps" in saved) return { ...saved, reused: true };
    // 다시 들어온 전환은 출발 요청 수가 이미 줄었을 수 있어 새로 읽으면 전체를 적게 잡는다
    if (!firstShift) return { error: "처음 전환 때 기준값을 못 읽었고, 전환이 시작된 뒤라 새로 읽지 않음" };
    if (!switcher.sourceOrigins) return { error: "이 전환기는 출발 원본 주소를 알려 주지 않음" };
    const origins = env?.provider === "aws" ? await switcher.sourceOrigins() : [];
    const r = await readSourceBaseline({ tenantId, migrationId, envId, provider: env?.provider ?? "unknown", region: env?.region ?? null, origins }, { roles: tempRoles() });
    if ("rps" in r) await withTenant(tenantId, (tx) => writeAudit(tx, tenantId, { actor: "worker", action: AUDIT_ACTION, target: migrationId, result: "ok", detail: r }));
    return r;
  } catch (e) {
    return { error: scrubString((e as Error).message).slice(0, 300) };
  }
}
