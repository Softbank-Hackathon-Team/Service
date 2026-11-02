import { AppSpec, DeployResult, MigrationJob, QUEUES, type AppSpecV2, type InfraReady, type PlanDoc, type Provider } from "@svc/contracts";
import { asFailureCode, latestAcceptedSpec, latestAcceptedSpecV2 } from "@svc/core";
import { checkTerraformRuntime, factsFromEnv, iacMockEnabled, specV2ForPlan, terraformRuntimeOf, type RuntimeHealthDeps, type TerraformRuntime } from "@svc/adapters";
import { nextJob, runStep, stubWait, stubFailIfAsked, type StepOutcome } from "./_step.js";
import { loadInfraReady, loadPlanById } from "./plan-store.js";
import { configFromEnv, deployToGitops, GitopsError, GitopsRepo } from "../gitops/index.js";
import { argoWatcherFromEnv } from "../gitops/argo-watch.js";

// GitOps 배포. deploying → syncing
// GITOPS_REPO_DIR가 있으면 gitops 레포에 묶음을 커밋한다 (계약: parallel/N/gitops/WORKER-CONTRACT.md).
// 없으면 예전 STUB 길 (smoke·로컬 데모 유지)
interface Loaded {
  infra: InfraReady;
  plan: PlanDoc | null;
  spec: AppSpec | null;
  env: { provider: Provider; accountId: string | null } | null;
  specV2?: AppSpecV2 | null;   // TA3: 계획서 irVersion "2" 일 때만 (출처가 바뀌었으면 null → approvedValues 가 drift)
  runtime?: TerraformRuntime | null;   // DEPLOYNONK8S: 도착이 ECS·Cloud Run·VM 이면 그 실행 방식 (k8s 면 null·없음)
}

// DEPLOYNONK8S: 시험이 건강 조회(읽기 CLI·대기)를 가짜로 바꾼다
let runtimeHealthDeps: RuntimeHealthDeps = {};
export const setRuntimeHealthDeps = (d: RuntimeHealthDeps) => { runtimeHealthDeps = d; };

