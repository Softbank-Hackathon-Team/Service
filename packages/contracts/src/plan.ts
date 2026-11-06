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
// G7-4: provision_reuse = 새로 만들지 않고 이미 있는 도착 자원을 다시 씀 (imported.json). 사람이 그 사실을 보고 확인
// substitute = 출발 상품을 도착의 다른 상품으로 바꿈 (도착 Builder substitutionsV2 승인 행)
export const PlanAckKind = z.enum(["cost", "failure_cost_policy", "runtime_change", "build", "precheck_warn", "low_confidence", "tls_relaxed", "host_access", "public_bucket", "provision_reuse", "env_layer_create", "substitute"]);   // env_layer_create: 도착 GKE 를 새로 만든다 (비용)   // SSL-1: tls_relaxed, HN-1: host_access, B-2: public_bucket
export type PlanAckKind = z.infer<typeof PlanAckKind>;
export const PlanAcknowledgement = z.object({
  id: z.string().min(1),                // 승인 본문 acks 가 이 id 를 덮어야 한다 (예: cost, runtime_change:<자원 id>)
  kind: PlanAckKind,
  text: z.string(),
  ref: z.string().optional(),           // 가리키는 것 (자원 id, 점검 id)
  // substitute 항목만: 화면이 글을 파싱하지 않고 출발 → 도착 대응 카드를 그리는 칸 (ApprovalRowV2 의 같은 이름 칸 그대로)
  from: z.string().optional(),
  to: z.string().optional(),
  lost: z.array(z.string()).optional(),
  appChange: z.boolean().optional(),
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
  // F8-4: 롤백 가능 창 길이(초). 사람이 계획을 승인할 때 같이 본다 (지문에 들어간다). 컷오버가 이 값으로 창 끝·정리 시작을 정한다.
  //   옛 계획서엔 없다 → core rollbackWindowSecFor 기본값. 환경변수 ROLLBACK_WINDOW_SEC 는 개발·시험용 덮어쓰기만
  rollbackWindowSec: z.number().int().min(0).max(7 * 86400).optional(),
  instances: z.array(ModuleInstance).optional(),   // 매트릭스 줄 module.<종류>["<id>"] (비용 고지·화면용)
  // G7-3 DRAFT(ai): 어느 계정·VPC·클러스터에 만드나 = Terraform 자리표시(<env:키>)에 들어갈 비밀 아닌 도착 사실. 계획 때 채운 값이 지문에 들어가고
  //   apply 가 다시 채운 값과 다르면 TF_PLAN_DRIFT. 계획 때 아무 값도 없으면(흉내 길) 칸 없음 = 예전 지문
  targetFacts: z.record(z.string().max(100), z.string().max(2000)).optional(),
  // G7-4: 이미 있는 도착 자원 재사용 (작업 폴더 imported.json). 있을 때만 칸. 자원 목록·출력 지문이 지문에 들어가고 apply 가 다시 읽어 비교
  provision: z.object({
    mode: z.literal("reuse"),
    source: z.string().max(100),
    resources: z.array(z.string().max(300)).max(200),
    outputsHash: z.string(),
  }).strict().optional(),
  // 환경 층 (도착 GCP 프로젝트의 VPC·GKE·AR·ESO, worker env-layer.ts). 환경 층 DB 사실을 쓰거나(existing) 이 apply 가 만들 때(create)만 칸.
  //   TF_FACT_* 로 사실을 받는 예전 길·흉내 길은 칸 없음 = 예전 지문 그대로.
  //   create: 계획 때는 클러스터 이름·네트워크를 모른다 → apply 는 그 키를 targetFacts 비교에서 빼고 varsHash(모듈 입력 지문)·moduleDigest 로 대조
  envLayer: z.object({
    mode: z.enum(["existing", "create"]),
    moduleDigest: z.string().max(100),
    varsHash: z.string().max(100).optional(),   // create 일 때만
    notice: z.string().max(500).optional(),     // create 일 때만: 사람이 보는 고지
  }).strict().optional(),
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
