import { z } from "zod";
import { Provider } from "./common.js";
import { Evidence, PriceItem, PriceUnit } from "./cost.js";
import { SourceScope } from "./migration.js";

// 근거 있는 비용 내역. 숫자 하나마다 "어느 자원을 몇 개 셌나(basis)"와 "그 단가는 어디서 왔나(price)"를 같이 싣는다.
//   GET  /api/v1/environments/:id/cost       — 지금 이 환경이 한 달에 얼마 드는가 (실자원 조회 결과로 셈)
//   POST /api/v1/environments/:id/cost/move  — 이 환경(의 범위)을 도착 후보로 옮기면 한 달·1년에 얼마인가 (+ 프로모션)
// 계산은 packages/cost (footprint.ts → breakdown.ts → promotions.ts). 청구서가 아니라 공개 가격표로 낸 추정이다.

/**
 * 실자원 조회(adapters inventory.ts)가 비용 계산용으로 같이 남기는 사실. 화면의 자원 묶음(groups)과 따로 둔다.
 * 읽기 명령이 실패해도 환경 건강(ok·partial)에 영향을 주지 않고 errors 에만 남는다. 모르는 칸은 null (지어내지 않음)
 */
export const BillingFacts = z.object({
  clusters: z.array(z.object({
    name: z.string(),
    location: z.string().nullable(),
    zonal: z.boolean().nullable(),          // GKE: 위치가 존이면 true (무료 등급 대상). EKS 는 null
    autopilot: z.boolean().nullable(),
    nodeCount: z.number().int().nullable(),
    machineTypes: z.array(z.string()),      // GKE 노드 풀 머신 종류 (EKS 는 빈 목록, 노드는 instances 에서 셈)
  }).strict()),
  instances: z.array(z.object({
    name: z.string(),
    type: z.string(),                       // t3.medium, e2-standard-2 …
    state: z.string().nullable(),
    spot: z.boolean(),
    cluster: z.string().nullable(),         // EKS·GKE 노드면 클러스터 이름 (태그·라벨)
    publicIp: z.string().nullable(),
  }).strict()),
  databases: z.array(z.object({
    name: z.string(),
    engine: z.string().nullable(),
    cls: z.string().nullable(),             // db.t3.medium, db-custom-2-7680 …
    storageGb: z.number().nullable(),
    storageType: z.string().nullable(),
    multiAz: z.boolean().nullable(),        // RDS MultiAZ, Cloud SQL availabilityType REGIONAL
  }).strict()),
  loadBalancers: z.array(z.object({
    name: z.string(),
    type: z.string().nullable(),            // application · network · (GCP) 부하 분산 방식
    internetFacing: z.boolean().nullable(),
    zones: z.number().int().nullable(),     // AWS: 공인 LB 는 AZ 마다 공인 IPv4 하나
  }).strict()),
  natGateways: z.array(z.object({ name: z.string(), state: z.string().nullable(), publicIps: z.array(z.string()) }).strict()),
  addresses: z.array(z.object({ name: z.string(), ip: z.string().nullable(), inUse: z.boolean() }).strict()),   // 고정 공인 주소 (EIP·정적 외부 IP)
  errors: z.array(z.string()),              // 못 읽은 명령과 이유
}).strict();
export type BillingFacts = z.infer<typeof BillingFacts>;

/** 수량의 근거. inventory = 실자원 조회로 센 것, mapped = 출발 자원을 도착 상품으로 바꾼 것, assumption = 재지 않고 정한 값 */
export const CostBasis = z.object({
  kind: z.enum(["inventory", "mapped", "assumption"]),
  text: z.string(),                     // 사람이 읽는 한 줄 (예: "EC2 인스턴스 2개 (t3.medium, 실행 중)")
  refs: z.array(z.string()),            // 센 실자원 이름 (없으면 빈 목록)
}).strict();
export type CostBasis = z.infer<typeof CostBasis>;

/** 단가의 근거 (가격표 한 줄) */
export const CostPriceRef = z.object({
  item: PriceItem,
  sku: z.string(),
  unitUsd: z.number(),
  unit: PriceUnit,
  evidence: Evidence,
  sourceKind: z.enum(["official_api", "official_page", "secondary", "assumption"]),
  source: z.string(),                   // 출처 한 줄 (API·SKU·발행 시각)
  sourceUrl: z.string().nullable(),
  fetchedAt: z.string(),
}).strict();
export type CostPriceRef = z.infer<typeof CostPriceRef>;

export const CostGroup = z.enum(["cluster", "compute", "database", "storage", "network", "fixed"]);
export type CostGroup = z.infer<typeof CostGroup>;

/** 합계의 한 항 = 수량 x 단가 x 시간 */
export const CostLine = z.object({
  id: z.string(),                       // 예: "node:t3.medium", "db:shop-db"
  group: CostGroup,
  label: z.string(),                    // 예: "EKS 노드 t3.medium"
  quantity: z.number(),
  quantityUnit: z.string(),             // 예: "대", "GB", "개"
  hours: z.number().nullable(),         // 시간 단가면 730, 월 단가면 null
  monthlyUsd: z.number(),
  formula: z.string(),                  // 예: "2대 x $0.0520/시간 x 730시간"
  basis: CostBasis,
  price: CostPriceRef,
}).strict();
export type CostLine = z.infer<typeof CostLine>;

