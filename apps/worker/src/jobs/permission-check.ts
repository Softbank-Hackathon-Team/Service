import { PermissionCheckJob, StoredPermissionCheck, type PermissionBundle, type PermissionGap, type Provider } from "@svc/contracts";
import { withTenant, scrubString } from "@svc/core";
import { envFor } from "@svc/adapters";
import { StsCliError, TempRoleDenied, type TempRoleBroker } from "@svc/security";
import { realStsEnabled, tempRoles } from "../platform.js";
import { checkEnvBundles, platformSaOf, type GateDeps } from "../permission-gate.js";
import { permissionBundles } from "../permission-hints.js";

// PERM-GATE: 환경 화면의 [다시 확인] (api POST /environments/:id/permission-check 가 냄). 상태를 안 옮긴다.
//   ① 환경 다시 읽기 ② 트랜잭션 밖에서 관찰 역할 빌려 묶음 확인(읽기만) + 회수 ③ environment_permissions 에 저장
//   못 읽으면 던지지 않고 그 이유를 결과(error)로 저장한다 (화면이 이유를 보여 주고 사람이 다시 누른다). 실자원 조회(inventory-refresh)와 같은 모양

// DRAFT(ai): 15분 (STS 최소값, 연결 확인과 같음). 확인이 끝나면 바로 돌려준다
export const PERMISSION_CHECK_TTL_SEC = 900;
interface EnvRow { provider: Provider; connection_status: string; account_id: string | null; gcp_target_project: string | null; region: string | null }

/** 환경 하나의 확인 대상 묶음: 그 클라우드 묶음 전부 (도착 묶음은 GCP 전용 프로젝트가 있을 때만). 이전이 쓰는 것만 막는 일은 사전 점검이 한다.
 *  허브 묶음(gcp.hub)은 플랫폼이 허브를 쓸 때(GCP_PLATFORM_PROJECT 있음)만 — 사전 점검의 argo_hub 조건과 같은 기준 */
export function envBundles(all: PermissionBundle[], e: Pick<EnvRow, "provider" | "gcp_target_project">, o: { hub: boolean } = { hub: true }): (PermissionBundle & { onSide: "source" | "target" })[] {
  return all.filter((b) => b.cloud === e.provider && (e.provider !== "gcp" || b.side === "source" || !!e.gcp_target_project)
    && (b.principal !== "platform" || o.hub))
    .map((b) => ({ ...b, onSide: b.side === "source" ? "source" as const : "target" as const }));
}

export interface PermissionCheckDeps extends GateDeps { roles?: Pick<TempRoleBroker, "issue" | "use" | "revoke">; realSts?: boolean }

export async function handlePermissionCheck(raw: unknown, deps: PermissionCheckDeps = {}): Promise<"saved" | "skipped"> {
  const job = PermissionCheckJob.parse(raw);   // 큐 내용은 믿지 않는다: 모양부터
  const env = await withTenant(job.tenantId, async (tx) => (await tx.query<EnvRow>(
    `SELECT provider, connection_status, account_id, gcp_target_project, region FROM environments WHERE id=$1`, [job.envId])).rows[0]);
  if (!env || (env.provider !== "aws" && env.provider !== "gcp")) return "skipped";
  const result = await checkFor(job, env, deps);
  await withTenant(job.tenantId, (tx) => tx.query(
    `INSERT INTO environment_permissions (environment_id, tenant_id, result, checked_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (environment_id) DO UPDATE SET result = EXCLUDED.result, checked_at = EXCLUDED.checked_at`,
    [job.envId, job.tenantId, JSON.stringify(StoredPermissionCheck.parse(result))]));
  return "saved";
}

