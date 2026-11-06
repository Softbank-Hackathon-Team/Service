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
  /** K-1: 이전을 만들 때 정한 출발 범위. {} 또는 없음 = 자동으로 고름 */
  sourceScope?: SourceScope;
  updatedAt?: string;
}

// contracts migration.ts SourceScope. 값은 CLI 인자로 들어가서 서버가 이름 글자만 받는다 (아래 정규식 그대로)
export interface SourceScope {
  appName?: string;
  partOf?: string;
  namespaces?: string[];
  cluster?: string;
  ecsCluster?: string;
  database?: string;
}
export const SCOPE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:-]{0,199}$/;
export const SCOPE_NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const SCOPE_APP_RE = /^[a-z][a-z0-9-]{0,39}$/;

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
  /** GCP 이전 전용 프로젝트 (도착 자원·실행 역할은 여기만). 값이 있을 때만 칸이 온다 */
  targetProjectId?: string;
  /** 연결은 됐지만 관찰 역할에 빠진 선택 권한, 고객이 할 일. 있을 때만 온다 */
  missingPermissions?: string[];
  needsHuman?: string[];
  /** 마지막 확인이 흉내 자격(클라우드 안 읽음)으로 닫혔으면 true */
  mock?: true;
  /** PERM-GATE: 마지막 권한 확인에서 고칠 것이 있는 묶음 수. 확인한 적 없으면 칸이 없다 */
  permissionGaps?: number;
}

// contracts permissions.ts (PERM-GATE). 고객 권한 묶음 차이와 고치는 법
export interface PermissionFix { kind: 'cloudshell' | 'cloudformation' | 'command'; url?: string; command: string }
export interface PermissionGap {
  bundleId: string; envId: string; cloud: 'aws' | 'gcp';
  stage: 'observe' | 'plan' | 'env' | 'operate' | 'relay' | 'deploy' | 'cleanup' | 'rollback';
  side: 'source' | 'target' | 'both'; principal: string; role: string; requiredWhen: string[];
  level: 'block' | 'warn'; missing: string[]; missingApis: string[]; notInTable?: string[]; unverified?: string;
  grantedVersion: number | null; requiredVersion: number; fix?: PermissionFix;
}
export interface EnvPermissions {
  envId: string; checkedAt: string | null; refreshing: boolean; requiredVersion: number; grantedVersion: number | null;
  gaps: PermissionGap[]; error?: string; fix?: PermissionFix;
}

// contracts environment.ts CreateEnvironmentBody, ConnectionLink · api agent-enroll.ts AgentEnrollToken
export interface CreateEnvironmentBody { provider: Provider; name: string; region?: string; clusterName?: string }
export interface ConnectionLink {
  kind: "aws_quick_create" | "gcp_cloud_shell" | "onprem_install";
  url?: string;
  command?: string;
  externalId?: string;
  createBoundaryPolicy?: boolean;
  expiresAt: string;
}
export interface AgentEnrollToken { envId: string; token: string; expiresAt: string; command: string }

export interface PrecheckItem { id: string; level: "block" | "warn" | "info"; message: string; fix?: string }
export interface PlanStep {
  id: "provision" | "deploy" | "sync" | "shift" | "cutover" | "cleanup";
  owner: "terraform" | "argocd" | "agent" | "worker";
  estSec?: number; gate?: string; weights?: number[]; holdSec?: number; rollback?: string;
}
// contracts plan.ts PlanCostSummary: 계획서에 실린 월 비용(USD). 계산 못 한 칸은 null + unknownFields 에 이름("*" = 전체 실패)
export interface PlanCostSummary {
  currency: "USD";
  monthlyTarget: number | null;
  monthlySource: number | null;
  deltaMonthly: number | null;
  unknownFields: string[];
  priceAsOf?: string;
  stub?: boolean;
}
// contracts plan.ts PlanAcknowledgement: 승인 때 사람이 하나씩 확인하는 항목. 승인 본문 acks 가 이 id 를 덮는다
export type PlanAckKind = "cost" | "failure_cost_policy" | "runtime_change" | "build" | "precheck_warn" | "low_confidence"
  | "tls_relaxed" | "host_access" | "public_bucket" | "provision_reuse" | "env_layer_create" | "substitute";
