import type { AppSpecV2, ChartSealedSecret, DeployResult, HelmValues, PlanDoc, Provider, TfOutputs } from "@svc/contracts";
import { flattenTfOutputsV2 } from "@svc/adapters";
import { helmValuesV2 } from "../jobs/plan-v2.js";
import { stableHash } from "../jobs/_step.js";
import { ENV_DIR, DELIVERY, appNamespace, awsHubEnabled, clusterAccess, fillPlaceholders, planFile, tenantSlug, withTraffic, argoAppName, type BundleRef, type PlanFile } from "./bundle.js";
import { GitopsError, GitopsRepo, type CommitOpts, type CommitResult, type RenderedBundle } from "./repo.js";
import { withDelivery, type ReplicationDelivery } from "./replication-delivery.js";
import { withTrafficEntry } from "../traffic-entry.js";

export { configFromEnv, GitopsRepo, GitopsError, gitopsPreflight, type CommitOpts, type RenderedBundle } from "./repo.js";
export * from "./bundle.js";
export * from "./replication-delivery.js";

export interface DeployInput {
  tenantId: string;
  // TA3: 받아들인 최신 판의 명세. 없거나 모양이 틀리면 null → GITOPS_VALUES_DRIFT
  spec: AppSpecV2 | null;
  plan: PlanDoc;
  // awsRoleSuffix: 도착 AWS 환경 역할 이름 꼬리 (0056, 배포 역할 svc-deploy<꼬리>). 승인 지문 밖 (approvedValues 는 envId·provider·region 만 본다)
  target: { envId: string; provider: Provider; region: string; accountId: string | null; awsRoleSuffix?: string | null };
  tfOutputs: TfOutputs;
  // 온프레 CNPG 이전 배달물 (서버 인증서·봉인 비밀·터널). 배포 단계가 끝점 줄이 있을 때만 넣는다 (replication-delivery.ts).
  //   승인 지문(helmValuesHash)은 채우기 전 값으로 비교하므로 이 칸은 승인 검사에 안 걸린다 (withServedBy 와 같은 자리)
  replication?: ReplicationDelivery;
  // 이전마다 Cloudflare 도착 터널 토큰 (봉인 비밀). 배포 단계가 TRAFFIC_AUTO_LB 로 만들었을 때만 (traffic-entry.ts). 승인 지문 밖 (replication 과 같은 자리)
  trafficEntry?: ChartSealedSecret;
}

// 승인 때 값과 같은지: 계획 처리기와 똑같이 helmValuesV2(spec, target)를 다시 만들어 지문을 비교한다.
// 다르면 Builder 나 명세가 승인 뒤에 바뀐 것 → 배포하지 않는다
export function approvedValues(i: DeployInput): HelmValues {
  // G8-1: 계획 때와 같은 이름 seed (계획서의 migrationId)
  const t = { envId: i.target.envId, provider: i.target.provider, region: i.target.region, migrationId: i.plan.migrationId };
  // TA3: 승인한 명세가 지금 판에 없으면 추측하지 않는다
  if (!i.spec) throw new GitopsError("GITOPS_VALUES_DRIFT", "승인한 명세가 지금 판에 없다");
  const v = helmValuesV2(i.spec, t);
  if (stableHash(v) !== i.plan.helmValuesHash) {
    throw new GitopsError("GITOPS_VALUES_DRIFT", "승인한 Helm 값 지문과 지금 만든 값 지문이 다르다 (어댑터·명세가 승인 뒤 바뀜)");
  }
  // 트래픽 지표 수집기는 플랫폼 운영 설정이라 승인 지문 밖이다. 지문을 본 뒤에 붙인다 (리허설·배포·비밀 점검이 모두 이 값을 쓴다)
  const metricsEndpoint = process.env.TRAFFIC_METRICS_ENDPOINT?.trim();
  return metricsEndpoint ? helmValuesV2(i.spec, { ...t, metricsEndpoint }) : v;
}

