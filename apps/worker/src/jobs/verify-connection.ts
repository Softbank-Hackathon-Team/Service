import { envNumber, nextAfterPeriodic, VerifyConnectionJob, type ConnectionStatus } from "@svc/contracts";
import { advanceConnection, withTenant } from "@svc/core";
import { verifyAwsObserve, verifyGcpObserve, type CliDeps } from "@svc/adapters";
import { GcpIssueError, StsCliError, TempRoleDenied, maskAccount, type TempRoleBroker } from "@svc/security";
import { realStsEnabled, tempRoles } from "../platform.js";
import { isLastAttempt } from "./_step.js";

// PF01: 막 만든 역할·접근 항목이 퍼지는 동안 잠깐 나는 실패 (사람 확인 때만 다시 봄)
// FM-CON-09: 접근 항목을 막 만든 직후 401 도 잠깐 날 수 있어 같이 다시 본다 (옛 역할에 묶인 항목이면 끝까지 401 → failed, env:connect 가 고침)
const PROPAGATION_REASONS = new Set(["ROLE_ASSUME_DENIED", "K8S_ACCESS_MISSING", "K8S_ACCESS_MISSING:UNAUTHORIZED"]);
// DRAFT(ai): 5·10·15초 (합 30초). IAM 전파는 보통 수 초~10초+. VERIFY_PROPAGATION_DELAYS_MS="0,0" 같이 쉼표로 바꿈 (시험은 0)
export const verifyPropagationDelaysMs = (env: NodeJS.ProcessEnv = process.env): number[] => {
  const raw = env.VERIFY_PROPAGATION_DELAYS_MS?.trim();
  if (raw === undefined || raw === "") return [5000, 10000, 15000];
  if (raw === "off") return [];   // 시험(package.json test·test:db)은 끔. 다시 보기 시험은 deps.delaysMs 로 준다
  return raw.split(",").map((x) => Math.max(0, Number(x) || 0)).slice(0, 10);
};
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 플랫폼 쪽 문제(고객이 고칠 수 없음). 재시도해도 같으니 바로 failed 로 알린다
const PLATFORM_CRED_CODES = new Set(["ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId", "UnrecognizedClientException", "SignatureDoesNotMatch"]);
function platformFailure(e: unknown): string | null {
  if (e instanceof StsCliError) {
    if (e.missing) return "PLATFORM_CLI_MISSING";
    if (e.awsCode && PLATFORM_CRED_CODES.has(e.awsCode)) return "PLATFORM_CREDENTIALS_INVALID";
  }
  return null;
}

// L4: 연결 확인 작업 (verify-connection 큐). 설계 IA 6.1 4단계 · 5단계(주기 재확인은 처리만, 일정은 L4b)
//   1) 작업 내용을 믿지 않고 환경을 DB 에서 다시 읽음 → 2) 관찰 역할 15분 빌림 → 3) 꼭 필요한 읽기 API 실제 호출(어댑터)
//   → 4) 빌린 자격 회수(finally) → 5) advanceConnection 으로만 상태 기록 + 감사
// 사유가 정해진 실패는 작업 "성공"으로 끝낸다 (던지면 pg-boss 가 retryLimit 3 으로 다시 돌린다). 네트워크·명령 없음 같은 것만 던진다
// 첫 실행 역할은 빌리지 않는다: broker 가 실행 역할에 이전 번호·단계를 요구한다 → iam get-role 로 대신 (설계 IA 6.1 4단계와 다름)

// 관찰 역할이 실제로 부르는 읽기 동작 (최소 권한 검사·장부에 남는 목록)
export const VERIFY_ACTIONS = ["eks:ListClusters", "eks:DescribeCluster", "rds:DescribeDBInstances", "iam:GetRole", "guardduty:ListDetectors"];
// L7i: GCP 관찰 SA 가 실제로 쓰는 권한 (gcp-connect.sh 의 platform_observe 안 목록의 부분집합)
export const VERIFY_GCP_ACTIONS = ["resourcemanager.projects.get", "container.clusters.list", "cloudsql.instances.list", "iam.serviceAccounts.get"];
// DRAFT(ai): 관찰 역할 15분 (STS 최소값, 설계 IA 6.1 "15분 빌림")
export const VERIFY_TTL_SEC = 900;

export interface VerifyDeps { roles?: TempRoleBroker; cli?: CliDeps; delaysMs?: number[]; realSts?: boolean }
export interface VerifyOutcome { status: ConnectionStatus; reason?: string; skipped?: string }