export async function handleDeploy(raw: unknown) {
  const job = MigrationJob.parse(raw);
  const cfg = configFromEnv();
  return runStep(job, {
    name: "deploy",
    expect: "deploying",
    // 도착 자원 준비됨(InfraReady)이 없으면 배포하지 않는다
    load: async (tx, j, m): Promise<Loaded | null> => {
      const infra = await loadInfraReady(tx, j.migrationId);
      if (!infra) return null;
      // DEPLOYNONK8S: v2 계획서면 도착 실행 방식을 먼저 본다. ECS·Cloud Run·VM 은 gitops 설정과 상관없이 Terraform 출력 + 건강 확인 길
      const nonK8s = await terraformRuntimeLoad(tx, infra, m);
      if (nonK8s) return nonK8s;
      if (!cfg) return { infra, plan: null, spec: null, env: null };
      const plan = await loadPlanById(tx, infra.planId);
      const spec = await latestAcceptedSpec(tx, m.id);
      const e = await tx.query(
        `SELECT provider, account_id AS "accountId" FROM environments WHERE id=$1`, [m.targetEnvId]);
      if (!plan || !spec || !e.rows[0]) return null;
      if (plan.irVersion === "2") {
        const row = await latestAcceptedSpecV2(tx, m.id);
        return { infra, plan, spec: AppSpec.parse(spec), env: e.rows[0], specV2: row ? specV2ForPlan(row, plan.specSource) : null };
      }
      return { infra, plan, spec: AppSpec.parse(spec), env: e.rows[0] };
    },
    work: async (j, m, l): Promise<StepOutcome> => {
      if (l.runtime && l.specV2 && l.env) return deployTerraformRuntime(j, l as Loaded & { runtime: TerraformRuntime; specV2: AppSpecV2; env: NonNullable<Loaded["env"]> });
      let result: DeployResult;
      let gitops: Record<string, unknown> | undefined;
      // Z77: 클러스터 없이 RDS 만 만든 이전(env 모듈 create_eks=false, 맥 B 회차)은 올릴 곳이 없다 → GitOps 가 켜져 있어도 STUB
      const noCluster = isNoCluster(l.infra.tfOutputs);
      // Z89: GitOps 설정이 없으면 예전엔 조용히 STUB 성공 → 이제 MOCK_ARGO=1(시험 전용)일 때만 흉내. 아니면 paused(GITOPS_NOT_CONFIGURED)
      //   paused → deploying 으로 다시 돌릴 수 있다 (GITOPS_REPO_DIR/URL 넣고 워커 재시작 → 재개). 클러스터 없이 만든 이전(noCluster)은 올릴 곳이 없어 그대로 건너뜀
      if (!cfg && !noCluster && process.env.MOCK_ARGO !== "1")
        return { to: "paused", failureCode: "GITOPS_NOT_CONFIGURED",
                 detail: { deploy: { error: "GITOPS_NOT_CONFIGURED", reason: "GITOPS_REPO_DIR/GITOPS_REPO_URL 없음 (GITOPS_DISABLE=1 포함). 시험이면 MOCK_ARGO=1" } } };
      if (!cfg || noCluster) {
        // STUB: GITOPS_REPO_DIR 없음 → 커밋 없이 정상으로 본다
        await stubWait();
        await stubFailIfAsked(j, "deploy");          // Z36 데모: STUB_FAIL_STEP=deploy → 재시도 소진 → paused → 재개
        result = DeployResult.parse({
          bundleHash: "stub-" + j.migrationId.slice(0, 8),
          status: "synced_healthy",
          resources: noCluster ? [] : ["Deployment/app/web", "Deployment/app/api", "Service/app/web"],
        });
        gitops = noCluster ? { skipped: "no_cluster" } : { mock: true };   // Z89: 흉내였다는 사실을 감사 detail 에 남긴다
      } else {
        try {
          const out = await deployToGitops(new GitopsRepo(cfg), {
            tenantId: j.tenantId, spec: l.spec!, plan: l.plan!, tfOutputs: l.infra.tfOutputs,
            ...(l.plan!.irVersion === "2" ? { specV2: l.specV2 ?? null } : {}),
            // 계획 처리기와 같은 target이어야 Helm 값 지문이 같다 (region "default")
            target: { envId: m.targetEnvId, provider: l.env!.provider, region: "default", accountId: l.env!.accountId },
          }, argoWatcherFromEnv());
          result = DeployResult.parse(out.result);
          gitops = { commit: out.commit, argoApp: out.app, ...(out.argo ? { argo: out.argo } : {}) };
        } catch (e) {
          // DRAFT(ai): 커밋 전 실패(값 지문 다름, 자리표시 남음, 검증 실패, push 실패)는 paused로 멈춘다.
          // paused → deploying 으로 다시 돌릴 수 있고, 고객 클러스터에는 아무것도 안 들어갔다
          const code = e instanceof GitopsError ? e.code : "GITOPS_ERROR";
          return { to: "paused", failureCode: asFailureCode(code), detail: { deploy: { error: code, reason: (e as Error).message } } };
        }
      }
      if (result.status === "failed") {
        // DRAFT(ai) Z59 (TODO(human) "Degraded·SyncFailed → paused 냐 rolling_back 이냐" 기본값): paused.
        // 트래픽 0%·컷오버 전이라 출발이 그대로 주인 → 급할 것 없음. 사람이 고쳐 paused → deploying 으로 재개하거나 롤백을 고른다.
        // 실패 이유 앞머리(ARGO_DEGRADED / ARGO_SYNC_FAILED / ARGO_TIMEOUT)를 failureCode 로
        const code = /^(ARGO_[A-Z_]+)/.exec(result.reason ?? "")?.[1] ?? "ARGO_SYNC_FAILED";
        return { to: "paused", failureCode: code, detail: { deploy: result, ...(gitops ? { gitops } : {}) } };
      }
      return {
        to: "syncing", detail: { deploy: result, ...(gitops ? { gitops } : {}) },
        // Z94: argoHealthy = 반영 확인 결과 (argocd-push 는 Synced+Healthy, 온프레는 Agent applied). 여기 오면 failed 는 위에서 걸렀다
        // STUB: 보안 동등성(MG-2-07)은 보안 영역 가드레일이 붙으면 그 결과를 넣는다
        evidence: { argoHealthy: result.status === "synced_healthy" || result.status === "applied", securityParity: true },
        next: nextJob(QUEUES.sync, j),
      };
    },
  });
}

