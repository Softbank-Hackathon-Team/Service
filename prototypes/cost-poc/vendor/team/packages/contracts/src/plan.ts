import { z } from "zod";

// 사전 점검 한 줄
export const PrecheckItem = z.object({
  id: z.string(),                   // 예: PC-01
  level: z.enum(["block", "warn", "info"]),
  message: z.string(),
  fix: z.string().optional(),
}).strict();
export type PrecheckItem = z.infer<typeof PrecheckItem>;

// 계획서의 단계 하나
export const PlanStep = z.object({
  id: z.enum(["provision", "deploy", "sync", "shift", "cutover", "cleanup"]),
  owner: z.enum(["terraform", "argocd", "agent", "worker"]),
  estSec: z.number().int().positive().optional(),
  gate: z.string().optional(),
  weights: z.array(z.number().int()).optional(),
  holdSec: z.number().int().optional(),
  rollback: z.string().optional(),
}).strict();

// 사람이 승인하는 계획서. planHash는 이 전체의 지문이다
export const PlanDoc = z.object({
  planId: z.uuid(),
  migrationId: z.uuid(),
  adapterVersion: z.string(),
  steps: z.array(PlanStep),
  precheck: z.array(PrecheckItem),
  rollbackCriteria: z.object({
    errorRatePct: z.number(),       // 1
    p95Multiplier: z.number(),      // 2
    windowSec: z.number().int(),    // 30
  }).strict(),
  tfPlanHash: z.string(),
  helmValuesHash: z.string(),
  planHash: z.string(),
  expiresAt: z.string(),
}).strict();
export type PlanDoc = z.infer<typeof PlanDoc>;

// 승인 요청 본문
export const ApprovalInput = z.object({
  decision: z.enum(["approve", "reject"]),
  planHash: z.string(),
  reason: z.string().max(500).optional(),
}).strict();
export type ApprovalInput = z.infer<typeof ApprovalInput>;
