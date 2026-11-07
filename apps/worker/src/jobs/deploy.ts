import { DeployResult, MigrationJob, QUEUES, type AppSpecV2, type HelmValues, type InfraReady, type PlanDoc, type Provider, type RehearsalEvidence, type ReplicationEndpoint, type ReplicationSealedMaterial } from "@svc/contracts";
import { asFailureCode, latestAcceptedSpecV2, recordReplicationDelivery, replicationEndpointsFor, replicationSealedMaterialFor, scrubString, withTenant, writeAudit, type AuditInput } from "@svc/core";
import { checkTerraformRuntime, envFor, factsFromEnv, gcpEnvFor, iacMockEnabled, specV2ForPlan, terraformRuntimeOf, type RuntimeHealthDeps, type TerraformRuntime } from "@svc/adapters";
import { nextJob, runStep, stubWait, stubFailIfAsked, type MigrationRow, type StepOutcome } from "./_step.js";
import { withStepRoles, type StepRoles } from "./_roles.js";
import { loadInfraReady, loadPlanById } from "./plan-store.js";
import { approvedValues, configFromEnv, decideDelivery, deployToGitops, envFacts, filledValues, fillPlaceholders, GitopsError, GitopsRepo, bundlePath, bundleRefFor, tenantSlug, withDelivery, ENV_DIR, type BundleRef, type DeployInput, type PlanFile, type SyncWatcher } from "../gitops/index.js";
import { latestSealingCert } from "../gitops/sealing-cert.js";
import { checkSecretValues } from "../gitops/secret-values.js";
import { dbMetricIssuer, fillIngressSecrets, readTunnelToken, TUNNEL_SECRET, tunnelSourceFromEnv, type MetricIssuer, type SecretFillResult, type TokenSource } from "../gitops/ingress-secrets.js";
import { realStsEnabled } from "../platform.js";
import { syncWatcherFor } from "../gitops/agent-watch.js";
import { argoStopHint } from "../gitops/argo-watch.js";
import { TARGET_ACCOUNT_SQL } from "./target-account.js";
import { recordSkip, rehearsalGate, type Gate } from "../rehearsal/gate.js";
import { imageCopyStep } from "./image-copy.js";
import { prepareTrafficEntry } from "../traffic-entry.js";

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
  sourceRepl?: ReplFacts;      // 온프레 출발 → AWS 도착만 (ADR-031 R4): 출발 온프레 묶음에 넣을 배달물 사실 (봉인 인증서는 출발 환경 Agent 보고)
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
      const repl = e.rows[0].provider === "onprem" ? await loadReplFacts(tx, j.tenantId, m.id, m.targetEnvId) : undefined;
      const src = e.rows[0].provider === "aws" ? (await tx.query(`SELECT provider FROM environments WHERE id=$1`, [m.sourceEnvId])).rows[0] : undefined;
      const sourceRepl = src?.provider === "onprem" ? await loadReplFacts(tx, j.tenantId, m.id, m.sourceEnvId, "source") : undefined;
      return { infra, plan, spec: specV2ForPlan(row), env: e.rows[0], epoch, ...(repl ? { repl } : {}), ...(sourceRepl ? { sourceRepl } : {}) };
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
      let trafficEntry: Record<string, unknown> | undefined;
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
        // 이전마다 실제 트래픽 입구 (TRAFFIC_AUTO_LB=1): Cloudflare 도착 터널·LB 를 만들고 등록, 터널 토큰은 봉인 비밀로 같은 커밋에. 리허설 앞이라 같은 값을 렌더한다
        let filledForEntry: HelmValues | null = null;
        try { filledForEntry = filledValues(input); } catch { /* 자리표시 문제는 아래 리허설·커밋 길이 같은 이유로 멈춘다 */ }
        const te = filledForEntry ? await prepareTrafficEntry({ tenantId: j.tenantId, migrationId: j.migrationId, provider: input.target.provider,
          values: filledForEntry, sealingCertPem: l.repl?.sealingCertPem ?? null }) : { kind: "off" as const };
        if (te.kind === "stop")
          return { to: "paused", failureCode: te.code, detail: { deploy: { error: te.code, reason: te.reason, ...(te.hint ? { hint: te.hint } : {}) }, ...extra(warnings, delivery) } };
        if (te.kind === "ok") { input.trafficEntry = te.sealedSecret; trafficEntry = te.detail; }
        else if (te.kind === "skipped") trafficEntry = { skipped: te.reason };
        try {
          // 검사 바로 앞: GCP 도착의 빈 입구 비밀(터널·지표 토큰)을 플랫폼이 채운다. 실패면 paused, 성공이면 null
          const sf = await borrowedSecretFill(j, m, input);
          if (sf) return sf;
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
          //   D3 (#373): covers = 보고 리비전이 우리 커밋의 후손이고 묶음 폴더가 그대로면 같은 커밋으로 본다 (다른 이전이 뒤이어 커밋해도 600초를 안 기다림)
          const watcher = syncWatcherFor({ tenantId: j.tenantId, targetEnvId: m.targetEnvId }, process.env, { covers: (b, c, rev) => repo.revisionCovers(b, c, rev) });
          const out = await deployToGitops(repo, input, watcher, { expectBundleSha: g.expectBundleSha });
          result = DeployResult.parse(out.result);
          gitops = { commit: out.commit, argoApp: out.app, ...(out.argo ? { argo: out.argo } : {}), imageCopy: ic.detail };
        } catch (e) { return gitopsPaused(e); }
        // 온프레 → AWS (ADR-031 R4): 도착 앱이 뜬 뒤 출발 온프레 묶음에 이전 역할·서버 인증서·봉인 비밀·터널을 넣고 Agent 반영을 기다린다.
        //   실패면 paused (재개하면 도착 커밋은 바뀐 것 없음, 출발 배달만 다시)
        if (l.sourceRepl && result.status !== "failed") {
          const sd = await sourceReplicationStep(j, m, input, l.sourceRepl, repo);
          if ("outcome" in sd) return sd.outcome;
          warnings = sd.warnings;
          delivery = sd.detail;
        }
      }
      if (result.status === "failed") {
        // DRAFT(ai) Z59 (TODO(human) "Degraded·SyncFailed → paused 냐 rolling_back 이냐" 기본값): paused.
        // 트래픽 0%·컷오버 전이라 출발이 그대로 주인 → 급할 것 없음. 사람이 고쳐 paused → deploying 으로 재개하거나 롤백을 고른다.
        // 실패 이유 앞머리(ARGO_DEGRADED / ARGO_SYNC_FAILED / ARGO_TIMEOUT, W4: AGENT_DEPLOY_FAILED / AGENT_DEPLOY_TIMEOUT)를 failureCode 로
        const code = /^((?:ARGO|AGENT)_[A-Z_]+)/.exec(result.reason ?? "")?.[1] ?? "ARGO_SYNC_FAILED";
        // D1 (#373): ARGO_CLUSTER_UNREACHABLE 이면 고칠 곳(허브 클러스터 접근·cluster Secret namespaces)을 deploy 칸에 붙인다 (웹 멈춤 화면이 그대로 그림)
        const help = l.env ? argoStopHint(code, ENV_DIR[l.env.provider]) : null;
        return { to: "paused", failureCode: code, detail: { deploy: help ? { ...result, ...help } : result, ...(gitops ? { gitops } : {}), rehearsal: gate.detail, ...extra(warnings, delivery) } };
      }
      return {
        to: "syncing", detail: { deploy: result, ...(gitops ? { gitops } : {}), rehearsal: gate.detail, ...extra(warnings, delivery), ...(trafficEntry ? { trafficEntry } : {}) },
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

/** 온프레 쪽(도착 또는 출발)의 배달물을 만들 사실을 읽는다 (회사 벽 안 tx). 봉인 인증서는 그 온프레 환경 Agent 보고에서만 (sealing-cert.ts) */
async function loadReplFacts(tx: Tx, tenantId: string, migrationId: string, onpremEnvId: string, side: "source" | "target" = "target"): Promise<ReplFacts> {
  const records = (await replicationEndpointsFor(tx, migrationId)).filter((r) => r.tenantId === tenantId);
  const stored = records.length ? await replicationSealedMaterialFor(tx, migrationId, side) : null;
  const sealing = records.length ? await latestSealingCert(tx, tenantId, onpremEnvId) : undefined;
  return { records, stored, sealingCertPem: sealing?.certPem ?? null };
}

/** 출발 온프레 묶음 값: CNPG 하나의 이전 역할을 켠다 (예전 정리가 ensure=absent 로 둔 것도 present 로). CNPG 가 하나가 아니면 null */
export function withSourceReplication(values: HelmValues): HelmValues | null {
  const pgs = (values.postgres as Array<Record<string, unknown>> | undefined) ?? [];
  const idx = pgs.flatMap((p, i) => (p.mode === "cnpg" && p.name ? [i] : []));
  if (idx.length !== 1) return null;
  return { ...values, postgres: pgs.map((p, i) => (i === idx[0]
    ? { ...p, replication: { ...((p.replication as Record<string, unknown> | undefined) ?? {}), enabled: true, ensure: "present" } } : p)) };
}

type SourceRepo = Pick<GitopsRepo, "chartVersion" | "readValues" | "readPlan" | "commitBundle" | "resolve"> & Partial<Pick<GitopsRepo, "revisionCovers">>;
/** 온프레 → AWS: 출발 온프레 묶음(이 플랫폼이 그린 묶음)에 배달물을 넣어 커밋하고, 출발 환경 Agent 보고를 기다린다.
 *  묶음이 없으면(고객이 직접 올린 앱) 손대지 않고 paused — 출발 클러스터에 우리가 모르는 것을 쓰지 않는다 */
export async function sourceReplicationStep(j: MigrationJob, m: MigrationRow, input: DeployInput, f: ReplFacts, repo: SourceRepo,
    env: NodeJS.ProcessEnv = process.env, watcher?: SyncWatcher): Promise<{ outcome: StepOutcome } | { warnings: string[]; detail?: Record<string, unknown> }> {
  const stop = (code: string, reason: string, warnings: string[] = []): { outcome: StepOutcome } =>
    ({ outcome: { to: "paused", failureCode: code, detail: { deploy: { error: code, reason }, ...extra(warnings) } } });
  if (!input.spec) return stop("GITOPS_VALUES_DRIFT", "승인한 명세가 지금 판에 없다");
  // 출발 온프레 묶음 = 앞선 이전이 이 온프레 환경에 그린 폴더 (환경별 폴더, 그 전 배포면 예전 폴더). Agent 보고 짝짓기도 고른 폴더 이름으로 한다
  let b: BundleRef = bundleRefFor(j.tenantId, input.spec.app.name, "onprem", m.sourceEnvId);
  let values: HelmValues, plan: PlanFile;
  try {
    await repo.chartVersion();   // 작업 복사본 준비
    b = await repo.resolve(b);
    [values, plan] = [await repo.readValues(b), await repo.readPlan(b)];
  } catch {
    return stop("REPL_DELIVERY_FAILED", `출발 온프레 묶음 ${bundlePath(b)} 이 gitops 레포에 없다: 플랫폼이 그린 출발 앱만 이전 역할·터널을 넣을 수 있다`);
  }
  const enabled = withSourceReplication(values);
  if (!enabled) return stop("REPL_DELIVERY_FAILED", "출발 온프레 묶음의 CNPG 가 하나가 아니다 (이전마다 출발 DB 하나)");
  const dec = await decideDelivery({
    provider: "onprem", onpremSide: "source", pullMode: env.ONPREM_FLOOR_VIA_GIT !== "0", values: enabled,
    tenantId: j.tenantId, migrationId: j.migrationId, records: f.records, stored: f.stored, sealingCertPem: f.sealingCertPem,
    masterKey: env.REPL_SECRET_MASTER_KEY,
  });
  if (dec.kind === "stop") return stop(dec.code, dec.reason, dec.warnings);
  if (dec.kind === "none") return { warnings: dec.warnings };
  const d = dec.delivery;
  const wrote = d.write ? await withTenant(j.tenantId, (tx) => recordReplicationDelivery(tx, d.write!)) : null;
  try {
    const c = await repo.commitBundle("deploy", b, withDelivery(enabled, d), plan, `replication delivery (source) ${j.migrationId.slice(0, 8)}`);
    // D3 (#373): 출발 Agent 보고도 후손 리비전(묶음 폴더 그대로)을 받는다
    const covers = repo.revisionCovers ? { covers: repo.revisionCovers.bind(repo) } : {};
    const w = await (watcher ?? syncWatcherFor({ tenantId: j.tenantId, targetEnvId: m.sourceEnvId }, env, covers)).wait(b, c);
    const detail = { side: "source", cnpg: d.cnpg.name, reused: d.reused, rowsUpdated: !!wrote, sourcePeerSet: wrote?.sourcePeerSet ?? false,
      sealedSecrets: d.sealedSecrets.map((s) => s.name), commit: c.commit, ...(w.observed ? { agent: w.observed } : {}) };
    if (!w.ok) {
      const code = /^((?:ARGO|AGENT)_[A-Z_]+)/.exec(w.reason ?? "")?.[1] ?? "AGENT_DEPLOY_FAILED";
      return { outcome: { to: "paused", failureCode: code, detail: { deploy: { error: code, reason: w.reason }, ...extra(dec.warnings, detail) } } };
    }
    return { warnings: dec.warnings, detail };
  } catch (e) { return { outcome: gitopsPaused(e) }; }
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
// 시험이 입구 비밀 출처(터널 토큰 읽기·지표 토큰 발급)와 감사 쓰기를 가짜로 바꾼다. undefined = 진짜 출처, null = 출처 없음
type FillAudit = (tenantId: string, a: AuditInput) => Promise<unknown>;
let fillSources: { tunnel?: TokenSource | null; metric?: MetricIssuer | null; audit?: FillAudit } = {};
const dbFillAudit: FillAudit = (tenantId, a) => withTenant(tenantId, (tx) => writeAudit(tx, tenantId, a));
export const setIngressSecretSources = (s: typeof fillSources | undefined) => { fillSources = s ?? {}; };
/** 검사와 같은 도착 실행 역할을 빌려 빈 입구 비밀을 채운다. 실패면 paused(SECRET_VALUES_UNKNOWN, 이름만), 그 밖은 null → 기존 검사가 그대로 돈다 */
async function borrowedSecretFill(j: MigrationJob, m: MigrationRow, i: DeployInput): Promise<StepOutcome | null> {
  if (i.target.provider !== "gcp" || !checksSecrets(i.target.provider)) return null;
  return withStepRoles("secret_check", j, m, async (roles) => {
    const env = targetCliEnv(roles, i.target.accountId);
    // 고객 자격을 못 빌렸으면 채우지 않는다 (뒤 검사가 SECRET_VALUES_UNKNOWN 으로 멈춘다)
    if (!env && realStsEnabled() && !secretExec) return null;
    const r = await ingressSecretFill(j, m, i, env);
    if (!r?.failed.length) return null;
    return { to: "paused", failureCode: "SECRET_VALUES_UNKNOWN", detail: { deploy: { error: "SECRET_VALUES_UNKNOWN",
      reason: `입구 비밀을 채우지 못함: ${r.failed.map((f) => f.name).join(", ")} → 출처·권한을 확인하거나 값을 직접 넣고 재개`,
      secretFill: { filled: r.filled, skipped: r.skipped.map((s) => s.name), failed: r.failed.map((f) => f.name) } } } };
  });
}
/** 지표 토큰 자동 발급은 worker env METRIC_TOKEN_AUTOFILL=1 (차트 ingressSecretFill.metricToken) 일 때만.
 *  꺼져 있으면 null → 지표 그릇은 no_source 로 건너뛰고 뒤 검사가 SECRET_VALUES_MISSING 으로 멈춘다 (사람이 값을 넣고 재개).
 *  DRAFT(ai): 기본 끔. 환경당 살아 있는 지표 토큰은 하나라, 같은 도착 환경에 앱이 둘이면 발급이 첫 앱 지표 토큰을 끊는다 */
export function metricIssuerFor(j: MigrationJob, m: MigrationRow, env: NodeJS.ProcessEnv = process.env,
  make: typeof dbMetricIssuer = dbMetricIssuer): MetricIssuer | null {
  return env.METRIC_TOKEN_AUTOFILL?.trim() === "1" ? make(j.tenantId, m.targetEnvId, j.migrationId) : null;
}
/** GCP 도착: 입구 비밀(터널·지표 토큰) 중 빈 그릇 채우기. 지표 토큰은 차트 값에 지표가 켜졌을 때만 externalSecrets 에 있다.
 *  AWS 는 쓰기 권한이 없어 기존 검사에 맡기고(SECRET_VALUES_MISSING → 사람이 넣고 재개), 온프레는 범위 밖 */
export async function ingressSecretFill(j: MigrationJob, m: MigrationRow, i: DeployInput, env?: NodeJS.ProcessEnv): Promise<SecretFillResult | null> {
  if (i.target.provider !== "gcp") return null;
  const named = fillPlaceholders(approvedValues(i), { tf: {}, env: envFacts(i) }).values;
  const secrets = ((named.externalSecrets as { secrets?: Array<{ name: string; remoteKey: string }> } | undefined)?.secrets ?? []);
  const src = tunnelSourceFromEnv();
  // 터널 토큰은 worker 자기 자격(process.env, 플랫폼 계정)으로 읽는다. 빌린 고객 env 를 쓰지 않는다
  const tunnel = fillSources.tunnel !== undefined ? fillSources.tunnel : src ? () => readTunnelToken(src, secretExec) : null;
  const metric = fillSources.metric !== undefined ? fillSources.metric : metricIssuerFor(j, m);
  const r = await fillIngressSecrets({ secrets, projectId: i.target.accountId, ...(env ? { env } : {}), tunnel, metric }, secretExec);
  if (r.filled.includes(TUNNEL_SECRET)) {
    // 터널 토큰을 채웠으면 감사 한 줄 (지표 토큰 env.metric_token_issued 와 같은 규칙: 이름만, 토큰 원문·원격 키 없음)
    // DRAFT(ai): 액션 이름 env.tunnel_token_filled
    try {
      await (fillSources.audit ?? dbFillAudit)(j.tenantId, { actor: "worker", action: "env.tunnel_token_filled", target: m.targetEnvId, result: "ok",
        detail: { by: "deploy", migrationId: j.migrationId, secret: TUNNEL_SECRET } });
    } catch (e) {
      // DRAFT(ai): 감사를 못 남기면 채운 것으로 치지 않고 failed → paused(SECRET_VALUES_UNKNOWN). 그릇에는 이미 값이 들어가 있어
      //   재개하면 has_value 로 건너뛰고 감사는 다시 쓰지 않는다 (재개 전 감사 표·그릇을 사람이 확인)
      r.filled = r.filled.filter((n) => n !== TUNNEL_SECRET);
      //   오류 문장은 남기지 않는다 (scrubString 이 못 지우는 모양이 섞일 수 있다). DB 오류 코드만
      const code = (e as { code?: unknown })?.code;
      r.failed.push({ name: TUNNEL_SECRET, error: `감사 기록 실패 (env.tunnel_token_filled${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? `, ${code}` : ""})` });
    }
  }
  return r;
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
