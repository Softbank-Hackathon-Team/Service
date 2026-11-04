import { z } from "zod";
import { envNumber } from "./env.js";

// vCluster 리허설 계약. deploying 안, GitOps 커밋 바로 앞에서 커밋할 렌더 결과와 같은 매니페스트를 일회용 vCluster 에 먼저 올린다.
// 통과하면 커밋을 이어 가고, 실패하면 커밋하지 않고 deploying → paused (실패 코드는 아래 RehearsalFailureCode 닫힌 목록).
// 기록은 sandbox_runs 표 (db 0046). 워커가 줄을 만들고, agent-worker 가 결과를 쓰고, 상태는 워커가 advance() 로만 옮긴다

// 샌드박스 방식 (SANDBOX_MODE 값). config.ts 검사가 이 목록을 본다
export const SandboxMode = z.enum(["memory", "k3d", "vcluster"]);
export type SandboxMode = z.infer<typeof SandboxMode>;

// 샌드박스를 쓰는 실행 종류. 리허설 = 결정 코드가 앱 전체를 올림, 수정 고리 = LLM 이 고친 매니페스트를 돌림
export const SandboxRunKind = z.enum(["rehearsal", "remediation"]);
export type SandboxRunKind = z.infer<typeof SandboxRunKind>;
export const SandboxPodSecurity = z.enum(["baseline", "restricted"]);
export type SandboxPodSecurity = z.infer<typeof SandboxPodSecurity>;
// 가상 앱 네임스페이스의 파드 보안 enforce 수준과 파드 RuntimeClass (null = 노드 기본 런타임)
export const SandboxIsolation = z.object({
  podSecurity: SandboxPodSecurity,
  runtimeClass: z.string().min(1).nullable(),
}).strict();
export type SandboxIsolation = z.infer<typeof SandboxIsolation>;

// 리허설은 도착과 같은 baseline 에서 돈다 (온프레 k3s Kyverno baseline, 호스트 sbx 네임스페이스 PSA 와 같은 수준).
//   restricted 는 팀 3티어 예시(deploy/ci/values/v2-3tier-*.json, tools/real/flow/sample-3tier-eks.yaml.tpl)를 모두 거부해
//   "실제 배포는 되는데 리허설만 실패"를 만든다. 리허설 격리는 전용 샌드박스 노드에 회사 하나씩 (core boss.ts sandbox-rehearsal 큐 정책)
// 수정 고리는 LLM 이 쓴 매니페스트라 restricted + SANDBOX_RUNTIME_CLASS(gVisor 스위치, 비면 노드 기본)
const ISOLATION: Record<SandboxRunKind, (env: NodeJS.ProcessEnv) => SandboxIsolation> = {
  rehearsal: () => ({ podSecurity: "baseline", runtimeClass: null }),
  remediation: (env) => ({ podSecurity: "restricted", runtimeClass: env.SANDBOX_RUNTIME_CLASS?.trim() || null }),
};
export const sandboxIsolation = (kind: SandboxRunKind, env: NodeJS.ProcessEnv = process.env): SandboxIsolation => ISOLATION[kind](env);