interface EnvRow {
  provider: string; account_id: string | null; external_id: string | null; region: string | null; cluster_name: string | null;
  connection_status: ConnectionStatus; verify_failures: number; gcp_project_number: string | null;
}

/** FM-CON-07: 빌리기 거부 때 무엇이 막혔나 (감사 detail 에 남김. 계정 번호 없음) */
const deniedDetail = (e: unknown): Record<string, unknown> =>
  e instanceof StsCliError && e.awsCode === "AccessDenied" ? { deniedAction: e.deniedAction ?? "unknown" } : {};
/** 발급 실패 → 사유. 정해지지 않은 것은 null (다시 던짐) */
function issueFailure(e: unknown): string | null {
  if (e instanceof TempRoleDenied) return e.code;
  if (e instanceof GcpIssueError && e.reason !== "PLATFORM_SA_MISSING") return e.reason;   // 플랫폼 SA 없음 = 우리 설정 문제라 던진다
  if (e instanceof StsCliError) {
    if (e.awsCode === "AccessDenied") return "ROLE_ASSUME_DENIED";
    if (e.awsCode === "NoSuchEntity") return "ROLE_NOT_FOUND";
  }
  return null;
}

/** OBSROLE3: 빠진 선택 권한 → 사람이 할 일 한 줄. 갱신은 연결 스크립트를 다시 실행 (있는 역할에는 빠진 권한만 더한다) */
export const needsHumanText = (missing: string[], provider: "aws" | "gcp" = "gcp") => provider === "aws"
  ? `관찰 역할에 읽기 권한 ${missing.length}개가 없음(${missing.slice(0, 6).join(", ")}${missing.length > 6 ? " 외" : ""}). 연결 스택을 최신 템플릿으로 업데이트하거나 조직 SCP 가 막는지 확인. 그 전에는 보안 현황에서 해당 항목을 못 봄`
  : `관찰 역할에 읽기 권한 ${missing.length}개가 없음(${missing.slice(0, 6).join(", ")}${missing.length > 6 ? " 외" : ""}). 고객 Cloud Shell 에서 연결 스크립트(gcp-connect.sh)를 다시 실행하면 역할에 빠진 권한만 더해짐. 그 전에는 해당 자원을 가져오지 못하고 가져오기 notes 에 남음`;

