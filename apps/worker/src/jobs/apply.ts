import { ApplyJob, QUEUES, redactText, type AppSpecV2, type PlanDoc, type Provider, type TfOutputs } from "@svc/contracts";
import { azureMockOutputsV2, chooseRunner, iacMockEnabled, onpremGitFloorOutputs, specV2ForPlan, STUB_TF_OUTPUTS, stubTfOutputsV2 } from "@svc/adapters";
import { asFailureCode, latestAcceptedSpecV2, planExpired, replicationEndpointsFor, withTenant, type Tx } from "@svc/core";
import { errorMessage, nextJob, runStep, stubWait } from "./_step.js";
import { loadLatestApproval, loadLatestPlan, saveInfraReady } from "./plan-store.js";
import { failedOnRenewFailure, failedOnRoleDenied, withStepRoles } from "./_roles.js";
import { realApplyWithEnvLayer, type RealApplyOutcome } from "./apply-real.js";
import { borrowEnvCred } from "../env-layer.js";
import { withGcpCred } from "../gcp-token-server.js";
import { runImageBuilds } from "./image-build.js";
import { TARGET_ACCOUNT_SQL } from "./target-account.js";
import { addRelayPeer, cloudSqlPeerOf, ensureTargetAppLogin, gcpEndpointRows, prepareGcpRelayStep, provisionGcpRelayStep, provisionRelayStep, saveEndpointRows,
  type GcpRelayGate } from "../relay/relay-step.js";
import { RelayError } from "../relay/aws-relay.js";
import { prepareGcpAwsRelayStep, provisionGcpAwsRelayStep } from "../relay/gcp-aws.js";
import type { MigrationRow } from "./_step.js";

// TA3: spec = 받아들인 최신 판의 명세. 없거나 모양이 틀리면 null (→ TF_PLAN_DRIFT)
interface ApplyLoaded { plan: PlanDoc; provider: Provider; spec: AppSpecV2 | null; accountId: string | null }
// Z38-3: 재확인 실패. 예전엔 load 가 null → job.rejected 로 조용히 끝나고 이전은 provisioning 에 남았다.
//   잠금 기한(= 계획 만료, 최대 2시간) 뒤에야 청소가 failed(JOB_NOT_PICKED)로 보냈다 (원인이 사라진 사유)
interface ApplyRecheckFailed { recheckFailed: string }

// 도착 환경의 클라우드와 최신 명세. 실행기(Azure Mock·Terraform)가 번역 함수를 다시 부를 때 쓴다
async function loadTarget(tx: Tx, migrationId: string, targetEnvId: string) {
  // 결정 3번 A안: GCP 도착 자원은 이전 전용 프로젝트에 만든다 → 도착 쪽 "계정" = gcp_target_project (비면 예전처럼 account_id)
  const e = await tx.query(`SELECT provider, ${TARGET_ACCOUNT_SQL} AS account_id FROM environments WHERE id=$1`, [targetEnvId]);
  const row = await latestAcceptedSpecV2(tx, migrationId);
  return { provider: e.rows[0]?.provider as Provider | undefined, accountId: (e.rows[0]?.account_id as string | null) ?? null,
           spec: row ? specV2ForPlan(row) : null };
}

