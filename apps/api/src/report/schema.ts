import { z } from "zod";
import { Measurement, MigrationStatus, PrecheckItem, DeployResult } from "@svc/contracts";

// 증적 리포트: 이전 한 건이 "어떻게 진행됐고, 누가 승인했고, 숫자가 얼마였고, 기록이 조작되지 않았나"를 한 장으로.
// DRAFT(ai): 경계 계약이라 원래 packages/contracts에 둬야 한다. 공유 파일(contracts/src/index.ts)을
// 이 작업에서 고치지 않으려고 임시로 api 안에 둔다. 통합 때 contracts/src/report.ts로 옮긴다 (CHANGES.md 참고)

// DB에서 읽은 감사 한 줄 (hash 재계산에 필요한 칸 전부)
export const AuditRow = z.object({
  seq: z.number().int(),
  tenantId: z.string(),
  at: z.string(),
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  result: z.enum(["ok", "denied", "error"]),
  detail: z.record(z.string(), z.unknown()),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditRow = z.infer<typeof AuditRow>;

export const ChainCheck = z.object({
  ok: z.boolean(),
  checked: z.number().int(),          // 다시 계산해 본 줄 수
  firstSeq: z.number().int().nullable(),
  lastSeq: z.number().int().nullable(),
  brokenAtSeq: z.number().int().nullable(),
  reason: z.enum(["hash_mismatch", "prev_link_broken", "not_from_genesis"]).nullable(),
  partial: z.boolean(),               // 회사 체인 앞부분을 다 못 읽음 (줄 수 상한)
}).strict();
export type ChainCheck = z.infer<typeof ChainCheck>;

export const TimelineStep = z.object({
  seq: z.number().int(),
  at: z.string(),
  from: MigrationStatus,
  to: MigrationStatus,
  actor: z.string(),
  action: z.string(),
  durationMs: z.number().int().nullable(),
  // from 상태에 머문 시간(ms 정수) = 앞 전이부터 이 전이까지. 첫 줄은 null
  // 이름은 관측성 타임라인(GET .../timeline)과 맞춘다
}).strict();
export type TimelineStep = z.infer<typeof TimelineStep>;

export const ApprovalEvidence = z.object({
  planId: z.string(),
  decision: z.enum(["approve", "reject"]),
  approvedBy: z.string(),
  at: z.string(),
  approvedPlanHash: z.string(),       // 사람이 본 지문
  storedPlanHash: z.string().nullable(), // 저장된 계획서 지문
  hashMatches: z.boolean(),
}).strict();
export type ApprovalEvidence = z.infer<typeof ApprovalEvidence>;

export const TrafficSummary = z.object({
  judgements: z.number().int(),
  steps: z.array(z.number().int()),   // 지나간 가중치(%)
  bad: z.number().int(),              // bad + bad_shortcut 판정 수
  maxTargetErrorRatePct: z.number().nullable(),
  maxTargetP95Ms: z.number().nullable(),
}).strict();

// 비용은 @svc/cost의 CostEstimate 전체가 아니라 화면에 쓸 요약만
export const CostSummary = z.object({
  priceAsOf: z.string(),
  priceStale: z.boolean(),
  cheapest: z.string().nullable(),
  envs: z.array(z.object({
    provider: z.string(),
    feasible: z.boolean(),
    monthlyUsd: z.number().nullable(),
    unverified: z.array(z.string()),
  }).strict()),
  savingsMonthlyUsd: z.number().nullable(),
}).strict();
export type CostSummary = z.infer<typeof CostSummary>;

export const EvidenceReport = z.object({
  reportVersion: z.literal(1),
  generatedAt: z.string(),
  migration: z.object({
    id: z.string(),
    status: MigrationStatus,
    source: z.object({ id: z.string(), provider: z.string(), name: z.string() }).strict(),
    target: z.object({ id: z.string(), provider: z.string(), name: z.string() }).strict(),
    failureCode: z.string().nullable(),
  }).strict(),
  summary: z.object({
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    totalMs: z.number().int().nullable(),
    transitions: z.number().int(),
    reachedCutover: z.boolean(),
    rolledBack: z.boolean(),
    deniedOrError: z.number().int(),
  }).strict(),
  integrity: ChainCheck,
  timeline: z.array(TimelineStep),
  approvals: z.array(ApprovalEvidence),
  precheck: z.array(PrecheckItem),
  measurements: z.array(Measurement),
  traffic: TrafficSummary.nullable(),
  deploy: DeployResult.nullable(),
  cost: CostSummary.nullable(),
  incidents: z.array(z.object({
    seq: z.number().int(), at: z.string(), actor: z.string(), action: z.string(),
    result: z.enum(["denied", "error"]), note: z.string(),
  }).strict()),
  gaps: z.array(z.string()),           // 리포트에 비어 있는 것 (숨기지 않고 적는다)
  reportHash: z.string(),              // reportHash 칸을 뺀 나머지의 지문
}).strict();
export type EvidenceReport = z.infer<typeof EvidenceReport>;
