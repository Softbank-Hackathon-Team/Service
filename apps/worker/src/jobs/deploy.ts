import { DeployResult, MigrationJob, QUEUES, type AppSpecV2, type InfraReady, type PlanDoc, type Provider, type RehearsalEvidence, type ReplicationEndpoint, type ReplicationSealedMaterial } from "@svc/contracts";
import { asFailureCode, latestAcceptedSpecV2, recordReplicationDelivery, replicationEndpointsFor, replicationSealedMaterialFor, scrubString, withTenant } from "@svc/core";
import { checkTerraformRuntime, envFor, factsFromEnv, gcpEnvFor, iacMockEnabled, specV2ForPlan, terraformRuntimeOf, type RuntimeHealthDeps, type TerraformRuntime } from "@svc/adapters";
import { nextJob, runStep, stubWait, stubFailIfAsked, type MigrationRow, type StepOutcome } from "./_step.js";
import { withStepRoles, type StepRoles } from "./_roles.js";
import { loadInfraReady, loadPlanById } from "./plan-store.js";
import { approvedValues, configFromEnv, decideDelivery, deployToGitops, envFacts, filledValues, fillPlaceholders, GitopsError, GitopsRepo, type DeployInput } from "../gitops/index.js";
import { latestSealingCert } from "../gitops/sealing-cert.js";
import { checkSecretValues } from "../gitops/secret-values.js";
import { realStsEnabled } from "../platform.js";
import { syncWatcherFor } from "../gitops/agent-watch.js";
import { TARGET_ACCOUNT_SQL } from "./target-account.js";
import { recordSkip, rehearsalGate, type Gate } from "../rehearsal/gate.js";
import { imageCopyStep } from "./image-copy.js";