// 자원 생성 (Terraform apply). provisioning → deploying
// 실행 직전 재확인 (설계 5.2 apply 행 6개 중 지금 볼 수 있는 3개)
export async function handleApply(raw: unknown) {
  const job = ApplyJob.parse(raw);
  return runStep(job, {
    name: "apply",
    expect: "provisioning",
    load: async (tx, j, m): Promise<ApplyLoaded | ApplyRecheckFailed> => {
      const plan = await loadLatestPlan(tx, j.migrationId);
      const appr = await loadLatestApproval(tx, j.migrationId);
      // ② 승인한 지문 == 계획서 지문 == 작업에 실린 지문
      if (!plan || !appr || plan.planId !== j.planId
        || appr.planHash !== plan.planHash || plan.planHash !== j.planHash) return { recheckFailed: "PLAN_HASH_MISMATCH" };
      // ③ 승인 만료 전
      if ((await planExpired(tx, plan.planId)) !== false) return { recheckFailed: "PLAN_EXPIRED" };   // L7: DB 시계로 (전이 조건과 같은 기준)
      // ⑤ env_lock 인수는 runStep이 한다 (provisioning = LOCKED_STAGES, P-3)
      // TODO(human): ④ tfplan 파일 sha256 대조 ⑥ GetCallerIdentity == 고객 계정 — 실제 Terraform이 들어오면 추가
      const { provider, spec, accountId } = await loadTarget(tx, j.migrationId, m.targetEnvId);
      if (!provider) return { recheckFailed: "TARGET_ENV_MISSING" };
      return { plan, provider, spec, accountId };
    },
    work: async (j, m, loaded, ctx) => "recheckFailed" in (loaded as object)
      // Z38-3: 재확인 실패는 바로 failed (provisioning → failed 는 다시 계획 가능, 잠금 해제). 역할을 빌리기 전에 끝낸다
      ? { to: "failed" as const, failureCode: "APPLY_RECHECK_FAILED",
          detail: { planId: j.planId, recheck: (loaded as ApplyRecheckFailed).recheckFailed } }
      : withStepRoles("apply", j, m, async (roles) => {
      const { provider, spec, plan, accountId } = loaded as ApplyLoaded;
      // TA3: 승인한 명세가 지금 판에 없음(없거나 모양이 틀림) → 추측하지 않고 drift 로 멈춤 (세 길 공통)
      if (!spec)
        return { to: "failed", failureCode: "TF_PLAN_DRIFT", detail: { planId: j.planId, provider,
          error: "승인한 명세가 지금 판에 없다" } };
      let tfOutputs: TfOutputs;
      let mockDetail: Record<string, unknown> | undefined;
      let realDetail: Record<string, unknown> | undefined;
      let relayDetail: Record<string, unknown> | undefined;

      // 이미지 빌드 (23번 3.3): 서비스 중 image.source=build 가 있을 때만. IMAGE_BUILD=1 이 아니면 아무 일도 안 한다.
      //   실패하면 던져서 onError 가 failed 로 보낸다
      const imageBuilds = await runImageBuilds(j, spec);

      // 실행기 고르기·STUB 판단은 adapters chooseRunner 한 곳 (Z44). 막힘이면 바로 failed(failureCode = 실행기 코드)
      const c = chooseRunner(provider);
      if (c.kind === "unavailable")
        return { to: "failed", failureCode: asFailureCode(c.error.code), detail: { planId: j.planId, provider, error: c.error.message } };
      const runner = c.kind === "runner" ? c.runner : null;

      if (runner) {
        // Azure Mock: 클라우드 호출 없이 "apply 했다면 나왔을" 출력·자원 목록을 받는다.
        // 대상은 계획 단계(plan.ts)와 같은 모양(G8-1 migrationId 포함) → 자원 이름이 계획서와 같다
        const r = await runner.apply(spec, { envId: m.targetEnvId, provider, region: "default", migrationId: j.migrationId });
        mockDetail = { mock: runner.mock, provider, elapsedMs: r.elapsedMs,
                       resources: r.resources.map((x) => ({ type: x.type, name: x.name, state: x.state })), log: r.log };
        if (!r.ok) return { to: "failed", failureCode: "AZURE_MOCK_APPLY_FAILED", detail: { planId: j.planId, ...mockDetail } };
        // TA3: 값이 찾는 link.<id>.* 키 (TA10 azureMockOutputsV2 = 같은 규칙의 결정적 값). 실행기가 준 출력이 이긴다
        tfOutputs = { ...azureMockOutputsV2(spec, { envId: m.targetEnvId, provider, region: "default", migrationId: j.migrationId } as never), ...r.tfOutputs };
      } else if (provider === "onprem" && process.env.ONPREM_FLOOR_VIA_GIT !== "0") {
        // W3: 온프레 바닥(네임스페이스·할당량)은 git 으로 간다 (고객 Argo CD 가 CreateNamespace + 차트 floor.yaml 로 만든다).
        //   워커는 온프레 클러스터에 들어가지 않는다 (kube_context 로 도는 Terraform 을 건너뜀). 출력은 onprem/root 모듈과 같은 모양
        //   DRAFT(ai): 기본 켬 (2026-11-04 온프레 영역 결정). ONPREM_FLOOR_VIA_GIT=0 이면 예전처럼 Terraform (고객 Argo CD 가 없는 로컬 k3d 시연 등)
        tfOutputs = { ...onpremGitFloorOutputs(spec) };
        realDetail = { iac: "git", note: "ONPREM_FLOOR_VIA_GIT 켬(기본): 온프레 바닥은 gitops 묶음(floor.yaml)과 고객 Argo CD 가 만든다" };
        // 출발 AWS 계정에 DB 복제 중계기를 만들고 복제 끝점 두 줄을 채운다 (출발 실행 역할, 중계기 세션 정책).
        //   출발이 AWS 아님·시드 환경·명세에 postgres 없음이면 건너뛴다 (예전처럼 사람이 tools/onprem-relay.sh). 실패면 failed (다시 계획하면 태그로 이어 간다)
        const relay = await provisionRelayStep(j, m);
        if (relay.kind === "failed")
          return { to: "failed", failureCode: asFailureCode(relay.failureCode),
                   detail: { planId: j.planId, provider, error: relay.reason, ...(relay.detail ? { relay: relay.detail } : {}) } };
        relayDetail = relay.kind === "ok" ? relay.detail : { skipped: relay.reason };
      } else if (!iacMockEnabled()) {
        // Z89: 기본 = 진짜 terraform (Z70 의 스위치 둘 대신 MOCK_IAC=1 이 아니면 항상). 잠금을 잃으면 ctx.signal → terraform 에 SIGINT
        // L5b: 진짜 발급기(REAL_STS=1 + external_id)로 빌린 AWS 실행 자격이 있으면 terraform 에 그것만 넘긴다 (맥 프로필 지움).
        //   빌린 GCP 토큰도 같다 (withGcpCred). STUB: 가짜 발급기·온프레는 지금처럼 프로세스 자격(AWS_PROFILE·gcloud 로그인)으로 돈다
        //   4 기반 생성: 앱 층 apply 앞에서 환경 층(도착 GCP 의 VPC·GKE·AR·ESO)을 확보한다 (ENV_LAYER_AUTO=1 일 때만 만듦, 꺼져 있으면 예전과 같음)
        //   B-2: 환경 층은 svc-operate 가 아니라 그 단계에서만 빌리는 고객 svc-env 로 만든다 (borrowEnvCred)
        const tfApply = () => withGcpCred(roles, accountId, (gcpCred) => realApplyWithEnvLayer({ migrationId: j.migrationId, tenantId: j.tenantId, envId: m.targetEnvId,
                                    provider, accountId, spec, plan },
                                  { signal: ctx.signal, ...(roles.awsEnv?.target ? { credEnv: roles.awsEnv.target } : {}), ...(gcpCred ? { gcpCred } : {}),
                                    envLayer: { withEnvCred: borrowEnvCred(j, m, accountId) } }));
        // AWS → GCP 중계기 (relay-step): ① 도착 DB 공개 길(플랫폼 나가는 대역)을 작업 폴더에 ② terraform ③ Cloud SQL 주소로 중계기
        //   ④ 중계 공개 IP 가 새로 생겼으면 terraform 한 번 더 (Cloud SQL 허용 주소) ⑤ 끝점 두 줄·도착 앱 로그인 역할. 단계마다 다시 돌아도 같은 끝
        const gate = provider === "gcp" ? await prepareGcpRelayStep(j, m) : null;
        if (gate?.kind === "fail")
          return { to: "failed", failureCode: asFailureCode(gate.failureCode), detail: { planId: j.planId, provider, error: gate.reason } };
        // GCP → AWS 중계기 (relay/gcp-aws.ts): ① 문 + 출발 Cloud SQL 읽기 (도착 RDS 를 만들기 전에 멈춤) ② terraform ③ 도착 계정에 중계기·RDS 규칙·끝점 두 줄.
        //   짝이 gcp->aws 가 아니면 null (예전 그대로)
        const gaGate = provider === "aws" ? await prepareGcpAwsRelayStep(j, m) : null;
        if (gaGate?.kind === "fail")
          return { to: "failed", failureCode: asFailureCode(gaGate.failureCode), detail: { planId: j.planId, provider, error: gaGate.reason,
            relay: { ...(gaGate.missing ? { missing: gaGate.missing } : {}), ...(gaGate.hint ? { hint: gaGate.hint } : {}) } } };
        let r = await tfApply();
        if (!r.ok) return { to: "failed", failureCode: asFailureCode(r.failureCode), detail: r.detail };
        if (gate?.kind === "go") {
          const g = await gcpRelayAfterTerraform(j, m, gate, r.tfOutputs, tfApply);
          if (!g.ok) return { to: "failed", failureCode: asFailureCode(g.failureCode), detail: { planId: j.planId, provider, ...g.detail } };
          if (g.rerun) r = g.rerun;
          relayDetail = g.detail;
        } else if (gate) relayDetail = { skipped: gate.reason };
        if (gaGate?.kind === "go") {
          const ga = await provisionGcpAwsRelayStep(j, m, gaGate, r.tfOutputs);
          if (ga.kind === "failed")
            return { to: "failed", failureCode: asFailureCode(ga.failureCode), detail: { planId: j.planId, provider, error: ga.reason, ...(ga.detail ? { relay: ga.detail } : {}) } };
          relayDetail = ga.kind === "ok" ? ga.detail : { skipped: ga.reason };
        } else if (gaGate) relayDetail = { skipped: gaGate.reason };
        tfOutputs = r.tfOutputs;
        realDetail = r.detail;
      } else {
        // 흉내 (MOCK_IAC=1, 시험 전용: test:db·e2e·prod-e2e). 진짜 자원 없음 → 감사 detail 에 iac:"mock" 으로 남긴다
        await stubWait();
        // 시험·데모용: apply 실패를 흉내 낸다 (APPLY_STUB_FAIL=1)
        if (process.env.APPLY_STUB_FAIL === "1") throw new Error("STUB: terraform apply exit 1 (APPLY_STUB_FAIL=1)");
        // STUB: 모든 프로바이더 몫 가짜 출력 (표는 adapters runners.ts STUB_TF_OUTPUTS, 값은 예전과 같음)
        tfOutputs = { ...STUB_TF_OUTPUTS, ...stubTfOutputsV2(spec) };   // TA3: 값 자리표시용 가짜 link.<id>.*
      }
      return {
        to: "deploying",
        // SECAUDIT: 감사엔 출력 이름만 (값 = DB 주소·ARN 은 infra_ready 표)
        detail: { planId: j.planId, outputs: Object.keys(tfOutputs).sort(), ...(imageBuilds.length ? { imageBuilds } : {}), iac: mockDetail ? "azure_mock" : realDetail ? (realDetail.imported ? "imported" : "terraform") : "mock",
                  ...(mockDetail ? { runner: mockDetail } : {}), ...(realDetail ? { terraform: realDetail } : {}), ...(relayDetail ? { relay: relayDetail } : {}) },
        evidence: { applyOk: true },   // STUB(aws/gcp/onprem): terraform apply 종료 코드 0. Azure는 Mock 결과 ok
        inTx: (tx) => saveInfraReady(tx, {
          tenantId: j.tenantId, migrationId: j.migrationId, planId: j.planId, tfOutputs,
          // STUB: Helm 값 저장 위치. 진짜로는 객체 저장소 경로
          helmValuesKey: `plans/${j.planId}/values.json`,
        }),
        next: nextJob(QUEUES.deploy, j),
      };
    }),
    // apply 큐는 retryLimit 0. 예전엔 예외 한 번에 provisioning에 멈추고 잠금이 계획 만료까지 남았다.
    // 이제 provisioning → failed(APPLY_FAILED). failed는 사람에게 재시도·거절(롤백)을 묻는다 (POST .../failure-decision). 잠금은 advance 규칙대로 해제
    // 임시 자격 재발급 실패(Z61)도 failed 로, 실패 코드만 CRED_RENEW_FAILED (Z38 REVIEW-4 Z43-1: paused → 롤백은 만들다 만 자원을 안 지운 채 끝남)
    // 실환경에서 고객 임시 역할을 못 빌림(_roles.ts) → TEMP_ROLE_DENIED. terraform 을 시작하기 전이다
    onError: async (e) => failedOnRenewFailure(e) ?? failedOnRoleDenied(e) ?? ({ to: "failed", failureCode: "APPLY_FAILED",
      detail: { error: redactText((e as Error)?.message ?? String(e)).slice(0, 500) } }),   // RV-16
  });
}

