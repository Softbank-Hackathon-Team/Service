// 이전마다 실제 트래픽 입구: Cloudflare 도착 터널·모니터·pool·LB 를 만들고 이 이전에 등록한다 (shift 가 진짜 Cloudflare 전환기를 쓴다).
// DECISION(team): 트래픽 전환을 이전마다 자동으로 실제 Cloudflare 로 (2026-11-07 리더 결정). 예전엔 사람이 cf-check·cf-register 로 붙였다.
// 켜기: TRAFFIC_AUTO_LB=1 + CLOUDFLARE_PROVISION_API_TOKEN(없으면 CLOUDFLARE_API_TOKEN) + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_ZONE_ID.
//   DRAFT(ai): 기본 끔. 켜지 않은 판·이전은 예전과 같다 (등록 없음 → MOCK_TRAFFIC 이면 흉내, 아니면 TRAFFIC_NOT_CONFIGURED)
// 전제(고객 쪽): 출발 앱이 이미 우리 Cloudflare 존의 호스트 뒤에 있다 (명세 입구 호스트의 DNS 줄 = 출발 오리진). 없으면 멈추고 알려 준다
// 토큰 전달: 온프레 도착만 봉인 비밀(SealedSecret cloudflared-token)로 gitops 에 싣는다.
//   TODO(human): 클라우드(aws·gcp) 도착은 도착 비밀 저장소에 쓰는 길이 아직 없다 → 그 판은 건너뛰고 경고 (예전처럼 사람이 토큰을 넣는다)
import type { ChartSealedSecret, HelmValues, TrafficTarget } from "@svc/contracts";
import { upsertTrafficTarget, withTenant } from "@svc/core";
import { cfRequest, ensureMigrationCf, teardownMigrationCf, type CfProvisionCtx, type CfTeardownResult, type FetchLike } from "@svc/traffic";
import { sealedSecretValues } from "./gitops/migration-secrets.js";

export const TUNNEL_TOKEN_SECRET = "cloudflared-token";   // 차트 ingress.tunnelTokenSecret (adapters target cloud.ts TUNNEL_SECRET 과 같은 이름)

export function cfProvisionFromEnv(env: NodeJS.ProcessEnv = process.env, fetch?: FetchLike): CfProvisionCtx | null {
  if (env.TRAFFIC_AUTO_LB?.trim() !== "1") return null;
  const token = env.CLOUDFLARE_PROVISION_API_TOKEN || env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID, zoneId = env.CLOUDFLARE_ZONE_ID;
  if (!token || !accountId || !zoneId) return null;
  return { token: async () => token, accountId, zoneId, ...(fetch ? { fetch } : {}), ...(env.CLOUDFLARE_API_BASE ? { baseUrl: env.CLOUDFLARE_API_BASE } : {}) };
}
/** 켜졌는데 빠진 설정 이름 (화면 안내용). 꺼져 있으면 빈 배열 */
export function missingCfProvision(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.TRAFFIC_AUTO_LB?.trim() !== "1") return [];
  return [
    ...(env.CLOUDFLARE_PROVISION_API_TOKEN || env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN ? [] : ["CLOUDFLARE_PROVISION_API_TOKEN"]),
    ...(env.CLOUDFLARE_ACCOUNT_ID ? [] : ["CLOUDFLARE_ACCOUNT_ID"]), ...(env.CLOUDFLARE_ZONE_ID ? [] : ["CLOUDFLARE_ZONE_ID"]),
  ];
}

interface ChartIngress { mode?: string; hosts?: Array<{ hostnames?: string[]; paths?: Array<{ service?: string; port?: number }> }> }
/** 순수 함수: 값에서 첫 입구 호스트와 도착 연결 대상. 입구가 없으면 null (차트 ingress.yaml 이 cloudflared 를 그리는 조건과 같게 첫 path) */
export function entryOf(values: HelmValues): { hostname: string; targetService: string } | null {
  const ing = values.ingress as ChartIngress | undefined;
  if (ing?.mode !== "cloudflared") return null;
  const host = ing.hosts?.find((h) => h.hostnames?.length && h.paths?.some((p) => p.service && p.port));
  const path = host?.paths?.find((p) => p.service && p.port);
  if (!host || !path) return null;
  return { hostname: host.hostnames![0]!, targetService: `http://${path.service}.${String(values.namespace)}:${path.port}` };
}

