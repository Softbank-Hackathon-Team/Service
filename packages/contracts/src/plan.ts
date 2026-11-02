import { z } from "zod";
import { ModuleInstance } from "./target.js";

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

// PA4 (계획 26 · A4): 계획서에 싣는 비용 요약. 회의 D5 "처음 전체 비용 고지" = 승인 때 이 값을 보고 cost 항목에 확인한다
// DRAFT(ai): 금액은 월(USD). delta = 도착 - 출발 (양수 = 더 듦). 계산 못 한 칸은 null + unknownFields 에 이름("*" = 전체 실패)
export const PlanCostSummary = z.object({
  currency: z.literal("USD"),
  monthlyTarget: z.number().nullable(),
  monthlySource: z.number().nullable(),
  deltaMonthly: z.number().nullable(),
  unknownFields: z.array(z.string()),
  priceAsOf: z.string().optional(),     // 가격표 기준일
  stub: z.boolean().optional(),         // true = 가짜 고정값 (진짜 계산이 아님)
}).strict();
export type PlanCostSummary = z.infer<typeof PlanCostSummary>;

// PA4: 승인할 때 사람이 하나씩 확인해야 하는 항목 종류 (계획 26 3.1)
//   cost·failure_cost_policy = 항상 / runtime_change·build = IR v2 승인 행 / precheck_warn = 사전 점검 warn / low_confidence = 문턱값(A3)
export const PlanAckKind = z.enum(["cost", "failure_cost_policy", "runtime_change", "build", "precheck_warn", "low_confidence"]);
export type PlanAckKind = z.infer<typeof PlanAckKind>;
export const PlanAcknowledgement = z.object({
  id: z.string().min(1),                // 승인 본문 acks 가 이 id 를 덮어야 한다 (예: cost, runtime_change:<자원 id>)
  kind: PlanAckKind,
  text: z.string(),
  ref: z.string().optional(),           // 가리키는 것 (자원 id, 점검 id)
}).strict();
export type PlanAcknowledgement = z.infer<typeof PlanAcknowledgement>;

// 사람이 승인하는 계획서. planHash는 이 전체의 지문이다
// PA4: specVersion·costSummary·acknowledgements 는 optional (DB 의 옛 계획서도 그대로 parse). 있으면 지문에 들어간다
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
  specVersion: z.number().int().positive().optional(),
  costSummary: PlanCostSummary.optional(),
  acknowledgements: z.array(PlanAcknowledgement).optional(),
  // TA3 (설계 27번 3.5, A3): PLAN_IR=v2 로 만든 계획서만 이 세 칸을 싣는다. v1 계획서 body 엔 키 자체가 없다(지문 보존).
  //   apply·deploy 는 깃발이 아니라 이 칸으로 길을 고른다 (승인 뒤 깃발을 바꿔도 승인한 길 그대로)
  //   specSource: spec_v2 = 가져오기가 저장한 v2, upconvert = v1 판을 올린 것 (spec_v2 없음)
  irVersion: z.literal("2").optional(),
  specSource: z.enum(["spec_v2", "upconvert"]).optional(),
  instances: z.array(ModuleInstance).optional(),   // 매트릭스 줄 module.<종류>["<id>"] (비용 고지·화면용)
  planHash: z.string(),
  expiresAt: z.string(),
}).strict();
export type PlanDoc = z.infer<typeof PlanDoc>;

// 승인 요청 본문
export const ApprovalInput = z.object({
  decision: z.enum(["approve", "reject"]),
  planHash: z.string(),
  reason: z.string().max(500).optional(),
  // PA4: 확인한 항목 id 목록. 깃발 PLAN_ACKS=1 이면 approve 때 계획서 acknowledgements id 를 전부 덮어야 한다 (reject 는 안 봄)
  acks: z.array(z.string().min(1).max(200)).max(500).optional(),
}).strict();
export type ApprovalInput = z.infer<typeof ApprovalInput>;

// PA4: 실행 시작 본문. 깃발 PLAN_ACKS=1 이면 planHash 가 승인 기록의 지문과 같아야 한다 (비용 드는 apply 직전 두 번째 게이트)
//   깃발 off 면 본문 없이 보내도 된다 (지금 화면·smoke 그대로)
// SMOKEFIX: smoke·화면은 본문 없는 POST 에 "{}" 를 싣는다 → planHash 필수면 400 이 났다. 그래서 칸은 선택.
//   깃발 on 일 때 "없음"은 라우트가 409 PLAN_HASH_MISMATCH("planHash required")로 막는다 (26번 A4 기준 409)
export const StartInput = z.object({
  planHash: z.string().min(1).optional(),
}).strict();
export type StartInput = z.infer<typeof StartInput>;
