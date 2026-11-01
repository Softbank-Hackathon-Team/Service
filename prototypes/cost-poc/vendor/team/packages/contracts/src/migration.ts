import { z } from "zod";

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

export const TERMINAL: readonly MigrationStatus[] =
  ["completed", "rolled_back", "cancelled"];

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
  securityParity: z.boolean().optional(),   // T20 보안 동등성 MG-2-07
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
  reason: z.string().optional(),   // 사람이 적은 이유 (감사용)
}).strict();
export type TransitionEvidence = z.infer<typeof TransitionEvidence>;