// substitute 항목만 from·to·lost·appChange 를 싣는다 (출발 상품 → 도착 상품, 옮기지 못하는 것, 앱 코드를 고쳐야 붙는지)
export interface PlanAcknowledgement {
  id: string; kind: PlanAckKind; text: string; ref?: string;
  from?: string; to?: string; lost?: string[]; appChange?: boolean;
}
// contracts spec-v2.ts ApprovalRowV2: 명세 GET 의 substitutions 줄 (substitute 만 온다). 계획 때 확인 항목 id 는 `${kind}:${subject}`
export interface ApprovalRowV2 {
  kind: "runtime_change" | "build" | "tls_relaxed" | "host_access" | "public_bucket" | "substitute";
  subject: string; from?: string; to?: string; detail?: string; lost?: string[]; appChange?: boolean;
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
  // 옛 계획서에는 없다 (PA4). 있으면 지문에 들어간다
  specVersion?: number;
  costSummary?: PlanCostSummary;
  acknowledgements?: PlanAcknowledgement[];
  // PLAN_IR=v2 로 만든 계획서에만 (TA3). 화면은 기본 화면에 쓰지 않는다 (L3)
  irVersion?: "2";
  specSource?: "spec_v2" | "upconvert";
  instances?: { kind: string; id: string; module: string }[];
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
// POST /migrations/:id/failure-decision 응답 (contracts migration.ts FailureDecisionResult). queue 는 cancelled 면 null
export interface FailureDecisionResult { id: string; from: "failed"; choice: "retry" | "rollback"; status: MigrationStatus; queue: string | null; jobQueued: boolean }

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
  // 트래픽 판정 요약 (packages/contracts/src/results.ts TrafficSummary). 전환을 한 번도 안 했으면 null
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
  | { kind: "heartbeat"; k3sVersion: string; cnpg: { cluster: string; ready: boolean; replicationLagBytes: number | null } | null }
  // W5: 온프레 보안 사실 (contracts agent.ts facts). null = Agent 가 못 읽음
  | { kind: "facts"; grants: { level: "L0" | "L1" }; dbs: { namespace: string; cluster: string; majorVersion: number | null; tlsEnforced: boolean | null; authMethods: string[] | null; exposed: boolean | null }[] };
export interface AgentReportList {
  envId: string; lastHeartbeatAt: string | null; stale: boolean;
  items: { id: string; kind: AgentReportBody["kind"]; receivedAt: string; migrationId: string | null; report: AgentReportBody }[];
}

// ---- POST /cost/estimate ----
export type FullEstimate = CostEstimate & { breakpoints: { fromRps: number; cheapest: Provider; nodes: number }[] };

// ---- 근거 있는 비용 (contracts cost-evidence.ts, PriceItem·PriceUnit·Evidence 는 cost.ts) ----
// GET /environments/:id/cost?lang=, POST /environments/:id/cost/move?lang=. 숫자마다 "어느 자원을 몇 개 셌나(basis)"와
// "그 단가는 어디서 왔나(price)"가 붙는다. 근거 문장은 서버가 lang 언어로 만든다. 청구서가 아니라 공개 가격표로 낸 추정이다
export type CostGroup = "cluster" | "compute" | "database" | "storage" | "network" | "fixed";
export type PriceItem =
  | "cluster" | "cluster_credit" | "node" | "db" | "storage" | "fixed" | "lb" | "lb_capacity" | "volume"
  | "instance" | "db_class" | "public_ip" | "nat" | "db_vcpu" | "db_mem";
export type PriceUnit = "hour" | "month" | "gb_month";
/** contracts cost.ts Evidence */
export type PriceEvidence = "fact" | "unverified" | "assumed" | "mock";
/** 수량의 근거. inventory = 실자원 조회로 셈, mapped = 출발 자원을 도착 상품으로 바꿈, assumption = 재지 않고 정한 값 */
export interface CostBasis { kind: "inventory" | "mapped" | "assumption"; text: string; refs: string[] }
/** 단가의 근거 (가격표 한 줄) */
export interface CostPriceRef {
  item: PriceItem; sku: string; unitUsd: number; unit: PriceUnit; evidence: PriceEvidence;
  sourceKind: "official_api" | "official_page" | "secondary" | "assumption";
  source: string; sourceUrl: string | null; fetchedAt: string;
}
/** 합계의 한 항 = 수량 x 단가 x 시간 */
export interface CostLine {
  id: string; group: CostGroup; label: string; quantity: number; quantityUnit: string;
  hours: number | null; monthlyUsd: number; formula: string; basis: CostBasis; price: CostPriceRef;
}
/** 합계에 넣지 못한 것과 그 이유. estimateUsd 는 참고값이고 합계에 안 들어간다 */
export interface CostGap { id: string; label: string; reason: string; estimateUsd: number | null }
export interface CostBreakdown { provider: Provider; region: string; monthlyUsd: number; lines: CostLine[]; gaps: CostGap[]; priceAsOf: string }
/** applied = 이 견적에 늘 들어감, conditional = 조건을 채우면 들어감 (금액 0 이면 신청·심사 프로그램), not_applicable = 상관없음 (이유는 note) */
export interface CostPromotion {
  id: string; provider: Provider; title: string;
  kind: "recurring_credit" | "trial_credit" | "signup_credit" | "program_credit" | "data_transfer_waiver";
  status: "applied" | "conditional" | "not_applicable";
  condition: string; appliesTo: string; firstYearUsd: number; monthlyUsd: number[];
  validUntil: string | null; sourceUrl: string; checkedAt: string; note: string | null;
}
export interface CostProjection {
  monthlyUsd: number; yearlyUsd: number; appliedYearlyUsd: number; conditionalYearlyUsd: number; appliedMonthlyUsd: number;
  promotions: CostPromotion[];
}
/** GET /environments/:id/cost. partial = 일부 자원을 못 읽어 합계가 낮을 수 있음 (reason 에 못 읽은 명령) */
export interface EnvCostView {
  envId: string; name: string; provider: Provider;
  status: "ok" | "partial" | "unavailable";
  reason: string | null;
  inventoryCheckedAt: string | null;
  breakdown: CostBreakdown | null;
  projection: CostProjection | null;
}
/** 출발 자원 하나가 도착에서 무엇으로 바뀌었나. 대응 상품이 없으면 to = null */
export interface CostMapping { group: CostGroup; from: string; to: string | null; why: string }
export interface MoveCostRequest { targetEnvIds: string[]; sourceScope?: SourceScope }
/** deltaMonthlyUsd = 출발 정가 - 도착 정가 (양수 = 아낌) */
export interface MoveCostTarget {
  envId: string; name: string; provider: Provider;
  feasible: boolean; reason: string | null;
  breakdown: CostBreakdown | null; projection: CostProjection | null;
  mappings: CostMapping[]; deltaMonthlyUsd: number | null;
}
/** source 는 고른 범위만 다시 센 출발 */
export interface MoveCostView { source: EnvCostView; scopeNote: string | null; targets: MoveCostTarget[] }