/** 합계에 넣지 못한 것과 그 이유 (단가를 지어내지 않는다) */
export const CostGap = z.object({
  id: z.string(),
  label: z.string(),
  reason: z.string(),
  estimateUsd: z.number().nullable(),   // 참고로 보일 수 있는 크기 (가정). 합계에는 안 들어감
}).strict();
export type CostGap = z.infer<typeof CostGap>;

export const CostBreakdown = z.object({
  provider: Provider,
  region: z.string(),                   // 가격을 읽은 리전 (벤더 이름)
  monthlyUsd: z.number(),               // 정가 합계 (프로모션 전)
  lines: z.array(CostLine),
  gaps: z.array(CostGap),
  priceAsOf: z.string(),
}).strict();
export type CostBreakdown = z.infer<typeof CostBreakdown>;

/**
 * 프로모션 하나와 이 견적에 적용한 결과.
 * applied = 조건 없이 이 견적에 들어감 (예: GKE 무료 등급), conditional = 조건을 채우면 들어감 (예: 새 결제 계정),
 * not_applicable = 이 견적과 상관없음 (이유를 note 에)
 */
export const CostPromotion = z.object({
  id: z.string(),
  provider: Provider,
  title: z.string(),
  kind: z.enum(["recurring_credit", "trial_credit", "signup_credit", "program_credit", "data_transfer_waiver"]),
  status: z.enum(["applied", "conditional", "not_applicable"]),
  condition: z.string(),                // 누가 받을 수 있나
  appliesTo: z.string(),                // 어느 항에서 깎나 (예: "클러스터 관리비")
  firstYearUsd: z.number(),             // 이 견적의 첫 12개월에서 깎이는 금액
  monthlyUsd: z.array(z.number()).length(12),   // 1~12번째 달에 깎이는 금액
  validUntil: z.string().nullable(),    // 프로그램 기한 (없으면 null)
  sourceUrl: z.string(),
  checkedAt: z.string(),                // 이 내용을 공식 문서로 확인한 날
  note: z.string().nullable(),
}).strict();
export type CostPromotion = z.infer<typeof CostPromotion>;

/** 한 달·1년 기준 금액 */
export const CostProjection = z.object({
  monthlyUsd: z.number(),               // 정가 한 달
  yearlyUsd: z.number(),                // 정가 12개월
  appliedYearlyUsd: z.number(),         // applied 프로모션만 뺀 12개월
  conditionalYearlyUsd: z.number(),     // applied + conditional 을 다 뺀 12개월 (조건을 채웠을 때)
  appliedMonthlyUsd: z.number(),        // applied 프로모션을 뺀 평소 한 달 (12번째 달 기준)
  promotions: z.array(CostPromotion),
}).strict();
export type CostProjection = z.infer<typeof CostProjection>;

const EnvHead = z.object({ envId: z.uuid(), name: z.string(), provider: Provider }).strict();

/** GET /environments/:id/cost */
export const EnvCostView = EnvHead.extend({
  status: z.enum(["ok", "partial", "unavailable"]),   // partial = 일부 자원을 못 읽어 합계가 낮을 수 있음
  reason: z.string().nullable(),
  inventoryCheckedAt: z.string().nullable(),          // 실자원을 읽은 시각
  breakdown: CostBreakdown.nullable(),
  projection: CostProjection.nullable(),
}).strict();
export type EnvCostView = z.infer<typeof EnvCostView>;

/** 출발 자원 하나가 도착에서 무엇으로 바뀌었나 (같은 크기 이상 중 가장 싼 것) */
export const CostMapping = z.object({
  group: CostGroup,
  from: z.string(),                     // 예: "t3.medium x 2 (2 vCPU, 4 GiB)"
  to: z.string().nullable(),            // 예: "e2-medium x 2 (2 vCPU, 4 GiB)". 대응 상품이 없으면 null
  why: z.string(),
}).strict();
export type CostMapping = z.infer<typeof CostMapping>;

/** POST /environments/:id/cost/move 본문 */
export const MoveCostRequest = z.object({
  targetEnvIds: z.array(z.uuid()).min(1).max(10),
  sourceScope: SourceScope.optional(),  // 새 마이그레이션 화면에서 고른 출발 범위 (없으면 환경 전체)
}).strict();
export type MoveCostRequest = z.infer<typeof MoveCostRequest>;

export const MoveCostTarget = EnvHead.extend({
  feasible: z.boolean(),
  reason: z.string().nullable(),        // 계산 못 한 이유
  breakdown: CostBreakdown.nullable(),
  projection: CostProjection.nullable(),
  mappings: z.array(CostMapping),
  deltaMonthlyUsd: z.number().nullable(),   // 출발 정가 - 도착 정가. 양수 = 아낌
}).strict();
export type MoveCostTarget = z.infer<typeof MoveCostTarget>;

export const MoveCostView = z.object({
  source: EnvCostView,                  // 범위로 줄인 출발 (sourceScope 가 있으면 그 범위만)
  scopeNote: z.string().nullable(),     // 범위로 줄일 때 생긴 단서 (예: 네임스페이스로는 노드를 나눌 수 없음)
  targets: z.array(MoveCostTarget),
}).strict();
export type MoveCostView = z.infer<typeof MoveCostView>;
