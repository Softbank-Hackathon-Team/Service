// @svc/contracts sandbox.ts 의 화면용 모양을 손으로 옮긴 것 (zod 없이 타입만, types.ts 와 같은 방식).
// DRAFT(ai): apps/web 이 contracts 를 브라우저용으로 받게 되면 지우고 `import type { ... } from "@svc/contracts"` 로 바꾼다.

export type RehearsalTarget = "aws-eks" | "gcp-gke" | "onprem-k3s";
export type SandboxRunStatus = "queued" | "running" | "passed" | "failed" | "error" | "skipped";
export type SandboxRunPhase = "mirroring" | "creating" | "applying" | "checking" | "deleting" | "done";
export type RehearsalSkip = "non_k8s" | "no_cluster" | "unsupported_target" | "disabled" | "mock";

export const REHEARSAL_FAILURE_CODES = [
  "REHEARSAL_DRY_RUN_REJECTED", "REHEARSAL_TARGET_POLICY_DENIED", "REHEARSAL_QUOTA_EXCEEDED",
  "REHEARSAL_ROLLOUT_FAILED", "REHEARSAL_CRASHLOOP", "REHEARSAL_NOT_READY",
  "REHEARSAL_JOB_FAILED", "REHEARSAL_CONNECTIVITY_FAILED",
  "REHEARSAL_POLICY_DENIED", "REHEARSAL_UNSUPPORTED_KIND",
  "REHEARSAL_IMAGE_MIRROR_FAILED", "REHEARSAL_SANDBOX_UNAVAILABLE", "REHEARSAL_TIMEOUT", "REHEARSAL_BUNDLE_MISMATCH",
] as const;
export type RehearsalFailureCode = (typeof REHEARSAL_FAILURE_CODES)[number];

/** 실패의 뜻. would_fail = 실제 배포도 실패한다, cannot_vouch = 샌드박스가 보증하지 못함, platform = 플랫폼 쪽 문제 */
export type RehearsalFailureClass = "would_fail" | "cannot_vouch" | "platform";
// contracts REHEARSAL_FAILURE_CLASS 그대로
export const REHEARSAL_FAILURE_CLASS: Record<RehearsalFailureCode, RehearsalFailureClass> = {
  REHEARSAL_DRY_RUN_REJECTED: "would_fail", REHEARSAL_TARGET_POLICY_DENIED: "would_fail", REHEARSAL_QUOTA_EXCEEDED: "would_fail",
  REHEARSAL_ROLLOUT_FAILED: "would_fail", REHEARSAL_CRASHLOOP: "would_fail", REHEARSAL_NOT_READY: "would_fail",
  REHEARSAL_JOB_FAILED: "would_fail", REHEARSAL_CONNECTIVITY_FAILED: "would_fail",
  REHEARSAL_POLICY_DENIED: "cannot_vouch", REHEARSAL_UNSUPPORTED_KIND: "cannot_vouch",
  REHEARSAL_IMAGE_MIRROR_FAILED: "platform", REHEARSAL_SANDBOX_UNAVAILABLE: "platform",
  REHEARSAL_TIMEOUT: "platform", REHEARSAL_BUNDLE_MISMATCH: "platform",
};

export type FidelityStatus = "identical" | "substituted" | "not_checked";
export type FidelityItemId =
  | "manifests" | "namespace" | "k8s_version" | "objects" | "target_pod_security" | "sandbox_pod_security"
  | "images" | "replicas" | "requests" | "scheduling" | "service_type" | "storage"
  | "secrets" | "secret_values" | "database" | "ingress" | "tunnel" | "cloud_identity"
  | "network" | "quota" | "runtime_isolation" | "hpa_scaling" | "cronjob_runs" | "daemonsets"
  | "data" | "traffic" | "node_arch";
export interface FidelityItem { id: FidelityItemId; status: FidelityStatus; real: string; sandbox: string; reason: string; refs: string[] }
export interface FidelityMatrix { version: 1; target: RehearsalTarget; bundleSha256: string; items: FidelityItem[] }

export type RehearsalCheckId =
  | "sandbox_ready" | "dry_run" | "target_policy" | "quota" | "apply" | "rollout"
  | "restarts" | "ready" | "job_complete" | "service_http" | "edge_http" | "db_seen" | "unsupported_kind";
export interface RehearsalCheck { id: RehearsalCheckId; subject: string; required: boolean; ok: boolean; ms: number; detail: string }

export interface RehearsalResult {
  verdict: "passed" | "failed" | "error";
  failureCode: RehearsalFailureCode | null;
  sandbox: {
    podSecurity: "baseline" | "restricted"; runtimeClass: string | null;
    name: string; hostNamespace: string; chart: "vcluster-0.37.6"; k8sVersion: string; mock: boolean;
  };
  bundleSha256: string;
  checks: RehearsalCheck[];
  fidelity: FidelityMatrix;
  warnings: string[];
  timingsMs: { create: number; apply: number; check: number; delete: number };
  deleted: boolean;
}

export interface RehearsalRun {
  id: string;
  status: SandboxRunStatus;
  failureCode: RehearsalFailureCode | null;
  phase: SandboxRunPhase | null;
  skip: RehearsalSkip | null;
  reusedFrom: string | null;
  sandboxName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string | null;
  fidelity: FidelityMatrix | null;
  result: RehearsalResult | null;
}

/** GET /migrations/:id/rehearsal. 아직 줄이 없으면 run: null */
export interface RehearsalView { migrationId: string; run: RehearsalRun | null }