// DRAFT(ai): "<env:키>" 채울 사실. environments 표에 칸이 없는 것은 환경변수로 받는다 (STUB)
export function envFacts(i: DeployInput): Record<string, string | undefined> {
  return {
    tenantId: tenantSlug(i.tenantId),
    accountId: i.target.accountId ?? undefined,
    projectId: i.target.accountId ?? undefined,
    registryHost: process.env.ONPREM_REGISTRY_HOST,
    // W3: 온프레 바닥(할당량)을 git 으로 그릴지. 차트 floor.yaml 이 "1" 일 때만 그린다. 값이 늘 있어야 자리표시가 비지 않는다
    //   기본 켬, "0" 만 끔 (apply.ts 의 Terraform 건너뛰기와 같은 판정이어야 바닥이 빠지거나 두 번 생기지 않는다)
    onpremFloorViaGit: process.env.ONPREM_FLOOR_VIA_GIT === "0" ? "0" : "1",
    acrHost: process.env.AZURE_MOCK_ACR_HOST ?? "mock.azurecr.io",
  };
}

export function bundleRefOf(i: DeployInput): BundleRef {
  if (!i.spec) throw new GitopsError("GITOPS_VALUES_DRIFT", "승인한 명세가 지금 판에 없다");
  return { tenant: tenantSlug(i.tenantId), app: i.spec.app.name, env: ENV_DIR[i.target.provider] };
}

// Z94: 커밋 뒤 반영 확인. 진짜 구현은 ./argo-watch.ts (Argo REST 또는 Application CR 실폴링)
// status.sync.revision == commit && Synced && Healthy 일 때 ok. 흉내(mockArgoWatcher)는 MOCK_ARGO=1 시험 전용
export interface SyncWatchResult {
  ok: boolean;
  reason?: string;
  observed?: { source: string; app?: string; polls: number; ms: number; last?: string; sync?: string; health?: string; revision?: string };
}
export interface SyncWatcher { wait(b: BundleRef, c: CommitResult): Promise<SyncWatchResult> }

// 커밋할 묶음의 값 한 벌. deployToGitops 와 리허설 렌더(renderForRehearsal)가 같이 써서 두 길의 값이 갈라지지 않는다
export async function bundleValues(i: DeployInput, repo: GitopsRepo): Promise<{ b: BundleRef; plan: PlanFile; values: HelmValues }> {
  const b = bundleRefOf(i);
  const filled0 = filledValues(i);   // 자리표시가 남으면 레포를 만지기 전에 막는다
  const filled1 = i.replication ? withDelivery(filled0, i.replication) : filled0;
  const filled = i.trafficEntry ? withTrafficEntry(filled1, i.trafficEntry) : filled1;
  const plan = planFile(b, i.plan, await repo.chartVersion());
  return { b, plan, values: withServedBy(withTraffic(filled, plan.approvedWeights, 0), b) };
}

// 리허설 입력: 커밋할 바이트를 렌더만 하고 되돌린다 (커밋 없음)
export async function renderForRehearsal(repo: GitopsRepo, i: DeployInput): Promise<{ b: BundleRef; values: HelmValues; rendered: RenderedBundle }> {
  const { b, plan, values } = await bundleValues(i, repo);
  return { b, values, rendered: await repo.renderBundle(b, values, plan) };
}

// watcher 는 필수 인자: 기본값으로 흉내가 끼어드는 길을 없앤다 (Z94)
// expectBundleSha: 리허설을 통과한 지문. 커밋 직전 렌더가 다르면 커밋하지 않는다 (REHEARSAL_BUNDLE_MISMATCH)
export async function deployToGitops(repo: GitopsRepo, i: DeployInput, watcher: SyncWatcher, opts: CommitOpts = {}):
  Promise<{ result: DeployResult; commit: string; app: string; argo?: SyncWatchResult["observed"] }> {
  const { b, plan, values } = await bundleValues(i, repo);
  const cluster = clusterAccess(b.env, i.tfOutputs, { accountId: i.target.accountId, awsHub: awsHubEnabled(), roleSuffix: i.target.awsRoleSuffix ?? null });
  const c = await repo.commitBundle("deploy", b, values, plan, `plan ${i.plan.planId.slice(0, 8)}`, { ...opts, cluster });
  const w = await watcher.wait(b, c);
  const status = !w.ok ? "failed" : DELIVERY[b.env] === "argocd-push" ? "synced_healthy" : "applied";
  return {
    result: { bundleHash: c.bundleSha256, status, resources: c.resources, ...(w.reason ? { reason: w.reason } : {}) },
    commit: c.commit, app: argoAppName(b), ...(w.observed ? { argo: w.observed } : {}),
  };
}