// GitOps 배포. deploying → syncing
// GITOPS_REPO_DIR가 있으면 gitops 레포에 묶음을 커밋한다 (계약: parallel/N/gitops/WORKER-CONTRACT.md).
// 없으면 예전 STUB 길 (smoke·로컬 데모 유지)
interface Loaded {
  infra: InfraReady;
  plan: PlanDoc | null;
  spec: AppSpecV2 | null;      // TA3: 받아들인 최신 판 (없거나 모양이 틀리면 null → approvedValues 가 drift)
  env: { provider: Provider; accountId: string | null; awsRoleSuffix?: string | null } | null;
  runtime?: TerraformRuntime | null;   // DEPLOYNONK8S: 도착이 ECS·Cloud Run·VM 이면 그 실행 방식 (k8s 면 null·없음)
  epoch: number;               // 리허설 차례 = deploying 에 들어올 때의 migrations.version (재개하면 새 차례)
  repl?: ReplFacts;            // 온프레 도착만: CNPG 이전 배달물을 만들 사실 (끝점 줄·저장된 봉인 값·봉인 인증서)
}
interface ReplFacts { records: ReplicationEndpoint[]; stored: ReplicationSealedMaterial | null; sealingCertPem: string | null }

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
      const epoch = (await tx.query(`SELECT version FROM migrations WHERE id=$1`, [m.id])).rows[0]?.version as number;
      // DEPLOYNONK8S: 도착 실행 방식을 먼저 본다. ECS·Cloud Run·VM 은 gitops 설정과 상관없이 Terraform 출력 + 건강 확인 길
      const nonK8s = await terraformRuntimeLoad(tx, infra, m);
      if (nonK8s) return { ...nonK8s, epoch };
      if (!cfg) return { infra, plan: null, spec: null, env: null, epoch };
      const plan = await loadPlanById(tx, infra.planId);
      const row = await latestAcceptedSpecV2(tx, m.id);
      const e = await tx.query(
        `SELECT provider, ${TARGET_ACCOUNT_SQL} AS "accountId", aws_role_suffix AS "awsRoleSuffix" FROM environments WHERE id=$1`, [m.targetEnvId]);   // A안: GCP = 전용 프로젝트
      if (!plan || !row || !e.rows[0]) return null;
      const repl = e.rows[0].provider === "onprem" ? await loadReplFacts(tx, j.tenantId, m) : undefined;
      return { infra, plan, spec: specV2ForPlan(row), env: e.rows[0], epoch, ...(repl ? { repl } : {}) };
    },
    work: async (j, m, l): Promise<StepOutcome> => {
      if (l.runtime && l.spec && l.env) {
        const nl = l as Loaded & { runtime: TerraformRuntime; spec: AppSpecV2; env: NonNullable<Loaded["env"]> };
        // 리허설: ECS·Cloud Run·VM 도착은 건너뜀 줄만 남긴다 (설계 결정: k8s 도착만 리허설)
        const rehearsal = await recordSkip(j, l.epoch, l.infra.planId, "non_k8s");
        // VDEPLOYNONK8S 고침: 건강 조회는 도착 관찰 역할을 빌려서 한다(진짜 발급기면 그 자격 env, 워커 자기 자격은 지움). 단계가 끝나면 돌려준다
        return withStepRoles("deploy", j, m, (roles) => deployTerraformRuntime(j, nl, rehearsal, roles));
      }
      let result: DeployResult;
      let gitops: Record<string, unknown> | undefined;
      let gate: Extract<Gate, { kind: "commit" }>;
      // 온프레 CNPG 이전 배달물 판정의 경고 (끝점 줄 없음 등). 감사 detail.warnings 로 남긴다
      let warnings: string[] = [];
      let delivery: Record<string, unknown> | undefined;
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
        // 리허설: 올릴 클러스터가 없거나(no_cluster) 렌더 없이 흉내(mock)면 건너뜀 줄만
        const evidence = await recordSkip(j, l.epoch, l.infra.planId, noCluster ? "no_cluster" : "mock");
        gate = { kind: "commit", evidence, detail: { skipped: evidence } };
      } else {
        const input: DeployInput = {
          tenantId: j.tenantId, spec: l.spec, plan: l.plan!, tfOutputs: l.infra.tfOutputs,
          // 계획 처리기와 같은 target이어야 Helm 값 지문이 같다 (region "default")
          target: { envId: m.targetEnvId, provider: l.env!.provider, region: "default", accountId: l.env!.accountId, awsRoleSuffix: l.env!.awsRoleSuffix ?? null },
        };
        const repo = new GitopsRepo(cfg);
        // 온프레 CNPG 이전: 서버 인증서·봉인 비밀·터널을 값에 넣고 끝점 줄에 되쓴다. 리허설 렌더와 커밋 렌더가 같은 값을 보게 리허설 문 앞에서
        if (l.repl) {
          const d = await replicationDeliveryStep(j, input, l.repl);
          if ("outcome" in d) return d.outcome;
          warnings = d.warnings;
          delivery = d.detail;
        }
        try {
          // APP-20: 커밋 전에 도착 비밀 그릇에 값이 들었나 (흉내 IaC 면 그릇이 없으니 안 본다)
          const sv = await borrowedSecretGate(j, m, input);
          if (sv) return sv;
        } catch (e) { return gitopsPaused(e); }
        // 리허설 문: 커밋할 바이트를 vCluster 에 먼저 올린다. 기다리는 동안은 RetryLater, 실패면 paused(REHEARSAL_*).
        //   렌더·검증 실패(GitopsError)는 커밋 실패와 같이 paused, 그 밖(DB 오류 등)은 pg-boss 재시도
        const g = await rehearsalGate(j, m, l.epoch, input, repo).catch((e: unknown): Gate => {
          if (e instanceof GitopsError) return { kind: "stop", outcome: gitopsPaused(e) };
          throw e;
        });
        if (g.kind === "stop") return g.outcome;
        gate = g;
        // 사설 이미지를 렌더 값이 가리키는 도착 레지스트리 자리로 복사 (리허설을 지난 뒤 한 번, 커밋 바로 앞). 실패면 paused(IMAGE_COPY_FAILED)
        const ic = await imageCopyStep(j, m, input).catch((e: unknown) => {
          if (e instanceof GitopsError) return { outcome: gitopsPaused(e) };
          throw e;
        });
        if ("outcome" in ic) return ic.outcome;
        try {
          // W4: 온프레(agent-pull)는 AGENT_DEPLOY_CONFIRM=1 이면 Agent 배포 보고를 기다린다 (agent-watch.ts). 그 밖은 Argo 폴링 그대로
          const out = await deployToGitops(repo, input, syncWatcherFor({ tenantId: j.tenantId, targetEnvId: m.targetEnvId }), { expectBundleSha: g.expectBundleSha });
          result = DeployResult.parse(out.result);
          gitops = { commit: out.commit, argoApp: out.app, ...(out.argo ? { argo: out.argo } : {}), imageCopy: ic.detail };
        } catch (e) { return gitopsPaused(e); }
      }
      if (result.status === "failed") {
        // DRAFT(ai) Z59 (TODO(human) "Degraded·SyncFailed → paused 냐 rolling_back 이냐" 기본값): paused.
        // 트래픽 0%·컷오버 전이라 출발이 그대로 주인 → 급할 것 없음. 사람이 고쳐 paused → deploying 으로 재개하거나 롤백을 고른다.
        // 실패 이유 앞머리(ARGO_DEGRADED / ARGO_SYNC_FAILED / ARGO_TIMEOUT, W4: AGENT_DEPLOY_FAILED / AGENT_DEPLOY_TIMEOUT)를 failureCode 로
        const code = /^((?:ARGO|AGENT)_[A-Z_]+)/.exec(result.reason ?? "")?.[1] ?? "ARGO_SYNC_FAILED";
        return { to: "paused", failureCode: code, detail: { deploy: result, ...(gitops ? { gitops } : {}), rehearsal: gate.detail, ...extra(warnings, delivery) } };
      }
      return {
        to: "syncing", detail: { deploy: result, ...(gitops ? { gitops } : {}), rehearsal: gate.detail, ...extra(warnings, delivery) },
        // Z94: argoHealthy = 반영 확인 결과 (argocd-push 는 Synced+Healthy, 온프레는 Agent applied). 여기 오면 failed 는 위에서 걸렀다
        // 보안 동등성(MG-2-07): 이 단계엔 출발·도착 보안을 맞대어 잰 근거가 아직 없다 → true 라고 하지 않고 not_measured (예전: 늘 true 고정)
        evidence: { argoHealthy: result.status === "synced_healthy" || result.status === "applied", securityParity: "not_measured", rehearsal: gate.evidence },
        next: nextJob(QUEUES.sync, j),
      };
    },
  });
}