/** ③~⑤ (AWS → GCP 중계기). 실패는 failed (만든 중계기 자원은 태그를 단 채 남고 다시 계획하면 태그로 이어 간다, 취소하면 repl-cleanup 이 지운다) */
async function gcpRelayAfterTerraform(j: { tenantId: string; migrationId: string }, m: MigrationRow, g: Extract<GcpRelayGate, { kind: "go" }>, out: TfOutputs,
  rerun: () => Promise<RealApplyOutcome>): Promise<{ ok: true; detail: Record<string, unknown>; rerun?: Extract<RealApplyOutcome, { ok: true }> } | { ok: false; failureCode: string; detail: Record<string, unknown> }> {
  const cloudSql = cloudSqlPeerOf(out);
  if (!cloudSql) return { ok: false, failureCode: "RELAY_TARGET_DB_UNKNOWN",
    detail: { error: "terraform 출력에 Cloud SQL 공개·나가는 IP(db_public_ip·db_outgoing_ip)가 없다: 도착 DB 공개 길이 안 켜졌다 (repl-network.json·조직 정책 sql.restrictPublicIp 확인)" } };
  const relay = await provisionGcpRelayStep(j, m, g, cloudSql);
  if (relay.kind === "failed") return { ok: false, failureCode: relay.failureCode, detail: { error: relay.reason, ...(relay.detail ? { relay: relay.detail } : {}) } };
  let again: Extract<RealApplyOutcome, { ok: true }> | undefined;
  if (addRelayPeer(j, relay.res.publicIp)) {
    const r2 = await rerun();
    if (!r2.ok) return { ok: false, failureCode: r2.failureCode, detail: { ...r2.detail, relayPublicIp: relay.res.publicIp, step: "authorize_relay_on_cloudsql" } };
    again = r2;
  }
  const existing = await withTenant(j.tenantId, (tx) => replicationEndpointsFor(tx, j.migrationId));
  let rows: ReturnType<typeof gcpEndpointRows>;
  try {
    rows = gcpEndpointRows({ tenantId: j.tenantId, migrationId: j.migrationId, sourceEnvId: m.sourceEnvId, rds: relay.rds, db: g.db, appUser: g.user,
      publicIp: relay.res.publicIp, privateIp: relay.res.privateIp, cloudSql, out: again?.tfOutputs ?? out, existing });
  } catch (e) { if (e instanceof RelayError) return { ok: false, failureCode: e.code, detail: { error: e.message } }; throw e; }
  await saveEndpointRows(j.tenantId, rows);
  let appLogin: Awaited<ReturnType<typeof ensureTargetAppLogin>>;
  try { appLogin = await ensureTargetAppLogin(rows[1]); }
  catch (e) {
    return { ok: false, failureCode: "TARGET_APP_LOGIN_FAILED", detail: { error: redactText((e as Error)?.message ?? String(e)).slice(0, 300),
      hint: "워커 → Cloud SQL 공개 IP:5432 (허용 주소 = PLATFORM_EGRESS_CIDRS)·관리자 비밀(db-secret.json db_admin_password) 확인" } };
  }
  // 감사 detail: 번호·주소만 (비밀번호 없음)
  return { ok: true, ...(again ? { rerun: again } : {}), detail: { kind: "aws-gcp", instanceId: relay.res.instanceId, securityGroupId: relay.res.securityGroupId,
    publicIp: relay.res.publicIp, privateIp: relay.res.privateIp, subnetId: relay.subnetId, rdsIdentifier: relay.rds.identifier,
    dbIngressRuleId: relay.res.dbIngressRuleId, dbEgressRuleId: relay.res.dbEgressRuleId, created: relay.res.created, reused: relay.res.reused,
    cloudSql: { publicIp: cloudSql.publicIp, outgoingIp: cloudSql.outgoingIp }, cloudSqlAuthorizedRelay: true, terraformReapplied: !!again,
    appLogin, targetTls: rows[1].sslmode, endpointRows: ["source", "target"] } };
}