// 승인 값 + 자리표시 채움 (deploy 의 비밀 값 확인도 같은 값을 본다)
// TA3: 값은 <tf-output:link.<id>.<출력>> 를 찾는다 → 맵 출력(link_outputs 등)을 펼친 표로 채운다
export function filledValues(i: DeployInput): HelmValues {
  const tf = flattenTfOutputsV2(i.tfOutputs);
  const filled = fillPlaceholders(approvedValues(i), { tf, env: envFacts(i) });
  if (filled.missing.length) {
    throw new GitopsError("GITOPS_PLACEHOLDER_MISSING", `채우지 못한 자리표시: ${filled.missing.join(", ")}`);
  }
  return filled.values;
}

// Z70 DRAFT(ai): 앱이 응답 헤더 x-served-by 로 돌려줄 이름 = <클라우드>-<구역> (예: aws-app-shop).
// Cloudflare LB 를 거친 실제 분배를 scripts/cf-check.ts --probe 가 이 헤더로 센다.
// 승인 지문(helmValuesHash)은 채우기 전 값으로 비교하므로 여기서 env 한 줄을 더해도 승인 검사에 안 걸린다 (traffic 칸과 같은 자리)
// 대안 "어댑터 toHelmValues 에 넣기" 는 버림: 모든 계획 지문이 바뀌어 기존 시험·승인된 계획이 깨진다
export function servedByName(b: BundleRef): string {
  return `${b.env.split("-")[0]}-${appNamespace(b)}`;
}
export function withServedBy(values: HelmValues, b: BundleRef): HelmValues {
  const add = (env: unknown) => {
    const xs = Array.isArray(env) ? (env as Array<{ name: string; value?: string }>) : [];
    return xs.some((e) => e.name === "SERVED_BY") ? xs : [...xs, { name: "SERVED_BY", value: servedByName(b) }];
  };
  // TA3: v2 값(workloads[])은 서비스마다 env 가 따로 → 서비스 워크로드에도 넣는다 (트래픽 확인 헤더). 잡에는 안 넣음
  //   최상위 env 는 v1 값에만 있다. v2 값엔 최상위 env 를 새로 만들지 않는다 (차트가 안 읽는 키)
  //   이미 다 있으면 같은 객체를 그대로 돌려준다 (예전 동작)
  if (Array.isArray(values.workloads)) {
    const ws = values.workloads as Array<Record<string, unknown>>;
    if (ws.every((w) => w.kind !== "service" || add(w.env) === w.env)) return values;
    return { ...values, workloads: ws.map((w) => (w.kind === "service" ? { ...w, env: add(w.env) } : w)) };
  }
  const env = add(values.env);
  return env === values.env ? values : { ...values, env };
}

// 트래픽 단계 기록 (shift 작업용. 아직 shift.ts에는 안 붙였다)
// 되돌림은 Cloudflare를 먼저 0으로 돌린 뒤 이걸 weightPct 0으로 부른다
export async function commitTrafficWeight(repo: GitopsRepo, b: BundleRef, weightPct: number): Promise<CommitResult> {
  const plan = await repo.readPlan(b);
  if (weightPct !== 0 && !plan.approvedWeights.includes(weightPct)) {
    throw new GitopsError("GITOPS_WEIGHT_NOT_APPROVED", `${weightPct}% 는 승인된 단계(${plan.approvedWeights.join(",")})가 아니다`);
  }
  const values = await repo.readValues(b);
  const prev = (values.traffic as { weightPct?: number } | null)?.weightPct ?? 0;
  return repo.commitBundle("traffic", b, withTraffic(values, plan.approvedWeights, weightPct), plan, `${prev} -> ${weightPct}`);
}
