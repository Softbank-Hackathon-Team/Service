import { z } from "zod";
import { Provider } from "./common.js";
import { AppSpecV2 } from "./spec-v2.js";

// 비용 추정 계약: POST /api/v1/cost/estimate 입출력, price_catalog 한 줄. 계산은 packages/cost

// 가격이 붙는 덩어리. 설계 초안 5장 "네 덩어리" + 크레딧 + 온프레 고정비
export const PriceItem = z.enum([
  "cluster",        // 클러스터 관리비 (시간당)
  "cluster_credit", // 관리비 무료 크레딧 (월, 음수로 쓰지 않고 양수로 적는다)
  "node",           // 노드 1대 (시간당). attrs에 vcpu, memGiB
  "db",             // 관리형 Postgres (월)
  "storage",        // DB 스토리지 (GB·월)
  "fixed",          // 온프레 고정비 (월). attrs에 capVcpu
  // 아래 셋은 가격표에만 싣고 합계에는 아직 넣지 않는다 (packages/cost/README "가격 수집" 참고)
  "lb",             // 로드 밸런서 1개 (시간당). 기본 인그레스가 cloudflared 터널이라 합계 제외
  "lb_capacity",    // 로드 밸런서 용량 단위 LCU (시간당)
  "volume",         // 노드 디스크 블록 스토리지 (GB·월). TODO(human): 노드당 루트 디스크 크기 정하면 합계에 넣기
  // 근거 있는 비용 내역(cost-evidence.ts)이 쓰는 줄. 예전 합계(estimateCost)는 이 줄을 보지 않는다
  //   node·db 는 예전 합계가 후보로 훑는 줄이라 늘리면 예전 금액이 바뀐다 → 실자원 단가 찾기용은 따로 둔다
  "instance",       // VM 1대 (시간당). 실자원에서 읽은 인스턴스 종류의 단가. attrs 에 vcpu, memGiB
  "db_class",       // 관리형 Postgres 등급 1개 (시간당). attrs 에 vcpu, memGiB, multiAz
  "public_ip",      // 쓰는 공인 IPv4 1개 (시간당)
  "nat",            // NAT 게이트웨이 1개 (시간당). 처리 GB 요금은 사용량을 몰라 합계 밖
  "db_vcpu",        // 관리형 Postgres vCPU 1개 (시간당). 등급 이름에서 vCPU·메모리를 읽는 벤더(GCP Cloud SQL)
  "db_mem",         // 관리형 Postgres 메모리 1 GiB (시간당)
]);
export type PriceItem = z.infer<typeof PriceItem>;

export const PriceUnit = z.enum(["hour", "month", "gb_month"]);

// 근거 표시. 화면에서 "미확인" 배지를 붙이는 데 쓴다
export const Evidence = z.enum(["fact", "unverified", "assumed", "mock"]);
export type Evidence = z.infer<typeof Evidence>;

// price_catalog 표 한 줄 (설계 초안 4장 "저장 방식")
export const PriceRow = z.object({
  vendor: Provider,
  region: z.string(),
  item: PriceItem,
  sku: z.string(),
  unit: PriceUnit,
  usd: z.number().nonnegative(),
  tierFrom: z.number().nonnegative().default(0),
  attrs: z.object({
    vcpu: z.number().positive().optional(),
    memGiB: z.number().positive().optional(),
    capVcpu: z.number().positive().optional(),
    multiAz: z.boolean().optional(),   // db 줄: 다중 AZ(대기 복제본 포함) 가격인가
  }).strict().default({}),
  evidence: Evidence,
  source: z.string(),          // 출처 한 줄 (문서 이름, API 이름)
  fetchedAt: z.iso.datetime({ offset: true }),
  // 근거를 화면에 보이려고 더한 칸 (없으면 source 한 줄만)
  sourceUrl: z.string().optional(),      // 사람이 열어 볼 수 있는 주소 (API 키 없는 것만)
  sourceKind: z.enum(["official_api", "official_page", "secondary", "assumption"]).optional(),
}).strict();
export type PriceRow = z.infer<typeof PriceRow>;
export type PriceRowInput = z.input<typeof PriceRow>;

export const PriceCatalog = z.object({
  asOf: z.iso.datetime({ offset: true }), // 가격 기준일
  rows: z.array(PriceRow),
}).strict();
export type PriceCatalog = z.infer<typeof PriceCatalog>;

// 부하 -> 자원 파라미터 (사전 측정값 자리, 설계 초안 9장)
export const LoadParams = z.object({
  baseVcpu: z.number().nonnegative().default(0.5),
  vcpuPerRps: z.number().nonnegative().default(0.01),
  utilTarget: z.number().gt(0).max(1).default(0.6),
  minNodes: z.number().int().min(1).default(2),
  maxNodes: z.number().int().min(1).default(20),
  source: z.enum(["preset", "measured"]).default("preset"),
}).strict();
export type LoadParams = z.infer<typeof LoadParams>;

// MAU -> 피크 rps 계수 (설계 초안 3장)
export const TrafficAssumption = z.object({
  mau: z.number().nonnegative(),
  dauRatio: z.number().gt(0).max(1).default(0.2),
  reqPerUserDay: z.number().nonnegative().default(50),
  peakFactor: z.number().min(1).default(3),
}).strict();
export type TrafficAssumption = z.infer<typeof TrafficAssumption>;

