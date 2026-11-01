import { z } from "zod";

// DRAFT(ai): 계산 코어의 입출력 계약. 네트워크와 파일 접근 없음.
// 수식 원본: 실측 기반 K8s 배치·이전 플랫폼 Kross 5장.

export const VendorId = z.enum(["aws", "gcp", "azure", "onprem"]);
export type VendorId = z.infer<typeof VendorId>;

export const ProfileSource = z.enum(["price-only", "sample", "observed", "measured"]);
export type ProfileSource = z.infer<typeof ProfileSource>;

const nonneg = z.number().finite().nonnegative();

// 카드의 입력 초안 { lambda, cpu, memGiB, egressGBh, storageGB }에 선택 칸을 더했다.
// cpu, memGiB: 앱 계층 사용량(여유분 전). dbCpu, dbMemGiB: DB 계층 사용량.
export const ResourcePoint = z.object({
  lambda: nonneg,
  cpu: nonneg,
  memGiB: nonneg,
  egressGBh: nonneg,
  storageGB: nonneg,
  gpu: nonneg.optional(),
  dbCpu: nonneg.optional(),
  dbMemGiB: nonneg.optional(),
  p95Ms: nonneg.optional(),
  errorRate: z.number().min(0).max(1).optional(),
}).strict();
export type ResourcePoint = z.infer<typeof ResourcePoint>;

export const ResourceProfile = z.object({
  source: ProfileSource,
  points: z.array(ResourcePoint).min(1),
  // 스토리지는 누적량이다: 요청 1건이 남기는 GB. r_storage(t) = storageGB + ∫ g λ(s) ds
  storageGrowthGBPerRequest: nonneg.default(0),
  note: z.string().optional(),
}).strict().superRefine((p, ctx) => {
  for (let i = 1; i < p.points.length; i++) {
    if (p.points[i]!.lambda <= p.points[i - 1]!.lambda) {
      ctx.addIssue({ code: "custom", message: "points.lambda는 순증가해야 한다", path: ["points", i, "lambda"] });
    }
  }
});
export type ResourceProfile = z.infer<typeof ResourceProfile>;
export type ResourceProfileInput = z.input<typeof ResourceProfile>;

// N: 노드 수를 정하는 자원. 스케줄러가 보는 요청량(cpuRequested)은 버스터블 노드 때문에 사용량(cpu)과 분리한다.
export const NKeys = ["cpu", "cpuRequested", "mem", "gpu"] as const;
export type NKey = (typeof NKeys)[number];

export const NodeType = z.object({
  sku: z.string(),
  hourly: nonneg,                 // p_v
  commit1yHourly: nonneg.optional(),
  capacity: z.object({            // a_{v,k}
    cpu: z.number().positive(),
    cpuRequested: z.number().positive().optional(),
    mem: z.number().positive(),
    gpu: nonneg.default(0),
  }).strict(),
  family: z.string().optional(),
}).strict();
export type NodeType = z.infer<typeof NodeType>;
export type NodeTypeInput = z.input<typeof NodeType>;

export const DbClass = z.object({
  sku: z.string(),
  hourly: nonneg,                 // q_{v,db}
  commit1yHourly: nonneg.optional(),
  capacity: z.object({ cpu: z.number().positive(), mem: z.number().positive() }).strict(),
}).strict();
export type DbClass = z.infer<typeof DbClass>;

export const EgressTier = z.object({ fromGB: nonneg, usdPerGB: nonneg }).strict();

export const VendorPricing = z.object({
  vendor: VendorId,
  region: z.string(),
  residency: z.string().default("KR"),
  fixedHourly: nonneg,            // F_v
  fixedItems: z.array(z.object({ name: z.string(), hourly: nonneg }).strict()).default([]),
  monthlyCreditUsd: nonneg.default(0), // 예: GKE 무료 등급. 고정비에서만 뺀다
  nodeTypes: z.array(NodeType).min(1),
  dbClasses: z.array(DbClass).default([]),
  dbOnNodes: z.boolean().default(false), // 온프레: CloudNativePG가 노드 안에서 돈다
  dbReplicasOnNodes: z.number().int().positive().default(1),
  storagePerGBMonth: nonneg,      // q_{v,storage} (달러/GB·월)
  egressPerGB: nonneg,            // q_{v,egress}: 월 계단을 무시한 대표 단가 (첫 유료 구간)
  egressTiers: z.array(EgressTier).default([]),
  minNodes: z.number().int().nonnegative().default(1),
  maxNodes: z.number().int().positive().optional(),
  capVcpuTotal: z.number().positive().optional(),   // 팀 가격표 onprem capVcpu 호환
  maxEgressGBh: z.number().positive().optional(),   // 회선 한도
  unknownItems: z.array(z.string()).default([]),    // 가격이 없어 0으로 계산한 항목
  evidence: z.record(z.string(), z.string()).default({}), // 항목 -> public | public-secondary | assumed
}).strict();
export type VendorPricing = z.infer<typeof VendorPricing>;
export type VendorPricingInput = z.input<typeof VendorPricing>;

// r_v를 만드는 θ 쪽 고정값
export const Sizing = z.object({
  targetUtil: z.number().gt(0).max(1).default(1),    // 여유분: r = 사용량 / targetUtil
  dbTargetUtil: z.number().gt(0).max(1).default(1),
  cpuRequestFloor: nonneg.default(0),                // replicas x requests.cpu
  memRequestFloorGiB: nonneg.default(0),
  systemCpu: nonneg.default(0),                      // 클러스터 애드온 몫 (가정)
  systemMemGiB: nonneg.default(0),
  hasDatabase: z.boolean().default(true),
}).strict();
export type Sizing = z.infer<typeof Sizing>;
export type SizingInput = z.input<typeof Sizing>;

