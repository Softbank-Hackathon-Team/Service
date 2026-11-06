import { z } from "zod";
import { RehearsalEvidence } from "./sandbox.js";

// 이전 한 건의 상태 22개
export const MIGRATION_STATUSES = [
  "draft", "importing", "spec_review", "prechecking",
  "planning", "awaiting_approval", "approved",
  "provisioning",
  "deploying", "syncing", "shifting", "cutover",
  "rollback_window", "cleanup", "completed",
  "paused", "rolling_back", "rolled_back", "failed",
  "cancelled", "rejected", "stale",
] as const;
export const MigrationStatus = z.enum(MIGRATION_STATUSES);
export type MigrationStatus = z.infer<typeof MigrationStatus>;

// 어디서 어디로 갈 수 있나 (조건은 core의 guard가 따로 본다)
export const VALID: Record<MigrationStatus, readonly MigrationStatus[]> = {
  draft: ["importing", "cancelled"],
  importing: ["spec_review", "failed", "cancelled"],
  spec_review: ["prechecking", "cancelled"],
  prechecking: ["planning", "spec_review", "failed", "cancelled"],
  planning: ["awaiting_approval", "failed", "cancelled"],
  awaiting_approval: ["approved", "rejected", "stale", "cancelled"],
  // G7-2 DRAFT(ai): 다시 계획은 사전 점검부터 다시 돈다 (예전 → planning 은 첫 바퀴의 옛 점검표를 계획서에 그대로 실었다)
  rejected: ["spec_review", "prechecking", "cancelled"],
  stale: ["prechecking", "cancelled"],
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
  // DECISION(team): 실패 → 트래픽 출발로 → AI 원인 분석 → 사람에게 "재시도할까?" → 승인: 실패한 단계부터 / 거절: 롤백
  //   (Jeong 11/4 01:53Z, 11/3 20:02Z 규칙 대체, ADR-066 개정). failed 에서 다시 계획(→ prechecking)은 없앴다: 다시 계획은 stale·rejected 에서만.
  // DRAFT(ai): 질문 대기 상태 = failed 그대로 (새 상태를 만들지 않음. 22개 표·DB·화면을 안 바꾼다. 배포 뒤 단계 실패는 원래대로 paused 가 질문 대기).
  //   재시도 = failed → 실패 지점 상태(가드: failedAtStatus 와 같아야, 증거 failureDecision "retry"). prechecking 길은 "점검 단계 재시도"로만 남는다.
  //   거절 = 자원을 만든 뒤(provisioning·cutover·rolling_back) 실패면 → rolling_back, 만들기 전이면 → cancelled (POST /migrations/:id/failure-decision)
  failed: ["importing", "prechecking", "planning", "provisioning", "cutover", "rolling_back", "cancelled"],
  completed: [], rolled_back: [], cancelled: [],
};

// DRAFT(ai): 실패 질문 "재시도" 때 다시 들어갈 수 있는 실패 지점 (failed 로 오는 단계 전부. 배포 뒤 단계는 paused 라 resume)
export const RETRYABLE_FAILURES: readonly MigrationStatus[] =
  ["importing", "prechecking", "planning", "provisioning", "cutover", "rolling_back"];
// DRAFT(ai): 이 지점 실패를 "거절"하면 만든 자원이 있어 롤백(→ rolling_back → rolled_back → 도착 지우기). 그 밖은 만든 게 없어 cancelled.
//   deploying·syncing·shifting·rollback_window 는 보통 failed 로 안 오지만 운영 도구(ops:force-fail)가 보낼 수 있다.
//   cleanup·paused 는 뺀다: 창이 끝난 뒤(도착이 새 주인)라 롤백·지우기를 하면 안 된다 (P-4) → 사람이 수동 정리 후 취소
export const ROLLBACK_ON_REJECT: readonly MigrationStatus[] =
  ["provisioning", "deploying", "syncing", "shifting", "cutover", "rollback_window", "rolling_back"];

