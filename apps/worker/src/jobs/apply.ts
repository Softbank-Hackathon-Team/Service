import { ApplyJob, QUEUES, type AppSpecV2, type PlanDoc, type Provider, type TfOutputs } from "@svc/contracts";
import { azureMockOutputsV2, chooseRunner, iacMockEnabled, specV2ForPlan, STUB_TF_OUTPUTS, stubTfOutputsV2 } from "@svc/adapters";
import { asFailureCode, latestAcceptedSpecV2, planExpired, type Tx } from "@svc/core";
import { errorMessage, nextJob, runStep, stubWait } from "./_step.js";
import { loadLatestApproval, loadLatestPlan, saveInfraReady } from "./plan-store.js";
import { failedOnRenewFailure, withStepRoles } from "./_roles.js";
import { realApply } from "./apply-real.js";
import { runImageBuilds } from "./image-build.js";

// TA3: spec = 받아들인 최신 판의 명세. 없거나 모양이 틀리면 null (→ TF_PLAN_DRIFT)
interface ApplyLoaded { plan: PlanDoc; provider: Provider; spec: AppSpecV2 | null; accountId: string | null }
// Z38-3: 재확인 실패. 예전엔 load 가 null → job.rejected 로 조용히 끝나고 이전은 provisioning 에 남았다.
//   잠금 기한(= 계획 만료, 최대 2시간) 뒤에야 청소가 failed(JOB_NOT_PICKED)로 보냈다 (원인이 사라진 사유)
interface ApplyRecheckFailed { recheckFailed: string }

// 도착 환경의 클라우드와 최신 명세. 실행기(Azure Mock·Terraform)가 번역 함수를 다시 부를 때 쓴다
async function loadTarget(tx: Tx, migrationId: string, targetEnvId: string) {
  const e = await tx.query(`SELECT provider, account_id FROM environments WHERE id=$1`, [targetEnvId]);
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
      } else if (!iacMockEnabled()) {
        // Z89: 기본 = 진짜 terraform (Z70 의 스위치 둘 대신 MOCK_IAC=1 이 아니면 항상). 잠금을 잃으면 ctx.signal → terraform 에 SIGINT
        // L5b: 진짜 발급기(REAL_STS=1 + external_id)로 빌린 AWS 실행 자격이 있으면 terraform 에 그것만 넘긴다 (맥 프로필 지움).
        //   STUB: 가짜 발급기·GCP·온프레는 지금처럼 프로세스 자격(AWS_PROFILE·gcloud 로그인)으로 돈다
        const r = await realApply({ migrationId: j.migrationId, tenantId: j.tenantId, envId: m.targetEnvId,
                                    provider, accountId, spec, plan },
                                  { signal: ctx.signal, ...(roles.awsEnv?.target ? { credEnv: roles.awsEnv.target } : {}) });
        if (!r.ok) return { to: "failed", failureCode: r.failureCode, detail: r.detail };
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
                  ...(mockDetail ? { runner: mockDetail } : {}), ...(realDetail ? { terraform: realDetail } : {}) },
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
    // 이제 provisioning → failed(APPLY_FAILED). failed는 다시 계획(T37)하거나 취소한다. 잠금은 advance 규칙대로 해제
    // 임시 자격 재발급 실패(Z61)도 failed 로, 실패 코드만 CRED_RENEW_FAILED (Z38 REVIEW-4 Z43-1: paused → 롤백은 만들다 만 자원을 안 지운 채 끝남)
    onError: async (e) => failedOnRenewFailure(e) ?? ({ to: "failed", failureCode: "APPLY_FAILED",
      detail: { error: ((e as Error)?.message ?? String(e)).slice(0, 500) } }),
  });
}