export const Traffic = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("constant"), lambda: nonneg }).strict(),
  z.object({ kind: z.literal("diurnal"), peak: nonneg, troughRatio: z.number().min(0).max(1).default(0.2) }).strict(),
  z.object({ kind: z.literal("series"), hourly: z.array(nonneg).min(1) }).strict(),
]);
export type Traffic = z.infer<typeof Traffic>;
export type TrafficInput = z.input<typeof Traffic>;

export const Constraints = z.object({
  p95Ms: z.number().positive().optional(),
  errorRate: z.number().min(0).max(1).optional(),
  residency: z.array(z.string()).optional(),
  vendorSlo: z.record(z.string(), z.object({ p95Ms: nonneg.optional(), errorRate: nonneg.optional() }).strict()).optional(),
}).strict();
export type Constraints = z.infer<typeof Constraints>;

export const MigrationParams = z.object({
  engineerHours: nonneg.default(80),
  engineerUsdPerHour: nonneg.default(40),
  parallelRunDays: nonneg.default(7),
  sandboxHours: nonneg.default(8),
  llmUsd: nonneg.default(20),
  dataGB: nonneg.optional(),
  egressWaived: z.boolean().default(false),
  maxPaybackMonths: z.number().positive().default(12),
  minMonthlySavingUsd: nonneg.default(0),
  horizonMonths: z.number().positive().default(36),
}).strict();
export type MigrationParams = z.infer<typeof MigrationParams>;
export type MigrationParamsInput = z.input<typeof MigrationParams>;

export const Parts = z.object({
  fixed: z.number(), nodes: z.number(), db: z.number(), storage: z.number(), egress: z.number(),
}).strict();
export type Parts = z.infer<typeof Parts>;

export const Range = z.object({ base: z.number(), low: z.number(), high: z.number() }).strict();
export type Range = z.infer<typeof Range>;

export const CrossPoint = z.object({
  a: VendorId, b: VendorId,
  lambda: z.number(),
  // exact: 연속 구간에서 Cost_a = Cost_b, jump: 노드 계단에서 순서만 뒤집힘(등식이 성립하는 λ 없음), tie: 구간 동률
  kind: z.enum(["exact", "jump", "tie"]),
  toLambda: z.number().optional(),
  before: VendorId.nullable(),
  after: VendorId.nullable(),
}).strict();
export type CrossPoint = z.infer<typeof CrossPoint>;

export const EnvelopeSegment = z.object({ fromLambda: z.number(), toLambda: z.number(), vendor: VendorId.nullable() }).strict();
export type EnvelopeSegment = z.infer<typeof EnvelopeSegment>;

export const GradientReport = z.object({
  vendor: VendorId, lambda: z.number(), sku: z.string(),
  kStar: z.array(z.string()),
  tie: z.boolean(),
  belowMinNodes: z.boolean(),
  nodeTerm: z.number(),
  dbTerm: z.number(), storageTerm: z.number(), egressTerm: z.number(),
  total: z.number(),             // 오른쪽 미분 (동률이면 큰 쪽, 보수적)
  leftDerivative: z.number(),
  rightDerivative: z.number(),
}).strict();
export type GradientReport = z.infer<typeof GradientReport>;

export const Verdict = z.enum(["move", "stay", "insufficient-evidence"]);

export const Decision = z.object({
  verdict: Verdict,
  reason: z.string(),
  from: VendorId,
  to: VendorId.nullable(),
  monthlySavingUsd: Range.nullable(),
  oneTimeUsd: z.number().nullable(),
  oneTimeBreakdown: z.record(z.string(), z.number()).nullable(),
  paybackMonths: z.number().nullable(),
  horizonNetUsd: z.number().nullable(),
}).strict();
export type Decision = z.infer<typeof Decision>;

export const VendorEstimate = z.object({
  vendor: VendorId,
  feasible: z.boolean(),
  reason: z.string().optional(),
  nodeSku: z.string().nullable(),
  dbSku: z.string().nullable(),
  avgNodes: z.number(),
  peakNodes: z.number(),
  monthlyUsd: Range.nullable(),
  parts: Parts,
  integralUsd: z.number(),
  egressTierAdjustUsd: z.number(),
  creditUsd: z.number(),
  egressGB: z.number(),
  storageEndGB: z.number(),
  peakHourlyUsd: z.number().nullable(),
  probBest: z.number(),
  unknownItems: z.array(z.string()),
  constraintNotes: z.array(z.string()),
}).strict();
export type VendorEstimate = z.infer<typeof VendorEstimate>;

export const FieldEvidence = z.object({
  field: z.string(),
  shape: ProfileSource,
  level: ProfileSource,
  relUncertainty: z.number(),
  calibration: z.number(),
  note: z.string().optional(),
}).strict();
export type FieldEvidence = z.infer<typeof FieldEvidence>;

// 출력 계약: 세 갈래 어느 쪽이든 같은 모양이다.
export const KrossEstimate = z.object({
  schema: z.literal("kross-estimate/v0"),
  source: ProfileSource,
  evidence: z.array(FieldEvidence),
  hoursInMonth: z.number(),
  peakLambda: z.number(),
  vendors: z.array(VendorEstimate),
  best: VendorId.nullable(),
  crossovers: z.object({ actual: z.array(CrossPoint), approx: z.array(CrossPoint) }).strict(),
  envelope: z.array(EnvelopeSegment),
  gradients: z.array(GradientReport),
  decision: Decision.nullable(),
  warnings: z.array(z.string()),
}).strict();
export type KrossEstimate = z.infer<typeof KrossEstimate>;