async function checkFor(job: PermissionCheckJob, env: EnvRow, deps: PermissionCheckDeps): Promise<StoredPermissionCheck> {
  const penv = deps.env ?? process.env;
  const file = permissionBundles(penv);
  const empty = (error: string, version = file?.version ?? 1): StoredPermissionCheck => ({ requiredVersion: version, grantedVersion: null, gaps: [], error: error.slice(0, 300) });
  if (!file) return empty("권한 묶음 파일(permission-bundles.json)이 없어 확인 못 함");
  if (env.connection_status !== "connected" && env.connection_status !== "unstable")
    return empty(`환경이 연결 상태가 아님 (${env.connection_status}) — 연결 확인을 먼저 한다`, file.version);
  const hub = env.provider === "gcp" && !!penv.GCP_PLATFORM_PROJECT?.trim();
  const bundles = envBundles(file.bundles, env, { hub });
  const roles = deps.roles ?? tempRoles();
  let ref: string | null = null;
  try {
    // 관찰 역할이 실제로 부르는 것 = 묶음 확인 읽기 (testIamPermissions 는 권한이 필요 없고, 정책·역할·API 목록 읽기 + AWS 흉내 평가)
    const actions = env.provider === "gcp" ? ["resourcemanager.projects.getIamPolicy", "iam.roles.get", "serviceusage.services.list"]
      : ["iam:GetRole", "iam:SimulatePrincipalPolicy"];
    const cred = await roles.issue({ tenantId: job.tenantId, envId: job.envId, provider: env.provider, purpose: "observe",
      actions, ttlSec: PERMISSION_CHECK_TTL_SEC }, { step: "permission_check" });
    ref = cred.credentialRef;
    if (cred.stub) {
      // 흉내 자격으로 고객 권한을 봤다고 하지 않는다 (진짜·흉내 모두 "확인 못 함"). 진짜 판이면 연결 링크를 안 거친 환경이다
      return empty((deps.realSts ?? realStsEnabled(penv)) ? "확인 불가: 가짜 자격 (MOCK_CREDENTIALS) — 콘솔 연결 링크로 만든 환경인지 확인"
        : "흉내 발급기(REAL_STS=0)라 고객 권한을 확인하지 않음", file.version);
    }
    const k = roles.use(ref, job.tenantId);
    const side = env.provider === "gcp"
      ? (k.kind === "bearer" ? { gcpToken: k.token } : null)
      : (k.kind === "aws" ? { awsEnv: envFor({ AWS_ACCESS_KEY_ID: k.accessKeyId, AWS_SECRET_ACCESS_KEY: k.secretAccessKey, AWS_SESSION_TOKEN: k.sessionToken,
        AWS_REGION: env.region || "ap-northeast-2" }, penv) } : null);
    if (!side) throw new Error(`${env.provider} 발급기가 맞지 않는 자격을 돌려줬다`);
    // 허브 묶음의 주체 = 이 회사 플랫폼 SA (사전 점검과 같은 값). 없으면 허브 묶음만 "확인 못 함" (리뷰 11/06: 예전엔 안 넘겨 늘 확인 못 함)
    const platformSa = hub ? await platformSaOf(job.tenantId, penv).catch(() => null) : null;
    const gaps = await checkEnvBundles({ envId: job.envId, provider: env.provider, accountId: env.account_id, targetProject: env.gcp_target_project,
      region: env.region, platformSa, ...side }, bundles, file.version, deps);
    // 빠진 묶음이 없으면 고객 쪽 실제 상태 = 지금 판 (역할 설명·태그가 옛 판이어도 권한은 다 있음)
    return { requiredVersion: file.version, grantedVersion: gaps.length ? minVersion(gaps) : file.version, gaps };
  } catch (e) {
    if (e instanceof TempRoleDenied) return empty(`확인 불가: 관찰 역할을 못 빌림 (${e.code})`, file.version);
    if (e instanceof StsCliError && e.awsCode) return empty(`확인 불가: 관찰 역할을 못 빌림 (${e.awsCode})`, file.version);
    return empty(`확인 불가: ${scrubString((e as Error)?.message ?? String(e)).slice(0, 200)}`, file.version);
  } finally {
    if (ref) await roles.revoke(ref, job.tenantId, "permission_check_done").then(() => undefined,
      (e) => console.error("permission check revoke", scrubString((e as Error).message)));
  }
}

/** 고객 쪽에 붙은 판 = 읽은 판 중 가장 낮은 것 (읽은 게 없으면 모름) */
const minVersion = (gaps: PermissionGap[]) => {
  const v = gaps.map((g) => g.grantedVersion).filter((x): x is number => x !== null);
  return v.length ? Math.min(...v) : null;
};