/** 출발 오리진 = 앱 호스트의 지금 DNS 줄 값 (터널이면 <id>.cfargotunnel.com, 아니면 그 주소). LB 를 만든 뒤에도 DNS 줄은 그대로 남아 롤백 뒤 다시 받는다 */
export async function sourceOriginOf(c: CfProvisionCtx, hostname: string): Promise<string | null> {
  const rows = await cfRequest<Array<{ type: string; name: string; content: string }>>(
    { token: c.token, fetch: c.fetch, baseUrl: c.baseUrl }, "GET", `/zones/${c.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
  const r = rows.find((x) => x.name === hostname && (x.type === "CNAME" || x.type === "A" || x.type === "AAAA"));
  return r?.content ?? null;
}

export type TrafficEntryOutcome =
  | { kind: "off" }
  | { kind: "skipped"; reason: string }
  | { kind: "stop"; code: "TRAFFIC_ENTRY_NOT_CONFIGURED" | "TRAFFIC_SOURCE_ENTRY_MISSING" | "TRAFFIC_ENTRY_FAILED"; reason: string; hint?: string }
  | { kind: "ok"; sealedSecret: ChartSealedSecret; detail: Record<string, unknown> };

export interface TrafficEntryDeps {
  ctx?: CfProvisionCtx | null;
  register?: (tenantId: string, migrationId: string, t: TrafficTarget) => Promise<void>;
}

/** 배포 직전 (리허설 렌더 앞): 온프레 도착이면 Cloudflare 자원을 만들고 등록, 터널 토큰을 봉인 비밀로 돌려준다. 평문 토큰은 이 함수 밖으로 안 나간다 */
export async function prepareTrafficEntry(i: { tenantId: string; migrationId: string; provider: string; values: HelmValues; sealingCertPem: string | null },
    env: NodeJS.ProcessEnv = process.env, deps: TrafficEntryDeps = {}): Promise<TrafficEntryOutcome> {
  if (env.TRAFFIC_AUTO_LB?.trim() !== "1") return { kind: "off" };
  const ctx = deps.ctx === undefined ? cfProvisionFromEnv(env) : deps.ctx;
  if (!ctx) return { kind: "stop", code: "TRAFFIC_ENTRY_NOT_CONFIGURED", reason: `TRAFFIC_AUTO_LB=1 인데 ${missingCfProvision(env).join("·")} 없음`,
    hint: "worker 비밀(worker-env)에 Cloudflare 토큰·계정·존 번호를 넣고 재개하거나, TRAFFIC_AUTO_LB 를 끈다" };
  const entry = entryOf(i.values);
  if (!entry) return { kind: "skipped", reason: "명세에 공개 입구(호스트)가 없다 → 트래픽 LB 를 만들지 않는다 (shift 는 예전 길)" };
  if (i.provider !== "onprem") return { kind: "skipped", reason: `${i.provider} 도착은 터널 토큰을 도착 비밀 저장소에 넣는 길이 아직 없다 (TODO(human))` };
  if (!i.sealingCertPem) return { kind: "stop", code: "TRAFFIC_ENTRY_FAILED", reason: "도착 온프레 봉인 인증서가 아직 없다 (Agent 보고 전)", hint: "Agent 가 붙은 뒤 재개" };
  try {
    const sourceOrigin = await sourceOriginOf(ctx, entry.hostname);
    if (!sourceOrigin) return { kind: "stop", code: "TRAFFIC_SOURCE_ENTRY_MISSING",
      reason: `출발 앱 호스트 ${entry.hostname} 의 DNS 줄이 Cloudflare 존에 없다 (출발 오리진을 모름)`,
      hint: "출발 앱을 이 존의 호스트 뒤에 먼저 둔다 (터널 CNAME 또는 A 줄). 그 뒤 재개" };
    const r = await ensureMigrationCf(ctx, { migrationId: i.migrationId, hostname: entry.hostname, sourceOrigin, targetService: entry.targetService });
    const t: TrafficTarget = { provider: "cloudflare", lbId: r.lbId, sourcePoolId: r.sourcePoolId, targetPoolId: r.targetPoolId, zoneId: ctx.zoneId };
    await (deps.register ?? ((tenantId, migrationId, tt) => withTenant(tenantId, (tx) => upsertTrafficTarget(tx, tenantId, migrationId, tt, "worker:traffic-entry"))))(i.tenantId, i.migrationId, t);
    const sealed = sealedSecretValues(i.sealingCertPem, String(i.values.namespace), TUNNEL_TOKEN_SECRET, { token: r.tunnelToken });
    return { kind: "ok", sealedSecret: { name: sealed.name, encryptedData: sealed.encryptedData },
      detail: { hostname: entry.hostname, lbId: r.lbId, sourcePoolId: r.sourcePoolId, targetPoolId: r.targetPoolId, tunnelId: r.tunnelId, sourceOrigin: maskOrigin(sourceOrigin) } };
  } catch (e) {
    const msg = (e as Error).message;
    return { kind: "stop", code: "TRAFFIC_ENTRY_FAILED", reason: msg.slice(0, 300), hint: entryFailHint(msg) };
  }
}
/** 실패 문구로 고치는 법을 고른다. 요금제 오리진 한도(1002 "surpass the limit")는 토큰 문제가 아니다 (2026-11-07 실측) */
export function entryFailHint(msg: string): string {
  if (/surpass the limit/i.test(msg))
    return "Cloudflare Load Balancing 요금제의 오리진 수 한도에 걸림 (이전 하나에 출발·도착 2개 필요). 안 쓰는 LB·pool 을 지우거나 오리진 한도를 올린 뒤 재개. 한도 2면 한 번에 이전 하나만 된다";
  return "Cloudflare 토큰 권한(Tunnel Edit, LB Monitors and Pools Edit, Zone LB Edit, DNS Read)·존을 확인한 뒤 재개 (여러 번 해도 같은 자원을 다시 쓴다)";
}
const maskOrigin = (o: string) => o.replace(/^([0-9a-f]{4})[0-9a-f-]{28,}/i, "$1…");

/** 값에 터널 토큰 봉인 비밀을 넣고, 같은 이름을 비밀 저장소에서 읽으려던 ExternalSecret 줄은 뺀다 (순수) */
export function withTrafficEntry(values: HelmValues, sealed: ChartSealedSecret): HelmValues {
  const es = values.externalSecrets as { store?: unknown; secrets?: Array<{ name: string }> } | undefined;
  const sealedSecrets = [...((values.sealedSecrets as ChartSealedSecret[] | undefined) ?? []).filter((s) => s.name !== sealed.name), sealed];
  return { ...values, ...(es ? { externalSecrets: { ...es, secrets: (es.secrets ?? []).filter((s) => s.name !== sealed.name) } } : {}), sealedSecrets };
}

/** 롤백(rolled_back)·완료(completed) 뒤 정리. 켜지지 않았으면 아무것도 안 한다. 실패는 결과에만 (이전 상태를 바꾸지 않는다) */
export async function teardownTrafficEntry(migrationId: string, o: { keepTarget: boolean }, env: NodeJS.ProcessEnv = process.env,
    ctx: CfProvisionCtx | null = cfProvisionFromEnv(env)): Promise<CfTeardownResult | { skipped: string }> {
  if (!ctx) return { skipped: "traffic_auto_lb_off" };
  try { return await teardownMigrationCf(ctx, migrationId, o); }
  catch (e) { return { removed: [], kept: [], errors: [(e as Error).message.slice(0, 300)] }; }
}