// 설정 키 값 읽기 (검사는 config.ts CONFIG_RULES 가 시작 때 한다). 기본값은 여기 한 곳
// 워커: 리허설 문. DRAFT(ai): 기본 꺼짐, 기한 1200초(줄을 만든 때부터 결과까지), 깨우기가 안 왔을 때 다시 보기 60초
export function rehearsalSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: env.SANDBOX_REHEARSAL?.trim() === "on",
    timeoutSec: envNumber(env.REHEARSAL_TIMEOUT_SEC, 1200),
    pollSec: envNumber(env.REHEARSAL_POLL_SEC, 60),
    imageRegistry: env.SANDBOX_IMAGE_REGISTRY?.trim() || null,   // 플랫폼 ECR 샌드박스 자리 <호스트>/<접두어>
    mock: env.MOCK_SANDBOX?.trim() === "1",                       // 시험 전용: 이미지 복사 없이 줄을 넣는다
  };
}
// agent-worker: vCluster 실행. DRAFT(ai): 호스트 네임스페이스 만료 1800초(청소 기준), 차트는 이미지에 넣은 0.37.6 묶음
// mockResult: 시험 전용 MOCK_SANDBOX=1 이면 클러스터 없이 정해진 결과 (MOCK_SANDBOX_RESULT=fail 이면 실패, 그 밖은 통과). null = 진짜 샌드박스
export function sandboxSettings(env: NodeJS.ProcessEnv = process.env) {
  const mockResult: "pass" | "fail" | null = env.MOCK_SANDBOX?.trim() !== "1" ? null
    : env.MOCK_SANDBOX_RESULT?.trim() === "fail" ? "fail" : "pass";
  return {
    ttlSec: envNumber(env.SANDBOX_TTL_SEC, 1800),
    vclusterChart: env.SANDBOX_VCLUSTER_CHART?.trim() || "/app/vendor/vcluster-0.37.6.tgz",
    mockResult,
  };
}

// 리허설 대상 도착. gitops bundle.ts ENV_DIR 에서 azure-mock 을 뺀 셋 (ECS·Cloud Run·VM 도착은 리허설 안 함)
export const RehearsalTarget = z.enum(["aws-eks", "gcp-gke", "onprem-k3s"]);
export type RehearsalTarget = z.infer<typeof RehearsalTarget>;

export const SandboxRunStatus = z.enum(["queued", "running", "passed", "failed", "error", "skipped"]);
export type SandboxRunStatus = z.infer<typeof SandboxRunStatus>;
export const SandboxRunPhase = z.enum(["mirroring", "creating", "applying", "checking", "deleting", "done"]);
export type SandboxRunPhase = z.infer<typeof SandboxRunPhase>;
export const RehearsalSkip = z.enum(["non_k8s", "no_cluster", "unsupported_target", "disabled", "mock"]);
export type RehearsalSkip = z.infer<typeof RehearsalSkip>;
// deploying → syncing 근거 (TransitionEvidence.rehearsal). 실패는 이 길로 못 오므로 값 목록에 없다
export const RehearsalEvidence = z.enum(["passed", "reused", ...RehearsalSkip.options]);
export type RehearsalEvidence = z.infer<typeof RehearsalEvidence>;

// 닫힌 목록. 같은 글자를 core FAILURE_CODES 에 두고, 시험(failure-codes.test.ts)이 두 목록이 같은지 본다
export const RehearsalFailureCode = z.enum([
  "REHEARSAL_DRY_RUN_REJECTED",      // API 서버가 원본 객체를 거부. 실제 도착도 거부한다
  "REHEARSAL_TARGET_POLICY_DENIED",  // 파드 틀이 도착의 파드 보안 수준을 어김 (k3s baseline)
  "REHEARSAL_QUOTA_EXCEEDED",        // 원본 요청량 합이 도착 네임스페이스 한도를 넘음
  "REHEARSAL_ROLLOUT_FAILED", "REHEARSAL_CRASHLOOP", "REHEARSAL_NOT_READY",
  "REHEARSAL_JOB_FAILED", "REHEARSAL_CONNECTIVITY_FAILED",
  "REHEARSAL_POLICY_DENIED",         // 샌드박스만의 규칙(호스트 VAP 등)이 막음. 앱 고장이라는 뜻이 아님
  "REHEARSAL_UNSUPPORTED_KIND",      // 지원 목록 밖 종류가 묶음에 있음 (닫힌 쪽으로 실패)
  "REHEARSAL_IMAGE_MIRROR_FAILED", "REHEARSAL_SANDBOX_UNAVAILABLE", "REHEARSAL_TIMEOUT",
  "REHEARSAL_BUNDLE_MISMATCH",       // 커밋 직전 렌더 지문이 리허설 지문과 다름
]);
export type RehearsalFailureCode = z.infer<typeof RehearsalFailureCode>;