const extra = (warnings: string[], delivery?: Record<string, unknown>) =>
  ({ ...(warnings.length ? { warnings } : {}), ...(delivery ? { replicationDelivery: delivery } : {}) });

/** 온프레 도착이면 배달물을 만들 사실을 읽는다 (회사 벽 안 tx). 봉인 인증서는 도착 환경 Agent 보고에서만 (sealing-cert.ts) */
async function loadReplFacts(tx: Tx, tenantId: string, m: { id: string; targetEnvId: string }): Promise<ReplFacts> {
  const records = (await replicationEndpointsFor(tx, m.id)).filter((r) => r.tenantId === tenantId);
  const stored = records.length ? await replicationSealedMaterialFor(tx, m.id) : null;
  const sealing = records.length ? await latestSealingCert(tx, tenantId, m.targetEnvId) : undefined;
  return { records, stored, sealingCertPem: sealing?.certPem ?? null };
}

/** 배달물 판정 → 값에 넣고(input.replication) 끝점 줄에 되쓴다. 설정 문제면 paused (paused → deploying 재개 가능, 고객 클러스터엔 아무것도 안 들어감) */
export async function replicationDeliveryStep(j: MigrationJob, input: DeployInput, f: ReplFacts, env: NodeJS.ProcessEnv = process.env):
    Promise<{ outcome: StepOutcome } | { warnings: string[]; detail?: Record<string, unknown> }> {
  let values;
  try { values = filledValues(input); } catch (e) { return { outcome: gitopsPaused(e) }; }
  const dec = await decideDelivery({
    provider: input.target.provider, pullMode: envFacts(input).onpremFloorViaGit === "1", values,
    tenantId: j.tenantId, migrationId: j.migrationId, records: f.records, stored: f.stored, sealingCertPem: f.sealingCertPem,
    masterKey: env.REPL_SECRET_MASTER_KEY,
  });
  if (dec.kind === "stop")
    return { outcome: { to: "paused", failureCode: dec.code, detail: { deploy: { error: dec.code, reason: dec.reason }, ...extra(dec.warnings) } } };
  if (dec.kind === "none") return { warnings: dec.warnings };
  const d = dec.delivery;
  const wrote = d.write ? await withTenant(j.tenantId, (tx) => recordReplicationDelivery(tx, d.write!)) : null;
  input.replication = d;
  return { warnings: dec.warnings, detail: { cnpg: d.cnpg.name, reused: d.reused, rowsUpdated: !!wrote, sourcePeerSet: wrote?.sourcePeerSet ?? false,
    sealedSecrets: d.sealedSecrets.map((s) => s.name) } };
}

