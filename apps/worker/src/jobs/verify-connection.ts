import { nextAfterPeriodic, VerifyConnectionJob, type ConnectionStatus } from "@svc/contracts";
import { advanceConnection, withTenant } from "@svc/core";
import { verifyAwsObserve, verifyGcpObserve, type CliDeps } from "@svc/adapters";
import { GcpIssueError, StsCliError, TempRoleDenied, type TempRoleBroker } from "@svc/security";
import { tempRoles } from "../platform.js";

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

export interface VerifyDeps { roles?: TempRoleBroker; cli?: CliDeps }
export interface VerifyOutcome { status: ConnectionStatus; reason?: string; skipped?: string }

interface EnvRow {
  provider: string; account_id: string | null; external_id: string | null; region: string | null; cluster_name: string | null;
  connection_status: ConnectionStatus; verify_failures: number; gcp_project_number: string | null;
}

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
export const needsHumanText = (missing: string[]) =>
  `관찰 역할에 읽기 권한 ${missing.length}개가 없음(${missing.slice(0, 6).join(", ")}${missing.length > 6 ? " 외" : ""}). 고객 Cloud Shell 에서 연결 스크립트(gcp-connect.sh)를 다시 실행하면 역할에 빠진 권한만 더해짐. 그 전에는 해당 자원을 가져오지 못하고 가져오기 notes 에 남음`;

export async function handleVerifyConnection(data: unknown, deps: VerifyDeps = {}): Promise<VerifyOutcome> {
  const job = VerifyConnectionJob.parse(data);
  const { tenantId, envId, reason } = job;
  const env = await withTenant(tenantId, async (tx) => (await tx.query<EnvRow>(
    `SELECT provider, account_id, external_id, region, cluster_name, connection_status, verify_failures, gcp_project_number
       FROM environments WHERE id = $1`, [envId])).rows[0]);
  // 남의 회사·지워진 환경: RLS 로 0줄 → 아무것도 안 바꾸고 끝 (다시 해도 같다)
  if (!env) return { status: "disconnected", skipped: "env_not_found" };
  const cur = env.connection_status;
  // STUB: 온프레(L6) 연결 확인. 지금은 상태 그대로 두고 끝 (실패 처리 아님). GCP 는 L7i
  if (env.provider !== "aws" && env.provider !== "gcp") return { status: cur, skipped: "provider_not_supported" };
  if (reason === "user" && cur !== "verifying") return { status: cur, skipped: "not_verifying" };
  if (reason === "periodic" && cur !== "connected" && cur !== "unstable") return { status: cur, skipped: "not_connected" };

  const roles = deps.roles ?? tempRoles();
  // DRAFT(ai): 환경에 리전이 없으면 서울 (issuers.ts AWS_DEFAULT_REGION 과 같음)
  const region = env.region || "ap-northeast-2";
  let result: { ok: true; clusters: string[]; projectNumber?: string; missingPermissions?: string[] } | { ok: false; reason: string };
  let ref: string | null = null;
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

  const r = result!;
  return withTenant(tenantId, async (tx) => {
    // OBSROLE3: 연결은 성공했지만 관찰 역할에 선택 권한이 빠져 있으면(예전 스크립트로 만든 고객) 실패로 바꾸지 않고 사람이 할 일로 남긴다
    const missing = r.ok && r.missingPermissions?.length ? r.missingPermissions : null;
    const detail = r.ok ? (missing ? { missingPermissions: missing } : {}) : { reason: r.reason };
    const action = r.ok ? "env.verified" : "env.verify_failed";
    const audit = { actor: "worker", action, detail: { ...detail, trigger: reason } };
    if (reason === "user") {
      if (r.ok) {
        await advanceConnection(tx, tenantId, envId, "connected", { from: ["verifying"], failures: 0, touchVerified: true, audit });
        await tx.query("UPDATE environments SET verify_detail = $2 WHERE id = $1",
          [envId, JSON.stringify({ clusters: r.clusters, checkedAt: new Date().toISOString(), ...(missing ? { missingPermissions: missing, needsHuman: [needsHumanText(missing)] } : {}) })]);
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