export const SecurityProfileName = z.enum(["startup", "finance"]);
export type SecurityProfileName = z.infer<typeof SecurityProfileName>;

export const SecurityLevel = z.enum(["basic", "hardened"]);
export type SecurityLevel = z.infer<typeof SecurityLevel>;

// 비용 추론 요청 (POST /v1/cost/estimate 본문 후보)
export const CostEstimateRequest = z.object({
  spec: AppSpecV2,
  from: Provider.optional(),                  // 지금 환경. 있으면 절약액 계산
  targets: z.array(Provider).min(1).default(["aws", "gcp", "onprem"]),
  region: z.string().default("ap-northeast-2"),
  traffic: z.union([
    z.object({ peakRps: z.number().nonnegative() }).strict(),
    TrafficAssumption,
  ]),
  profile: SecurityProfileName.default("startup"),
  applyCredits: z.boolean().default(true),
  load: LoadParams.default(LoadParams.parse({})),
  nodeSkus: z.array(z.string()).optional(),   // 후보 노드 종류 제한 (없으면 가격표 전부)
}).strict();
export type CostEstimateRequest = z.infer<typeof CostEstimateRequest>;
export type CostEstimateRequestInput = z.input<typeof CostEstimateRequest>;

export const CostParts = z.object({
  cluster: z.number(),
  nodes: z.number(),
  db: z.number(),
  storage: z.number(),
  fixed: z.number(),
}).strict();
export type CostParts = z.infer<typeof CostParts>;

// 환경 하나의 최저안
export const EnvEstimate = z.object({
  provider: Provider,
  feasible: z.boolean(),
  reason: z.string().optional(),         // 예: ONPREM_CAPACITY_EXCEEDED, PRICE_MISSING
  nodeSku: z.string().nullable(),
  nodes: z.number().int(),
  monthlyUsd: z.number().nullable(),     // 크레딧 반영. 불가능한 안이면 null
  monthlyUsdNoCredit: z.number().nullable(),
  creditUsd: z.number(),
  parts: CostParts,
  unknown: z.array(z.string()),          // 가격 없는 덩어리 → 합계에서 빠짐
  unverified: z.array(z.string()),       // 근거가 미확인/추정인 덩어리
  candidatesEvaluated: z.number().int(),
}).strict();
export type EnvEstimate = z.infer<typeof EnvEstimate>;

export const Recommendation = z.object({
  rank: z.number().int(),
  provider: Provider,
  security: SecurityLevel,
  monthlyUsd: z.number(),
  score: z.number(),
  scoreParts: z.object({ cost: z.number(), risk: z.number(), time: z.number() }).strict(),
}).strict();
export type Recommendation = z.infer<typeof Recommendation>;

export const Breakpoint = z.object({
  fromRps: z.number(),
  cheapest: Provider,
  nodes: z.number().int(),
}).strict();
export type Breakpoint = z.infer<typeof Breakpoint>;

export const CostEstimate = z.object({
  priceAsOf: z.string(),
  priceStale: z.boolean(),               // 7일 넘게 못 받음 → 경고만, 승인은 막지 않음
  peakRps: z.number(),
  requiredVcpu: z.number(),
  load: LoadParams,
  profile: SecurityProfileName,
  envs: z.array(EnvEstimate),
  cheapest: Provider.nullable(),
  savings: z.object({
    from: Provider,
    to: Provider,
    monthlyUsd: z.number(),
    creditPortionUsd: z.number(),        // 절약액 중 크레딧 몫 (설계 초안 6장: $80.6 중 $73)
  }).strict().nullable(),
  recommendations: z.array(Recommendation),
  breakpoints: z.array(Breakpoint),
}).strict();
export type CostEstimate = z.infer<typeof CostEstimate>;

// ---- 비용 추정 저장 (DRAFT(ai), 작업 V 제안) ----
// 저장 위치: 별도 표 cost_estimates (db/migrations/0006_cost_estimates.sql).
// plans.plan_doc 안에 넣지 않는 이유: planHash가 plan_doc 전체의 지문이라, 가격표가 하루 한 번 바뀔 때마다
// 다시 추정하면 승인받은 계획의 지문이 깨진다. 추정은 여러 번 쌓이고(가격 갱신, 트래픽 가정 변경) 계획은 하나다.
// 승인 화면이 보여 준 추정은 plan_id로 묶어 남긴다. 리포트(GET /migrations/:id/report)는
// "그 이전의 plan_id가 붙은 가장 최근 추정, 없으면 이전 전체에서 가장 최근 추정"을 읽는다.

// 가격표가 어디서 왔는지 (packages/cost/prices/*.json 머리 정보 요약)
export const PriceSourceSummary = z.object({
  vendor: Provider,
  origin: z.enum(["live", "seed", "sample"]), // live: API에서 받음, seed: 샘플값 복사, sample: 캐시 없음
  fetchedAt: z.string(),
  urls: z.array(z.string()),                  // 비밀값(API 키) 없는 주소만
}).strict();
export type PriceSourceSummary = z.infer<typeof PriceSourceSummary>;

export const StoredCostEstimate = z.object({
  id: z.uuid(),
  migrationId: z.uuid(),
  planId: z.uuid().nullable(),        // 승인 화면에서 쓴 추정이면 계획 번호, 미리보기면 null
  request: CostEstimateRequest,
  estimate: CostEstimate,
  priceSources: z.array(PriceSourceSummary),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();
export type StoredCostEstimate = z.infer<typeof StoredCostEstimate>;