export async function handleVerifyConnection(data: unknown, deps: VerifyDeps = {}): Promise<VerifyOutcome> {
  const job = VerifyConnectionJob.parse(data);
  const { tenantId, envId, reason } = job;
  const env = await withTenant(tenantId, async (tx) => (await tx.query<EnvRow>(
    `SELECT provider, account_id, external_id, region, cluster_name, connection_status, verify_failures, gcp_project_number
       FROM environments WHERE id = $1`, [envId])).rows[0]);
  // 남의 회사·지워진 환경: RLS 로 0줄 → 아무것도 안 바꾸고 끝 (다시 해도 같다)
  if (!env) return { status: "disconnected", skipped: "env_not_found" };
  const cur = env.connection_status;
  // L6: 온프레 연결 확인 = Agent 하트비트. 플랫폼은 온프레 API 서버에 못 붙는다(밖으로 나가는 연결만) → 빌린 자격·CLI 대신
  //   "살아 있는 Agent 키가 있고, 그 키로 마지막 하트비트가 AGENT_STALE_SEC 안에 왔나"를 DB(agent_reports)로 본다.
  //   connected 로 올리는 길은 하트비트 받기(agent-reports.ts heartbeatConnection) 하나. 여기서는 내리기(unstable·disconnected)만 한다
  if (env.provider === "onprem") return verifyOnprem(tenantId, envId, cur, env.verify_failures, reason);
  if (env.provider !== "aws" && env.provider !== "gcp") return { status: cur, skipped: "provider_not_supported" };
  if (reason === "user" && cur !== "verifying") return { status: cur, skipped: "not_verifying" };
  if (reason === "periodic" && cur !== "connected" && cur !== "unstable") return { status: cur, skipped: "not_connected" };

  const roles = deps.roles ?? tempRoles();
  // DRAFT(ai): 환경에 리전이 없으면 서울 (issuers.ts AWS_DEFAULT_REGION 과 같음)
  const region = env.region || "ap-northeast-2";
  type VerifyResult = { ok: true; clusters: string[]; projectNumber?: string; missingPermissions?: string[] } | { ok: false; reason: string };
  let result!: VerifyResult;
  // FM-GCP-03 (8Nr2 pf08) + PF01 (SvN5) 통합: 같은 다시 보기 고리 하나. GCP 는 IAM 전파가 더 길어(보통 1분) GCP_VERIFY_RETRY_MS(기본 20초) 간격
  //   GCP_VERIFY_ATTEMPTS(기본 4)번까지, ROLE_NOT_FOUND 도 다시 본다. DRAFT(ai): 시험(package.json)은 GCP_VERIFY_RETRY_MS=0 → 쉬지 않고 다시 봄
  const gcpRetry = env.provider === "gcp" && reason === "user" && !deps.delaysMs;
  const gcpAttempts = Math.max(1, Math.min(10, envNumber(process.env.GCP_VERIFY_ATTEMPTS, 4) || 4));
  const gcpWait = Math.max(0, envNumber(process.env.GCP_VERIFY_RETRY_MS, 20_000) || 0);
  const delays = gcpRetry ? Array.from({ length: gcpAttempts - 1 }, () => gcpWait)
    : reason === "user" ? (deps.delaysMs ?? verifyPropagationDelaysMs()) : [];
  const retryReasons = gcpRetry ? new Set([...PROPAGATION_REASONS, "ROLE_NOT_FOUND"]) : PROPAGATION_REASONS;
  let issueDenied: Record<string, unknown> = {};   // FM-CON-07: 마지막 시도의 거부 동작
  try {
  for (let attempt = 0; ; attempt++) {
    let ref: string | null = null;
    issueDenied = {};
    try {
      const gcp = env.provider === "gcp";
      try {
        const cred = await roles.issue({ tenantId, envId, provider: gcp ? "gcp" : "aws", purpose: "observe",
          actions: gcp ? VERIFY_GCP_ACTIONS : VERIFY_ACTIONS, ttlSec: VERIFY_TTL_SEC }, { step: "verify" });
        ref = cred.credentialRef;
        // L4b: 가짜 발급기(REAL_STS 꺼짐·external_id 없는 시드 환경)의 자격으로 고객 CLI 를 부르지 않는다 (가짜 키로 진짜 AWS 를 부르면
        //   InvalidClientTokenId 로 재시도만 돈다). 상태는 그대로 두고 끝. 주기 훑기가 시드 환경에도 오기 때문에 필요
        // DRAFT(ai): 가짜면 확인 안 함(connected 로 바꾸지도, 실패로 바꾸지도 않음). 화면은 지금 상태 그대로
        if (cred.stub) {
          await roles.revoke(ref, tenantId, "verify_done");
          ref = null;
          // VL4fix DRAFT(ai): 사용자가 누른 확인(verifying)은 가짜 결과로 connected 로 닫는다 (verify_detail.mock=true, clusters 비움).
          //   그대로 두면 시드 환경이 verifying 에 영영 남는다. 주기 훑기는 상태를 안 건드림
          // RV-24: 실측 판(REAL_STS 켬)에서 AWS·GCP 환경이 흉내 자격을 받았다 = 연결 링크를 안 거친 환경(확인 문구·고객 SA 없음).
          //   클라우드를 한 번도 안 읽고 connected 로 닫으면 화면·API·실측 PASS 가 거짓 → 실패로 닫는다 (시험·로컬 REAL_STS=0 은 예전처럼)
          const realMode = deps.realSts ?? realStsEnabled();
          if (reason === "user" && realMode && (env.provider === "aws" || env.provider === "gcp")) return withTenant(tenantId, async (tx) => {
            const failureReason = "PLATFORM_ERROR:MOCK_CREDENTIALS";
            await advanceConnection(tx, tenantId, envId, "failed", { from: ["verifying"], failureReason,
              audit: { actor: "worker", action: "env.verify_failed", detail: { reason: failureReason, mock: true, trigger: reason } } });
            return { status: "failed" as const, reason: failureReason };
          });
          if (reason === "user") return withTenant(tenantId, async (tx) => {
            await advanceConnection(tx, tenantId, envId, "connected", { from: ["verifying"], failures: 0, touchVerified: true,
              audit: { actor: "worker", action: "env.verified", detail: { mock: true, trigger: reason } } });
            await tx.query("UPDATE environments SET verify_detail = $2 WHERE id = $1",
              [envId, JSON.stringify({ clusters: [], mock: true, checkedAt: new Date().toISOString() })]);
            return { status: "connected" as const, skipped: "stub_credentials" };
          });
          return { status: cur, skipped: "stub_credentials" };
        }
      } catch (e) {
        const why = issueFailure(e);
        if (!why) throw e;
        result = { ok: false, reason: why };
        issueDenied = deniedDetail(e);
      }
      if (ref) {
        const m = roles.use(ref, tenantId);
        if (gcp) {
          if (m.kind !== "bearer") throw new Error("GCP 발급기가 bearer 자격이 아닌 것을 돌려줬다");
          // account_id = GCP 프로젝트 ID. 없으면 볼 곳이 없다 (checkAccountId 가 연결 때 이미 거른다)
          if (!env.account_id) result = { ok: false, reason: "ROLE_NOT_FOUND" };
          else result = await verifyGcpObserve(deps.cli ?? {}, { projectId: env.account_id, expectedProjectNumber: env.gcp_project_number,
            clusterName: env.cluster_name, token: m.token, probeOptional: reason === "user" });
        } else {
          if (m.kind !== "aws") throw new Error("AWS 발급기가 aws 자격이 아닌 것을 돌려줬다");
          if (!env.cluster_name) result = { ok: false, reason: "K8S_ACCESS_MISSING" };   // DRAFT(ai): 클러스터 이름이 없으면 쿠버네티스를 못 봄
          else result = await verifyAwsObserve(deps.cli ?? {}, { region, clusterName: env.cluster_name,
            cliEnv: { AWS_ACCESS_KEY_ID: m.accessKeyId, AWS_SECRET_ACCESS_KEY: m.secretAccessKey, AWS_SESSION_TOKEN: m.sessionToken, AWS_REGION: region } });
        }
      }
    } finally {
      if (ref) await roles.revoke(ref, tenantId, "verify_done");
    }
    // PF01 FM-CLD-06: 스택을 막 만든 직후엔 IAM 신뢰 정책·EKS 접근 항목이 아직 안 퍼져 AssumeRole AccessDenied·can-i no 가 잠깐 난다.
    //   사람이 누른 확인만 정해진 간격으로 다시 본다 (주기 확인은 다음 주기가 다시 봄)
    if (result.ok || !retryReasons.has(result.reason) || attempt >= delays.length) break;
    await sleepMs(delays[attempt]!);
  }
  } catch (e) {
    // PF01 FM-ENV-04: 플랫폼 쪽 자격 만료·명령 없음 같은 오류. 예전엔 재시도 3번 뒤 환경이 verifying 에 영영 남았다(/verify 는 failed 에서만 다시 됨)
    const why = platformFailure(e);
    if (reason !== "user" || (!why && !isLastAttempt())) throw e;
    const failureReason = why ?? "PLATFORM_ERROR";
    return withTenant(tenantId, async (tx) => {
      await advanceConnection(tx, tenantId, envId, "failed", { from: ["verifying"], failureReason,
        audit: { actor: "worker", action: "env.verify_failed", detail: { reason: failureReason, trigger: reason, error: maskAccount(e instanceof Error ? e.message : String(e)).slice(0, 300) } } });
      return { status: "failed" as const, reason: failureReason };
    });
  }

  const r = result!;
  return withTenant(tenantId, async (tx) => {
    // OBSROLE3: 연결은 성공했지만 관찰 역할에 선택 권한이 빠져 있으면(예전 스크립트로 만든 고객) 실패로 바꾸지 않고 사람이 할 일로 남긴다
    const missing = r.ok && r.missingPermissions?.length ? r.missingPermissions : null;
    const detail = r.ok ? (missing ? { missingPermissions: missing } : {}) : { reason: r.reason, ...issueDenied };
    const action = r.ok ? "env.verified" : "env.verify_failed";
    const audit = { actor: "worker", action, detail: { ...detail, trigger: reason } };
    if (reason === "user") {
      if (r.ok) {
        await advanceConnection(tx, tenantId, envId, "connected", { from: ["verifying"], failures: 0, touchVerified: true, audit });
        await tx.query("UPDATE environments SET verify_detail = $2 WHERE id = $1",
          [envId, JSON.stringify({ clusters: r.clusters, checkedAt: new Date().toISOString(), ...(missing ? { missingPermissions: missing, needsHuman: [needsHumanText(missing, env.provider === "aws" ? "aws" : "gcp")] } : {}) })]);
        // L7i: 첫 성공 때 GCP 프로젝트 번호 고정 (이미 있으면 그대로 — 위 확인이 같음을 보장)
        if (r.projectNumber) await tx.query("UPDATE environments SET gcp_project_number = COALESCE(gcp_project_number, $2) WHERE id = $1", [envId, r.projectNumber]);
        return { status: "connected" as const };
      }
      await advanceConnection(tx, tenantId, envId, "failed", { from: ["verifying"], failureReason: r.reason, audit });
      return { status: "failed" as const, reason: r.reason };
    }
    // 주기 재확인: verifying 으로 옮기지 않는다 (옮기면 guards 가 진행 중 이전을 막는다)
    const next = nextAfterPeriodic(cur, env.verify_failures, r.ok, !r.ok && r.reason === "ROLE_NOT_FOUND");
    await advanceConnection(tx, tenantId, envId, next.status, {
      from: [cur], failures: next.failures, ...(r.ok ? { touchVerified: true } : { failureReason: r.reason }), audit });
    // VOBSROLE3: 주기 재확인은 선택 권한을 찌르지 않으니 모른다 → 지난 사용자 확인이 남긴 빠진 권한·할 일은 그대로 둔다
    //   (예전엔 통째로 덮어써서 고객이 아무것도 안 고쳤는데 다음 주기 확인 뒤 알림이 사라졌다). 지우는 건 다음 사용자 확인만
    if (r.ok) await tx.query(
      `UPDATE environments SET verify_detail = $2::jsonb || jsonb_strip_nulls(jsonb_build_object(
         'missingPermissions', verify_detail->'missingPermissions', 'needsHuman', verify_detail->'needsHuman')) WHERE id = $1`,
      [envId, JSON.stringify({ clusters: r.clusters, checkedAt: new Date().toISOString() })]);
    return { status: next.status, ...(r.ok ? {} : { reason: r.reason }) };
  });
}