// 실패의 뜻. 콘솔 문장과 "사람이 할 일"이 이 표 하나로 갈린다
//   would_fail = 실제 배포도 실패한다, cannot_vouch = 샌드박스가 보증하지 못함, platform = 우리 쪽 문제
export const RehearsalFailureClass = z.enum(["would_fail", "cannot_vouch", "platform"]);
export type RehearsalFailureClass = z.infer<typeof RehearsalFailureClass>;
export const REHEARSAL_FAILURE_CLASS: Record<RehearsalFailureCode, RehearsalFailureClass> = {
  REHEARSAL_DRY_RUN_REJECTED: "would_fail", REHEARSAL_TARGET_POLICY_DENIED: "would_fail", REHEARSAL_QUOTA_EXCEEDED: "would_fail",
  REHEARSAL_ROLLOUT_FAILED: "would_fail", REHEARSAL_CRASHLOOP: "would_fail", REHEARSAL_NOT_READY: "would_fail",
  REHEARSAL_JOB_FAILED: "would_fail", REHEARSAL_CONNECTIVITY_FAILED: "would_fail",
  REHEARSAL_POLICY_DENIED: "cannot_vouch", REHEARSAL_UNSUPPORTED_KIND: "cannot_vouch",
  REHEARSAL_IMAGE_MIRROR_FAILED: "platform", REHEARSAL_SANDBOX_UNAVAILABLE: "platform",
  REHEARSAL_TIMEOUT: "platform", REHEARSAL_BUNDLE_MISMATCH: "platform",
};

export const FidelityStatus = z.enum(["identical", "substituted", "not_checked"]);
export type FidelityStatus = z.infer<typeof FidelityStatus>;
export const FidelityItemId = z.enum([
  "manifests", "namespace", "k8s_version", "objects", "target_pod_security", "sandbox_pod_security",
  "images", "replicas", "requests", "scheduling", "service_type", "storage",
  "secrets", "secret_values", "database", "ingress", "tunnel", "cloud_identity",
  "network", "quota", "runtime_isolation", "hpa_scaling", "cronjob_runs", "daemonsets",
  "data", "traffic", "node_arch",
]);
export type FidelityItemId = z.infer<typeof FidelityItemId>;
// 항목마다 주인이 하나다. 워커 = 묶음에 관한 것, agent-worker = 샌드박스에 관한 것
const AGENT_WORKER_ITEMS: readonly FidelityItemId[] = ["sandbox_pod_security", "runtime_isolation"];
export const fidelityOwner = (id: FidelityItemId): "worker" | "agent-worker" =>
  AGENT_WORKER_ITEMS.includes(id) ? "agent-worker" : "worker";

export const FidelityItem = z.object({
  id: FidelityItemId,
  status: FidelityStatus,
  real: z.string().max(200),      // 실제 배포에서는
  sandbox: z.string().max(200),   // 리허설에서는
  reason: z.string().max(300),
  refs: z.array(z.string().max(200)).max(50),   // 예: "Deployment/app-shop/web", "env API_DB_HOST"
}).strict();
export type FidelityItem = z.infer<typeof FidelityItem>;
export const FidelityMatrix = z.object({
  version: z.literal(1),
  target: RehearsalTarget,
  bundleSha256: z.string().min(1),
  items: z.array(FidelityItem).min(1),
}).strict().refine((m) => new Set(m.items.map((i) => i.id)).size === m.items.length, "항목 id 는 한 번씩");
export type FidelityMatrix = z.infer<typeof FidelityMatrix>;