export const TERMINAL: readonly MigrationStatus[] =
  ["completed", "rolled_back", "cancelled"];

// K-1 DRAFT(ai): 이전 한 건의 출발 범위 (어느 클러스터·네임스페이스·앱 묶음·DB 를 가져올지). 이전을 만들 때 받아 migrations.source_scope 에 둔다.
//   가져오기 작업은 큐 내용이 아니라 DB 에서 다시 읽는다 (CLAUDE.md 5-3). 빈 칸은 예전처럼 자동 고르기 + 검토 줄. 워커 환경변수(IMPORT_*)는 개발용 기본값으로만.
//   값은 CLI 인자로 들어가므로 이름 글자만 받는다 (셸은 안 쓰지만 이상한 글자는 처음부터 막음)
const ScopeName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/:-]{0,199}$/);
export const SourceScope = z.object({
  /** G3b-5: 앱 이름 (도착 자원 이름의 뿌리). 없으면 앱 묶음 값 → 앞 판 이름 → 첫 서비스 순 */
  appName: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
  /** 앱 묶음 라벨 값 (app.kubernetes.io/part-of 등, 예전 IMPORT_APP) */
  partOf: ScopeName.optional(),
  /** k8s 네임스페이스 (예전 IMPORT_NAMESPACE). 여럿이면 같은 앱 묶음 */
  namespaces: z.array(z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)).min(1).max(10).optional(),
  /** EKS·GKE 클러스터 이름 (GKE 는 "location/이름" 도 됨, 예전 IMPORT_AWS_EKS_CLUSTER·IMPORT_GCP_GKE_CLUSTER) */
  cluster: ScopeName.optional(),
  /** ECS 클러스터 이름 (예전 IMPORT_AWS_ECS_CLUSTER) */
  ecsCluster: ScopeName.optional(),
  /** DB: RDS 인스턴스·Aurora 클러스터 / Cloud SQL 인스턴스 / CNPG "네임스페이스/이름" (예전 IMPORT_AWS_DB_ID·IMPORT_GCP_SQL_INSTANCE·IMPORT_ONPREM_CNPG) */
  database: ScopeName.optional(),
}).strict();
export type SourceScope = z.infer<typeof SourceScope>;

// 화면이 받는 이전 한 건
export const MigrationView = z.object({
  id: z.uuid(),
  status: MigrationStatus,
  version: z.number().int(),
  sourceEnvId: z.uuid(),
  targetEnvId: z.uuid(),
  pausedFrom: MigrationStatus.nullable(),
  failedAtStatus: MigrationStatus.nullable(),
  failureCode: z.string().nullable(),
  rollbackWindowEndsAt: z.string().nullable(),
  /** K-1: 이전을 만들 때 정한 출발 범위 (없으면 {} = 자동으로 고름). optional = 예전 응답 모양과도 맞게 */
  sourceScope: SourceScope.optional(),
  updatedAt: z.string(),
}).strict();
export type MigrationView = z.infer<typeof MigrationView>;