// DRAFT(ai): 하트비트가 이 초보다 오래되면 "안 보임" (API agent-reports.ts staleSec 와 같은 값·같은 기본 120초)
export const agentStaleSec = (env: NodeJS.ProcessEnv = process.env) => Math.max(1, Number(env.AGENT_STALE_SEC) || 120);
// 온프레 실패 사유 (ConnectionFailure 와 같은 칸 failureReason 에 들어감)
export const AGENT_HEARTBEAT_STALE = "AGENT_HEARTBEAT_STALE", AGENT_KEY_MISSING = "AGENT_KEY_MISSING";

async function verifyOnprem(tenantId: string, envId: string, cur: ConnectionStatus, failures: number, reason: "user" | "periodic"): Promise<VerifyOutcome> {
  return withTenant(tenantId, async (tx) => {
    const q = await tx.query<{ keys: number; fresh: boolean | null }>(
      `SELECT (SELECT count(*)::int FROM agent_keys WHERE env_id = $1 AND revoked_at IS NULL) AS keys,
              (SELECT max(r.received_at) >= now() - make_interval(secs => $2)
                 FROM agent_reports r JOIN agent_keys k ON k.id = r.key_id AND k.revoked_at IS NULL
                WHERE r.env_id = $1 AND r.kind = 'heartbeat') AS fresh`, [envId, agentStaleSec()]);
    const keys = q.rows[0]?.keys ?? 0, fresh = q.rows[0]?.fresh === true;
    const ok = keys > 0 && fresh;
    const why = keys === 0 ? AGENT_KEY_MISSING : AGENT_HEARTBEAT_STALE;
    const audit = { actor: "worker", action: ok ? "env.verified" : "env.verify_failed", detail: { ...(ok ? {} : { reason: why }), trigger: reason, agentKeys: keys } };
    if (reason === "user") {
      // 온프레는 사람 확인 요청(verify)이 계정 번호 검사에서 이미 막힌다. 그래도 verifying 에 있으면 하트비트로 닫는다
      if (cur !== "verifying") return { status: cur, skipped: "not_verifying" };
      if (ok) { await advanceConnection(tx, tenantId, envId, "connected", { from: ["verifying"], failures: 0, touchVerified: true, audit }); return { status: "connected" as const }; }
      await advanceConnection(tx, tenantId, envId, "failed", { from: ["verifying"], failureReason: why, audit });
      return { status: "failed" as const, reason: why };
    }
    if (cur !== "connected" && cur !== "unstable") return { status: cur, skipped: "not_connected" };
    // 키가 다 끊겼으면(폐기) 다시 붙을 길이 없다 → disconnected (AWS 역할 없음과 같은 자리). 하트비트만 늦으면 실패 횟수 세다 unstable
    const next = nextAfterPeriodic(cur, failures, ok, keys === 0);
    await advanceConnection(tx, tenantId, envId, next.status, {
      from: [cur], failures: next.failures, ...(ok ? { touchVerified: true } : { failureReason: why }), audit });
    return { status: next.status, ...(ok ? {} : { reason: why }) };
  });
}