// 워커 → agent-worker. sandbox_runs.input 에 저장 (큐 내용은 줄 번호 하나뿐, SandboxRunJob)
const Doc = z.object({ path: z.string().max(300), yaml: z.string().max(200_000) }).strict();
export const RehearsalInput = z.object({
  version: z.literal(1),
  target: RehearsalTarget,
  app: z.string(), namespace: z.string(),          // ChartValues.app.name / .namespace
  bundleSha256: z.string().min(1),
  k8sMinor: z.string().regex(/^1\.\d{2}$/),
  original: z.array(Doc).min(1),                     // 렌더 그대로. dry-run 에만 쓴다
  apply: z.array(Doc).min(1),                        // 치환 뒤. 실제 적용
  images: z.array(z.object({ ref: z.string(), sandboxRef: z.string() }).strict()),   // translateImage 표
  databases: z.array(z.object({ service: z.string(), majorVersion: z.string(), database: z.string(),
    owner: z.string(), secretName: z.string(), secretKeys: z.array(z.string()) }).strict()),
  targetPodSecurity: z.enum(["privileged", "baseline", "restricted"]),
  targetQuota: z.object({ limitsCpuM: z.number().int().nullable(), limitsMemoryMi: z.number().int().nullable() }).strict().nullable(),
  edges: z.array(z.object({ from: z.string(), host: z.string(), port: z.number().int() }).strict()),   // 서비스 사이 연결
  fidelity: FidelityMatrix,                          // 워커 몫 항목만
}).strict();
export type RehearsalInput = z.infer<typeof RehearsalInput>;

export const RehearsalCheckId = z.enum(["sandbox_ready", "dry_run", "target_policy", "quota", "apply", "rollout",
  "restarts", "ready", "job_complete", "service_http", "edge_http", "db_seen", "unsupported_kind"]);
export type RehearsalCheckId = z.infer<typeof RehearsalCheckId>;
export const RehearsalCheck = z.object({
  id: RehearsalCheckId,
  subject: z.string().max(200),   // "Deployment/web", "web→api:8080"
  required: z.boolean(),          // false 면 판정에 안 들어간다 (참고 줄)
  ok: z.boolean(),
  ms: z.number().int().min(0),
  detail: z.string().max(500),    // redactText 를 지난 글
}).strict();
export type RehearsalCheck = z.infer<typeof RehearsalCheck>;

export const RehearsalResult = z.object({
  verdict: z.enum(["passed", "failed", "error"]),   // failed = 앱·매니페스트, error = 샌드박스 쪽
  failureCode: RehearsalFailureCode.nullable(),
  sandbox: SandboxIsolation.extend({
    name: z.string(), hostNamespace: z.string(), chart: z.literal("vcluster-0.37.6"), k8sVersion: z.string(), mock: z.boolean(),
  }).strict(),
  bundleSha256: z.string().min(1),
  checks: z.array(RehearsalCheck).max(300),
  fidelity: FidelityMatrix,                          // 워커 몫 + agent-worker 몫
  warnings: z.array(z.string().max(300)).max(50),    // PSA warn=restricted 경고 등
  timingsMs: z.object({ create: z.number().int(), apply: z.number().int(), check: z.number().int(), delete: z.number().int() }).strict(),
  deleted: z.boolean(),
}).strict().refine((r) => (r.verdict === "passed") === (r.failureCode === null), "통과면 코드 없음, 아니면 코드 있음");
export type RehearsalResult = z.infer<typeof RehearsalResult>;

// 화면 (GET /migrations/:id/rehearsal). 지금 deploying 차례의 줄 하나
export const RehearsalView = z.object({
  migrationId: z.uuid(),
  run: z.object({
    id: z.uuid(), status: SandboxRunStatus, phase: SandboxRunPhase.nullable(), skip: RehearsalSkip.nullable(),
    reusedFrom: z.uuid().nullable(), sandboxName: z.string().nullable(),
    createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(), deadlineAt: z.string().nullable(),
    fidelity: FidelityMatrix.nullable(), result: RehearsalResult.nullable(),
  }).strict().nullable(),
}).strict();
export type RehearsalView = z.infer<typeof RehearsalView>;
