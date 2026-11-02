import type { AppSpec, AppSpecV2, DeployResult, HelmValues, PlanDoc, Provider, TfOutputs } from "@svc/contracts";
import { adapterFor, flattenTfOutputsV2 } from "@svc/adapters";
import { helmValuesV2 } from "../jobs/plan-v2.js";
import { stableHash } from "../jobs/_step.js";
import { ENV_DIR, DELIVERY, appNamespace, fillPlaceholders, planFile, tenantSlug, withTraffic, argoAppName, type BundleRef } from "./bundle.js";
import { GitopsError, GitopsRepo, type CommitResult } from "./repo.js";

export { configFromEnv, GitopsRepo, GitopsError, gitopsPreflight } from "./repo.js";
export * from "./bundle.js";

export interface DeployInput {
  tenantId: string;
  spec: AppSpec;
  plan: PlanDoc;
  target: { envId: string; provider: Provider; region: string; accountId: string | null };
  tfOutputs: TfOutputs;
  // TA3: 계획서 irVersion "2" 일 때 계획서 specSource 와 같은 출처의 v2 명세. 없으면 GITOPS_VALUES_DRIFT
  specV2?: AppSpecV2 | null;
}

// 승인 때 값과 같은지: 계획 처리기와 똑같이 toHelmValues(spec, {}, target)를 다시 만들어 지문을 비교한다.
// 다르면 어댑터나 명세가 승인 뒤에 바뀐 것 → 배포하지 않는다
export function approvedValues(i: DeployInput): HelmValues {
  const t = { envId: i.target.envId, provider: i.target.provider, region: i.target.region };
  // TA3: 길은 계획서 irVersion 으로 (깃발 아님). v2 인데 승인한 출처의 v2 명세가 없으면 upconvert 로 몰래 넘어가지 않는다
  if (i.plan.irVersion === "2" && !i.specV2)
    throw new GitopsError("GITOPS_VALUES_DRIFT", `승인한 v2 명세(${i.plan.specSource ?? "?"})가 지금 판에 없다`);
  const v = i.plan.irVersion === "2" ? helmValuesV2(i.specV2!, t) : adapterFor(i.target.provider).toHelmValues(i.spec, {}, t);
  if (stableHash(v) !== i.plan.helmValuesHash) {
    throw new GitopsError("GITOPS_VALUES_DRIFT", "승인한 Helm 값 지문과 지금 만든 값 지문이 다르다 (어댑터·명세가 승인 뒤 바뀜)");
  }
  return v;
}

// DRAFT(ai): "<env:키>" 채울 사실. environments 표에 칸이 없는 것은 환경변수로 받는다 (STUB)
export function envFacts(i: DeployInput): Record<string, string | undefined> {
  return {
    tenantId: tenantSlug(i.tenantId),
    accountId: i.target.accountId ?? undefined,
    projectId: i.target.accountId ?? undefined,
    registryHost: process.env.ONPREM_REGISTRY_HOST,
    acrHost: process.env.AZURE_MOCK_ACR_HOST ?? "mock.azurecr.io",
  };
}

export function bundleRefOf(i: DeployInput): BundleRef {
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

// watcher 는 필수 인자: 기본값으로 흉내가 끼어드는 길을 없앤다 (Z94)
export async function deployToGitops(repo: GitopsRepo, i: DeployInput, watcher: SyncWatcher):
  Promise<{ result: DeployResult; commit: string; app: string; argo?: SyncWatchResult["observed"] }> {
  const b = bundleRefOf(i);
  // TA3: v2 값은 <tf-output:link.<id>.<출력>> 를 찾는다 → 맵 출력(link_outputs 등)을 펼친 표로 채운다 (v1 은 그대로)
  const tf = i.plan.irVersion === "2" ? flattenTfOutputsV2(i.tfOutputs) : i.tfOutputs;
  const filled = fillPlaceholders(approvedValues(i), { tf, env: envFacts(i) });
  if (filled.missing.length) {
    throw new GitopsError("GITOPS_PLACEHOLDER_MISSING", `채우지 못한 자리표시: ${filled.missing.join(", ")}`);
  }
  const plan = planFile(b, i.plan, await repo.chartVersion());
  const values = withServedBy(withTraffic(filled.values, plan.approvedWeights, 0), b);
  const c = await repo.commitBundle("deploy", b, values, plan, `plan ${i.plan.planId.slice(0, 8)}`);
  const w = await watcher.wait(b, c);
  const status = !w.ok ? "failed" : DELIVERY[b.env] === "argocd-push" ? "synced_healthy" : "applied";
  return {
    result: { bundleHash: c.bundleSha256, status, resources: c.resources, ...(w.reason ? { reason: w.reason } : {}) },
    commit: c.commit, app: argoAppName(b), ...(w.observed ? { argo: w.observed } : {}),
  };
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