// APP-20 (지휘 결정 11/4 00:51Z, ADR-072 유지): 값이 빈 비밀 그릇이 있으면 커밋하지 않고 paused. paused → deploying 재개 가능(값 넣고 재개)
//   시험이 CLI 를 가짜로 바꾼다
let secretExec: Parameters<typeof checkSecretValues>[1] | undefined;
export const setSecretValueExec = (e: typeof secretExec) => { secretExec = e; };
const checksSecrets = (p: string) => (p === "aws" || p === "gcp") && (!iacMockEnabled() || !!secretExec);
/** 도착 비밀 저장소는 고객 계정에 있다. 빌린 자격이 있으면 worker 자기 자격을 지우고 그것만 쓴다. 없으면(흉내) 그대로 */
export function targetCliEnv(roles: Pick<StepRoles, "awsEnv" | "gcpToken">, projectId: string | null | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
  if (roles.awsEnv?.target) return envFor(roles.awsEnv.target, base);
  if (roles.gcpToken?.target) return gcpEnvFor(roles.gcpToken.target, projectId ?? "", base);
  return undefined;
}
async function borrowedSecretGate(j: MigrationJob, m: MigrationRow, i: DeployInput): Promise<StepOutcome | null> {
  if (!checksSecrets(i.target.provider)) return null;
  return withStepRoles("secret_check", j, m, (roles) => {
    const env = targetCliEnv(roles, i.target.accountId);
    // 실환경에서 고객 자격을 못 빌렸으면 worker 자기 자격으로 보지 않는다 (엉뚱한 계정을 보고 틀린 답을 낸다). 로컬·시험(REAL_STS=0)은 프로세스 자격
    if (!env && realStsEnabled() && !secretExec) return Promise.resolve<StepOutcome>({ to: "paused", failureCode: "SECRET_VALUES_UNKNOWN",
      detail: { deploy: { error: "SECRET_VALUES_UNKNOWN", reason: "도착 실행 역할을 못 빌려 비밀 그릇을 확인하지 못함 → 연결을 확인하고 재개", denied: roles.denied } } });
    return secretValuesGate(i, env);
  });
}
export async function secretValuesGate(i: DeployInput, env?: NodeJS.ProcessEnv): Promise<StepOutcome | null> {
  const p = i.target.provider;
  if ((p !== "aws" && p !== "gcp") || !checksSecrets(p)) return null;
  // 원격 키는 회사 번호(<env:tenantId>)만 채우면 정해진다. tf 출력 자리표시가 빠진 건 deployToGitops 가 따로 막는다
  const named = fillPlaceholders(approvedValues(i), { tf: {}, env: envFacts(i) }).values;
  const secrets = ((named.externalSecrets as { secrets?: Array<{ name: string; remoteKey: string }> } | undefined)?.secrets ?? []);
  if (!secrets.length) return null;
  const r = await checkSecretValues({ provider: p, keys: secrets.map((s) => s.remoteKey), projectId: i.target.accountId,
    // 도착 리전: "default" 면 adapters regionOf 와 같은 서울 리전 (DECISION(team) 10/31)
    region: i.target.region && i.target.region !== "default" ? i.target.region : "ap-northeast-2", ...(env ? { env } : {}) }, secretExec);
  if (r.ok) return null;
  const code = r.missing.length ? "SECRET_VALUES_MISSING" : "SECRET_VALUES_UNKNOWN";
  return { to: "paused", failureCode: code, detail: { deploy: { error: code,
    reason: r.missing.length ? `도착 비밀 그릇에 값이 없음: ${r.missing.join(", ")} → 고객 도구로 값을 넣고 재개 (플랫폼은 값을 복사하지 않음)`
      : `도착 비밀 그릇 버전을 못 읽음 → 자격·권한 확인 뒤 재개`, missing: r.missing, unknown: r.unknown.map((u) => ({ key: u.key, error: scrubString(u.error) })), checked: r.checked.length } } };
}

// DRAFT(ai): 커밋 전 실패(값 지문 다름, 자리표시 남음, 검증 실패, push 실패, 리허설 지문 다름)는 paused로 멈춘다.
// paused → deploying 으로 다시 돌릴 수 있고, 고객 클러스터에는 아무것도 안 들어갔다
function gitopsPaused(e: unknown): StepOutcome {
  const code = e instanceof GitopsError ? e.code : "GITOPS_ERROR";
  return { to: "paused", failureCode: asFailureCode(code), detail: { deploy: { error: code, reason: (e as Error).message } } };
}

/** Z77: apply 출력의 cluster_name 이 빈 문자열이면 "클러스터 없이 만든 이전". 키가 없으면(STUB·Mock) 아니다 */
export function isNoCluster(tfOutputs: Record<string, string> | undefined | null): boolean {
  return !!tfOutputs && Object.prototype.hasOwnProperty.call(tfOutputs, "cluster_name") && tfOutputs.cluster_name === "";
}

type Tx = Parameters<Parameters<typeof runStep>[1]["load"] & {}>[0];