// 처리기가 advance()에 넘기는 증거. 아직 표가 없는 사실(점검 결과, Argo 상태, 복제 지연 등)은
// 부르는 쪽이 재서 넘기고, 감사 기록 detail에 그대로 남는다. 조건 판정은 packages/core/src/guards.ts
export const TransitionEvidence = z.object({
  precheckBlockers: z.number().optional(),   // T05/T06 점검 결과 block 개수
  planHash: z.string().optional(),   // T09 사람이 본 계획 지문
  staleReason: z.enum(["expired", "env_changed"]).optional(),   // T11
  applyOk: z.boolean().optional(),   // T17 Terraform apply 성공
  argoHealthy: z.boolean().optional(),   // T20 Argo Synced+Healthy (온프레는 Agent "넣었음")
  rehearsal: RehearsalEvidence.optional(),   // T20 커밋 전 vCluster 리허설 (통과·재사용·건너뜀 이유)
  // T20 보안 동등성 MG-2-07: true = 쟀고 지켜짐, false = 쟀고 나빠짐, "not_measured" = 이 배포에서 출발·도착 보안을 맞대어 잰 근거가 없음
  securityParity: z.union([z.boolean(), z.literal("not_measured")]).optional(),
  replicationLagBytes: z.number().optional(),   // T21 복제 지연
  rowCountMatch: z.boolean().optional(),
  markerRoundTripMs: z.number().optional(),   // T21 마커 한 줄이 출발→도착에 보이기까지 ms
  snapshotDone: z.boolean().optional(),       // T21 초기 스냅샷 복사 완료   // T21 행 수 일치
  weightPct: z.number().optional(),   // T22 도착 가중치
  observedSec: z.number().optional(),   // T22 100%에서 관찰한 초
  targetLogsSeen: z.boolean().optional(),   // T22 도착 로그 수신 MG-3-04
  cutoverStepsOk: z.boolean().optional(),   // T23 컷오버 C1~C6 성공
  revertOk: z.boolean().optional(),   // T24 C6' 되돌림 성공
  cleanupApproved: z.boolean().optional(),   // T26 정리 계획 승인
  tempResources: z.number().optional(),   // T27 임시 자원 장부 줄 수
  operateRoleRevoked: z.boolean().optional(),   // T27 실행 역할 회수
  guardrailRule: z.string().optional(),   // T30 발동한 가드레일 규칙 번호
  ruleCleared: z.boolean().optional(),   // T31 발동 규칙이 초록으로 돌아왔나
  sourceWeight100: z.boolean().optional(),   // T35 출발 100%
  sourceHealthy: z.boolean().optional(),   // T35 출발 헬스 OK
  manualCleanupConfirmed: z.boolean().optional(),   // T38 수동 정리 확인
  failureDecision: z.enum(["retry", "rollback"]).optional(),   // Jeong 11/4 01:53Z: failed 질문에 사람이 고른 답
  reason: z.string().optional(),   // 사람이 적은 이유 (감사용)
}).strict();
export type TransitionEvidence = z.infer<typeof TransitionEvidence>;

// PF TRF-21: 이전마다 트래픽 LB 자리 (db 0041 migration_traffic_targets). 없으면 워커는 .env (TRAFFIC_LB_ID 등)
export const TrafficTarget = z.object({
  provider: z.enum(["cloudflare", "gcp_gclb", "aws_alb", "mock"]),
  lbId: z.string().min(1).max(200),
  sourcePoolId: z.string().max(200).nullable().optional(),
  targetPoolId: z.string().max(200).nullable().optional(),
  zoneId: z.string().max(200).nullable().optional(),
}).strict();
export type TrafficTarget = z.infer<typeof TrafficTarget>;

// Jeong 11/4 01:53Z: failed 질문("재시도할까?")의 답. POST /migrations/:id/failure-decision
//   retry = 실패한 단계(failed_at_status)부터 그 단계 작업을 다시 넣는다 / rollback = 만든 자원이 있으면 rolling_back(트래픽 출발 → 지우기), 없으면 cancelled
export const FailureDecisionInput = z.object({
  choice: z.enum(["retry", "rollback"]),
  reason: z.string().max(500).optional(),
  acceptCustomerCost: z.boolean().optional(),   // PA5a: 재시도 한도 이상이면 true 필요 (retry 만)
}).strict();
export type FailureDecisionInput = z.infer<typeof FailureDecisionInput>;
export const FailureDecisionResult = z.object({
  id: z.uuid(),
  from: z.literal("failed"),
  choice: z.enum(["retry", "rollback"]),
  status: MigrationStatus,          // 옮겨 간 상태
  queue: z.string().nullable(),     // 다시 넣은 작업 큐 (cancelled 면 null)
  jobQueued: z.boolean(),           // 같은 작업 키가 이미 대기 중이면 false (그 작업이 같은 일을 함)
}).strict();
export type FailureDecisionResult = z.infer<typeof FailureDecisionResult>;