/** Z77: apply 출력의 cluster_name 이 빈 문자열이면 "클러스터 없이 만든 이전". 키가 없으면(STUB·Mock) 아니다 */
export function isNoCluster(tfOutputs: Record<string, string> | undefined | null): boolean {
  return !!tfOutputs && Object.prototype.hasOwnProperty.call(tfOutputs, "cluster_name") && tfOutputs.cluster_name === "";
}

type Tx = Parameters<Parameters<typeof runStep>[1]["load"] & {}>[0];

/** DEPLOYNONK8S: v2 계획서 + 승인 명세가 ECS·Cloud Run·VM 이면 그 Loaded, 아니면 null (k8s·v1 은 지금 길 그대로) */
async function terraformRuntimeLoad(tx: Tx, infra: InfraReady, m: { id: string; targetEnvId: string }): Promise<Loaded | null> {
  const plan = await loadPlanById(tx, infra.planId);
  if (plan?.irVersion !== "2") return null;
  const row = await latestAcceptedSpecV2(tx, m.id);
  const specV2 = row ? specV2ForPlan(row, plan.specSource) : null;
  const runtime = terraformRuntimeOf(specV2);
  if (!runtime) return null;
  const e = await tx.query(`SELECT provider, account_id AS "accountId" FROM environments WHERE id=$1`, [m.targetEnvId]);
  if (!e.rows[0]) return null;
  return { infra, plan, spec: null, env: e.rows[0], specV2, runtime };
}

/** DEPLOYNONK8S: Terraform 이 앱까지 띄운 도착 → gitops·Argo 건너뜀, apply 출력 + 건강 확인으로 DeployResult.
 *  흉내 길(MOCK_IAC=1)은 출력만 본다. 진짜 길은 읽기 CLI (프로세스·실행 역할 env 의 자격, 코드엔 없음).
 *  못 뜨면 paused (paused → deploying 재개 가능, 트래픽 0%·컷오버 전이라 출발이 그대로 주인) */
async function deployTerraformRuntime(j: MigrationJob, l: Loaded & { runtime: TerraformRuntime; specV2: AppSpecV2; env: NonNullable<Loaded["env"]> }): Promise<StepOutcome> {
  await stubFailIfAsked(j, "deploy");
  const gitops = { skipped: "terraform_runtime", runtime: l.runtime };
  const facts = factsFromEnv(process.env);
  const h = await checkTerraformRuntime({
    provider: l.env.provider, runtime: l.runtime, spec: l.specV2, tfOutputs: l.infra.tfOutputs ?? {},
    live: !iacMockEnabled(), projectId: facts.projectId ?? null,   // region = 계획과 같은 "default" 규칙 (checkTerraformRuntime)
  }, runtimeHealthDeps);
  if (!h.ok)
    return { to: "paused", failureCode: h.code, detail: { deploy: { error: h.code, reason: h.reason, resources: h.resources, attempts: h.attempts }, gitops } };
  const result = DeployResult.parse({ bundleHash: `tf-${l.infra.planId.slice(0, 8)}`, status: "synced_healthy", resources: h.resources });
  return {
    to: "syncing", detail: { deploy: result, gitops: { ...gitops, checked: h.checked, attempts: h.attempts } },
    // DRAFT(ai): argoHealthy 칸 = "배포 반영 확인됨". 이 도착은 Argo 대신 Terraform 출력·건강 확인이 그 근거 (감사 detail.gitops.skipped 로 구별)
    evidence: { argoHealthy: true, securityParity: true },
    next: nextJob(QUEUES.sync, j),
  };
}