/** APP-22 (가): 도착 앱이 GitOps(차트 values.database.activeWriter)로 DB 주소를 고르는 배포인가.
 *  아님 = 앱을 안 올림(클러스터 없음·MOCK_ARGO 흉내) 또는 Terraform 실행 방식(ECS·Cloud Run·VM: 주소가 tf 출력에 박힘) */
export async function appDbSwitchKind(tx: Tx, m: { id: string; targetEnvId: string }): Promise<"gitops" | "no_app" | "terraform_runtime"> {
  const infra = await loadInfraReady(tx, m.id);
  if (!infra || isNoCluster(infra.tfOutputs) || process.env.MOCK_ARGO === "1") return "no_app";
  return (await terraformRuntimeLoad(tx, infra, m)) ? "terraform_runtime" : "gitops";
}

/** DEPLOYNONK8S: 승인 명세가 ECS·Cloud Run·VM 이면 그 Loaded, 아니면 null (k8s 는 gitops 길) */
async function terraformRuntimeLoad(tx: Tx, infra: InfraReady, m: { id: string; targetEnvId: string }): Promise<Omit<Loaded, "epoch"> | null> {
  const plan = await loadPlanById(tx, infra.planId);
  if (!plan) return null;
  const row = await latestAcceptedSpecV2(tx, m.id);
  const spec = row ? specV2ForPlan(row) : null;
  const runtime = terraformRuntimeOf(spec);
  if (!runtime) return null;
  const e = await tx.query(`SELECT provider, ${TARGET_ACCOUNT_SQL} AS "accountId" FROM environments WHERE id=$1`, [m.targetEnvId]);   // A안: GCP = 전용 프로젝트
  if (!e.rows[0]) return null;
  return { infra, plan, spec, env: e.rows[0], runtime };
}

/** DEPLOYNONK8S: Terraform 이 앱까지 띄운 도착 → gitops·Argo 건너뜀, apply 출력 + 건강 확인으로 DeployResult.
 *  흉내 길(MOCK_IAC=1)은 출력만 본다. 진짜 길은 읽기 CLI (프로세스·실행 역할 env 의 자격, 코드엔 없음).
 *  못 뜨면 paused (paused → deploying 재개 가능, 트래픽 0%·컷오버 전이라 출발이 그대로 주인) */
async function deployTerraformRuntime(j: MigrationJob, l: Loaded & { runtime: TerraformRuntime; spec: AppSpecV2; env: NonNullable<Loaded["env"]> },
  rehearsal: RehearsalEvidence, roles?: Pick<StepRoles, "awsEnv" | "gcpToken">): Promise<StepOutcome> {
  await stubFailIfAsked(j, "deploy");
  const gitops = { skipped: "terraform_runtime", runtime: l.runtime };
  const facts = factsFromEnv(process.env);
  const h = await checkTerraformRuntime({
    provider: l.env.provider, runtime: l.runtime, spec: l.spec, tfOutputs: l.infra.tfOutputs ?? {},
    // 도착 프로젝트 = 환경 표(A안 gcp_target_project). 워커 TF_FACT_PROJECT_ID 는 그게 없을 때만 (apply·plan 의 사실 규칙과 같음)
    live: !iacMockEnabled(), projectId: l.env.accountId ?? facts.projectId ?? null,   // region = 계획과 같은 "default" 규칙 (checkTerraformRuntime)
  }, { ...runtimeHealthDeps, ...(roles && !runtimeHealthDeps.env && targetCliEnv(roles, l.env.accountId) ? { env: targetCliEnv(roles, l.env.accountId)! } : {}) });
  if (!h.ok)
    return { to: "paused", failureCode: h.code, detail: { deploy: { error: h.code, reason: scrubString(h.reason), resources: h.resources, attempts: h.attempts }, gitops, rehearsal: { skipped: rehearsal } } };
  const result = DeployResult.parse({ bundleHash: `tf-${l.infra.planId.slice(0, 8)}`, status: "synced_healthy", resources: h.resources });
  return {
    to: "syncing", detail: { deploy: result, gitops: { ...gitops, checked: h.checked, attempts: h.attempts }, rehearsal: { skipped: rehearsal } },
    // DRAFT(ai): argoHealthy 칸 = "배포 반영 확인됨". 이 도착은 Argo 대신 Terraform 출력·건강 확인이 그 근거 (감사 detail.gitops.skipped 로 구별)
    evidence: { argoHealthy: true, securityParity: "not_measured", rehearsal },   // 보안 동등성: 위 k8s 길과 같음 (잰 근거 없음)
    next: nextJob(QUEUES.sync, j),
  };
}
