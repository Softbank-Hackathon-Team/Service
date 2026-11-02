// @svc/contracts 의 화면용 모양을 손으로 옮긴 것 (zod 없이 타입만).
// DRAFT(ai): 루트 workspaces에 apps/web이 붙고 contracts가 브라우저용으로 빌드되면
//            이 파일을 지우고 `import type { ... } from "@svc/contracts"`로 바꾼다.

export const MIGRATION_STATUSES = [
  "draft", "importing", "spec_review", "prechecking",
  "planning", "awaiting_approval", "approved",
  "provisioning",
  "deploying", "syncing", "shifting", "cutover",
  "rollback_window", "cleanup", "completed",
  "paused", "rolling_back", "rolled_back", "failed",
  "cancelled", "rejected", "stale",
] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

// contracts/src/migration.ts 의 VALID 그대로
export const VALID: Record<MigrationStatus, readonly MigrationStatus[]> = {
  draft: ["importing", "cancelled"],
  importing: ["spec_review", "failed", "cancelled"],
  spec_review: ["prechecking", "cancelled"],
  prechecking: ["planning", "spec_review", "failed", "cancelled"],
  planning: ["awaiting_approval", "failed", "cancelled"],
  awaiting_approval: ["approved", "rejected", "stale", "cancelled"],
  rejected: ["spec_review", "planning", "cancelled"],
  stale: ["planning", "cancelled"],
  approved: ["provisioning", "stale", "cancelled"],
  provisioning: ["deploying", "failed"],   // 임시 자격 재발급 실패(Z61)도 failed (Z38 REVIEW-4 Z43-1)
  deploying: ["syncing", "paused", "rolling_back"],
  syncing: ["shifting", "paused", "rolling_back"],
  shifting: ["cutover", "paused", "rolling_back"],
  cutover: ["rollback_window", "shifting", "failed"],
  rollback_window: ["cleanup", "rolling_back"],
  cleanup: ["completed", "paused"],
  paused: ["deploying", "syncing", "shifting", "cleanup", "rolling_back"],
  rolling_back: ["rolled_back", "failed"],
  failed: ["planning", "cancelled"],
  completed: [], rolled_back: [], cancelled: [],
};

export const TERMINAL: readonly MigrationStatus[] = ["completed", "rolled_back", "cancelled"];

// 지금 GET /migrations/:id 는 앞 5칸만 준다. 나머지는 있으면 쓴다.
export interface MigrationView {
  id: string;
  status: MigrationStatus;
  version: number;
  sourceEnvId: string;
  targetEnvId: string;
  pausedFrom?: MigrationStatus | null;
  failedAtStatus?: MigrationStatus | null;
  failureCode?: string | null;
  rollbackWindowEndsAt?: string | null;
  updatedAt?: string;
}

export type Provider = "aws" | "gcp" | "onprem" | "azure_mock";
export type ConnectionStatus =
  | "draft" | "awaiting_customer" | "verifying" | "connected"
  | "unstable" | "failed" | "expired" | "disconnected";

export interface EnvironmentView {
  id: string;
  provider: Provider;
  name: string;
  connectionStatus: ConnectionStatus;
  accountId: string | null;
  lastVerifiedAt: string | null;
  failureReason: string | null;
}

export interface PrecheckItem { id: string; level: "block" | "warn" | "info"; message: string; fix?: string }
export interface PlanStep {
  id: "provision" | "deploy" | "sync" | "shift" | "cutover" | "cleanup";
  owner: "terraform" | "argocd" | "agent" | "worker";
  estSec?: number; gate?: string; weights?: number[]; holdSec?: number; rollback?: string;
}
export interface PlanDoc {
  planId: string;
  migrationId: string;
  adapterVersion: string;
  steps: PlanStep[];
  precheck: PrecheckItem[];
  rollbackCriteria: { errorRatePct: number; p95Multiplier: number; windowSec: number };
  tfPlanHash: string;
  helmValuesHash: string;
  planHash: string;
  expiresAt: string;
}

export interface ApiError { status: number; code: string; message: string; requestId: string }

// GET /environments/:id/status (packages/adapters 의 RunnerStatus와 같은 모양)
export type ResourceState = "Creating" | "Succeeded" | "Deleting" | "Deleted" | "Failed";
export interface EnvResource { type: string; name: string; id: string; state: ResourceState }
export interface EnvStatus {
  provider: Provider;
  mock: boolean;
  envId: string;
  region: string;
  health: "healthy" | "degraded" | "unknown";
  checkedAt: string;
  resources: EnvResource[];
}

// ---- 비용 비교 (작업 Z2) — contracts CostEstimate / PriceSourceSummary + api MigrationCostView 를 손으로 옮긴 것 ----
// 화면에서 안 쓰는 칸(load, recommendations 등)은 뺐다. 서버 응답에 더 있어도 무시한다.
export interface CostParts { cluster: number; nodes: number; db: number; storage: number; fixed: number }
export interface EnvEstimate {
  provider: Provider;
  feasible: boolean;
  reason?: string;
  nodeSku: string | null;
  nodes: number;
  monthlyUsd: number | null;
  monthlyUsdNoCredit: number | null;
  creditUsd: number;
  parts: CostParts;
  unknown: string[];
  unverified: string[];
}
export interface CostEstimate {
  priceAsOf: string;
  priceStale: boolean;
  peakRps: number;
  requiredVcpu: number;
  profile: "startup" | "finance";
  envs: EnvEstimate[];
  cheapest: Provider | null;
  savings: { from: Provider; to: Provider; monthlyUsd: number; creditPortionUsd: number } | null;
}
export interface PriceSourceSummary {
  vendor: Provider; origin: "live" | "seed" | "sample"; fetchedAt: string; urls: string[];
}
export interface EnvRef { id: string; provider: Provider; name: string }
export interface MigrationCostView {
  migrationId: string;
  source: EnvRef;
  target: EnvRef;
  origin: "stored" | "preview";
  storedId: string | null;
  planId: string | null;
  specFrom: "stored" | "spec_versions" | "demo";
  estimate: CostEstimate;
  pair: {
    from: Provider; to: Provider;
    sourceMonthlyUsd: number | null; targetMonthlyUsd: number | null;
    monthlyUsd: number | null; creditPortionUsd: number;
  };
  priceSources: PriceSourceSummary[];
  createdAt: string;
}

// ---- 감사 타임라인 (GET /migrations/:id/timeline, openapi Timeline / TimelineItem / StateDuration) — Z83 ----
export interface TimelineItem {
  seq: number; at: string; kind: "transition" | "event"; actor: string; action: string; result: string;
  from: string | null; to: string | null; durationMs: number | null; failureCode: string | null; requestId: string | null;
  measurements: { name: string; value: number; unit: string }[];
  detail: Record<string, unknown>;
}
export interface StateDuration { state: string; ms: number; entries: number }
export interface TimelineView {
  migrationId: string; status: string; createdAt: string; generatedAt: string; running: boolean;
  totalMs: number | null; items: TimelineItem[]; stateDurations: StateDuration[];
}
// POST /migrations/:id/resume 응답 (apps/api/src/routes/control.ts, 응답 스키마 없음)
export interface ResumeResult { id: string; from: "paused"; status: MigrationStatus; queue: string; jobQueued: boolean }

// ---- GET /migrations/:id/report 중 화면이 쓰는 칸 ----
export interface EvidenceReport {
  generatedAt: string;
  summary: { startedAt: string | null; endedAt: string | null; totalMs: number | null; transitions: number;
    reachedCutover: boolean; rolledBack: boolean; deniedOrError: number };
  integrity: { ok: boolean; checked: number; firstSeq: number | null; lastSeq: number | null;
    brokenAtSeq: number | null; reason: string | null; partial: boolean };
  approvals: { planId: string; decision: "approve" | "reject"; approvedBy: string; at: string;
    approvedPlanHash: string; storedPlanHash: string | null; hashMatches: boolean }[];
  incidents: { seq: number; at: string; actor: string; action: string; result: "denied" | "error"; note: string }[];
  measurements: { name: string; value: number; unit: string; env: string; at: string }[];
  // 트래픽 판정 요약 (apps/api/src/report/schema.ts TrafficSummary). 전환을 한 번도 안 했으면 null
  traffic: TrafficSummary | null;
  gaps: string[];
  reportHash: string;
}
export interface TrafficSummary {
  judgements: number; steps: number[]; bad: number;
  maxTargetErrorRatePct: number | null; maxTargetP95Ms: number | null;
}

// ---- GET /environments/:id/inventory 의 앱 칸, GET /environments/:id/agent-reports ----
// 자원 상태 (apps/api/src/routes/env-inventory.ts FootprintState): left = 남아 있음(정리 확인 필요), unknown = 모름
export type FootprintState = "planned" | "creating" | "running" | "standby" | "stopping" | "stopped" | "removed" | "left" | "none" | "unknown";
// 값의 출처: runner·terraform = 실제로 만듦, stub = 만든 척, adapter = 어댑터 설계표(만들었는지 모름), discovered·audit = 원본·감사 기록
export type FootprintEvidence = "runner" | "terraform" | "stub" | "adapter" | "discovered" | "audit";
export interface FootprintResource { category: string; type: string; label: string; state: FootprintState; evidence: FootprintEvidence }
export interface EnvApp {
  migrationId: string; role: "source" | "target"; peer: { envId: string; name: string; provider: Provider };
  migrationStatus: MigrationStatus; stage: "before" | "changing" | "after" | "undone"; trafficPct: number | null;
  spec: { app: string } | null; resources: FootprintResource[];
}
// 보안 도구 결과 한 줄 (contracts results.ts Finding). kind: posture = 설정 위반, threat = 지금 일어나는 위협
export interface Finding {
  tool: string; toolCheckId: string; controlId: string | null; resource: string;
  status: "pass" | "fail" | "unknown"; severity: "info" | "low" | "medium" | "high" | "critical";
  kind: "posture" | "threat"; observedAt: string; evidence: string;
}
export type AgentReportBody =
  | { kind: "security"; findings: Finding[] }
  | { kind: "deploy"; status: "applied" | "failed"; resources: string[]; reason?: string }
  | { kind: "heartbeat"; k3sVersion: string; cnpg: { cluster: string; ready: boolean; replicationLagBytes: number | null } | null };
export interface AgentReportList {
  envId: string; lastHeartbeatAt: string | null; stale: boolean;
  items: { id: string; kind: AgentReportBody["kind"]; receivedAt: string; migrationId: string | null; report: AgentReportBody }[];
}

// ---- POST /cost/estimate ----
export type FullEstimate = CostEstimate & { breakpoints: { fromRps: number; cheapest: Provider; nodes: number }[] };
