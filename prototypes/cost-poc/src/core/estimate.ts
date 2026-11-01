import { hourlyCost } from "./cost.js";
import { cheapestEnvelope, curveActual, curveApprox, findCrossovers } from "./crossover.js";
import { decide, oneTimeCost } from "./decide.js";
import { gradientAt } from "./gradient.js";
import { type MonthlyOptions, monthlyCost, peakLambda } from "./monthly.js";
import { makeResourceFn, vendorResources } from "./resource.js";
import {
  type Constraints, Constraints as ConstraintsSchema, type CrossPoint, type FieldEvidence, KrossEstimate,
  MigrationParams, type MigrationParamsInput, type Range, ResourceProfile, type ResourceProfileInput,
  Sizing, type SizingInput, Traffic, type TrafficInput, VendorPricing, type VendorPricingInput,
  type VendorEstimate, type VendorId,
} from "./types.js";

// DRAFT(ai): 진입점. 세 갈래 모두 이 함수 하나를 지난다. 네트워크 없음, 같은 입력이면 같은 출력.

export type EstimateInput = {
  profile: ResourceProfileInput;
  pricing: VendorPricingInput[];
  sizing?: SizingInput;
  traffic: TrafficInput;
  constraints?: Constraints;
  from?: VendorId;
  migration?: MigrationParamsInput;
  evidence?: FieldEvidence[];
  rel?: Record<string, number>;       // 필드별 상대 반폭 (없으면 범위 = 기준값)
  options?: MonthlyOptions & {
    fnMode?: "segment" | "regression";
    lambdaRange?: [number, number];
    draws?: number;
    seed?: number;
    perfSpread?: number;              // 벤더별 CPU 성능 차이 반폭
  };
  warnings?: string[];
};

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function scaleProfile(p: ResourceProfile, f: Record<string, number>): ResourceProfile {
  return {
    ...p,
    points: p.points.map((x) => ({
      ...x,
      cpu: x.cpu * (f["cpu"] ?? 1), memGiB: x.memGiB * (f["memGiB"] ?? 1), egressGBh: x.egressGBh * (f["egressGBh"] ?? 1),
      ...(x.dbCpu !== undefined ? { dbCpu: x.dbCpu * (f["dbCpu"] ?? 1) } : {}),
      ...(x.dbMemGiB !== undefined ? { dbMemGiB: x.dbMemGiB * (f["dbMemGiB"] ?? 1) } : {}),
    })),
  };
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

function applyPerf(p: VendorPricing, factor: number): VendorPricing {
  if (factor === 1) return p;
  return { ...p, nodeTypes: p.nodeTypes.map((t) => ({ ...t, capacity: { ...t.capacity, cpu: t.capacity.cpu * factor } })) };
}

export function estimate(input: EstimateInput): KrossEstimate {
  const profile = ResourceProfile.parse(input.profile);
  const pricing = input.pricing.map((p) => VendorPricing.parse(p));
  if (pricing.length === 0) throw new Error("NO_VENDORS");
  if (new Set(pricing.map((p) => p.vendor)).size !== pricing.length) throw new Error("DUPLICATE_VENDOR");
  const sizing = Sizing.parse(input.sizing ?? {});
  const traffic = Traffic.parse(input.traffic);
  const constraints = ConstraintsSchema.parse(input.constraints ?? {});
  const opts = input.options ?? {};
  const fnMode = opts.fnMode ?? "segment";
  const fn = makeResourceFn(profile, fnMode);
  const peak = peakLambda(traffic);
  const warnings = [...(input.warnings ?? [])];
  if (fn.extrapolated(peak)) warnings.push(`피크 λ=${peak}가 측정 범위 밖이라 외삽했다 (범위 ${fn.knots[0]}~${fn.knots[fn.knots.length - 1]})`);
  const monthlyOpts: MonthlyOptions = {
    ...(opts.hours !== undefined ? { hours: opts.hours } : {}), ...(opts.dtHours !== undefined ? { dtHours: opts.dtHours } : {}),
    ...(opts.provisioning ? { provisioning: opts.provisioning } : {}), ...(opts.nodeChoice ? { nodeChoice: opts.nodeChoice } : {}),
    ...(opts.applyEgressTiers !== undefined ? { applyEgressTiers: opts.applyEgressTiers } : {}),
    ...(opts.applyCredit !== undefined ? { applyCredit: opts.applyCredit } : {}),
  };

  // 제약: 프로필의 p95·오류율, 벤더별 측정치, 레지던시
  const slo = (p: VendorPricing): { ok: boolean; reason?: string; notes: string[] } => {
    const notes: string[] = [];
    if (constraints.residency && !constraints.residency.includes(p.residency)) return { ok: false, reason: "RESIDENCY", notes };
    const atPeak = nearestPoint(profile, peak);
    const vs = constraints.vendorSlo?.[p.vendor];
    const p95 = vs?.p95Ms ?? atPeak?.p95Ms;
    const err = vs?.errorRate ?? atPeak?.errorRate;
    if (constraints.p95Ms !== undefined) {
      if (p95 === undefined) notes.push("p95 미측정");
      else if (p95 > constraints.p95Ms) return { ok: false, reason: "SLO_P95", notes };
      else if (!vs) notes.push("p95는 이 벤더가 아닌 프로필 측정값");
    }
    if (constraints.errorRate !== undefined) {
      if (err === undefined) notes.push("오류율 미측정");
      else if (err > constraints.errorRate) return { ok: false, reason: "SLO_ERROR_RATE", notes };
    }
    return { ok: true, notes };
  };

  // 기준값
  const base = pricing.map((p) => ({ p, gate: slo(p), m: monthlyCost(p, fn, sizing, traffic, monthlyOpts) }));

  // 불확실성: 같은 뽑기를 벤더 모두에 쓴다 (앱은 하나다). CPU 성능만 벤더별로 따로 뽑는다.
  const rel = input.rel ?? {};
  const draws = Object.keys(rel).length > 0 || (opts.perfSpread ?? 0) > 0 ? (opts.draws ?? 200) : 0;
  const samples = new Map<VendorId, number[]>(pricing.map((p) => [p.vendor, []]));
  const rand = mulberry32(opts.seed ?? 1);
  const winners = new Map<VendorId, number>();
  const logUniform = (u: number) => { const hw = Math.log(1 + u); return Math.exp((rand() * 2 - 1) * hw); };
  for (let d = 0; d < draws; d++) {
    const f: Record<string, number> = {};
    for (const k of Object.keys(rel)) f[k] = logUniform(rel[k]!);
    const sf = makeResourceFn(scaleProfile(profile, f), fnMode);
    let bestV: VendorId | null = null; let bestC = Infinity;
    for (const { p, gate } of base) {
      const perf = (opts.perfSpread ?? 0) > 0 ? logUniform(opts.perfSpread!) : 1;
      const m = monthlyCost(applyPerf(p, perf), sf, sizing, traffic, monthlyOpts);
      samples.get(p.vendor)!.push(m.totalUsd);
      if (gate.ok && m.feasible && m.totalUsd < bestC) { bestC = m.totalUsd; bestV = p.vendor; }
    }
    if (bestV) winners.set(bestV, (winners.get(bestV) ?? 0) + 1);
  }
  const rangeOf = (v: VendorId, center: number): Range => {
    const s = (samples.get(v) ?? []).filter(Number.isFinite);
    if (s.length === 0) return { base: r2(center), low: r2(center), high: r2(center) };
    return { base: r2(center), low: r2(Math.min(center, quantile(s, 0.1))), high: r2(Math.max(center, quantile(s, 0.9))) };
  };

  const feasibleBase = base.filter((b) => b.gate.ok && b.m.feasible);
  const bestV = feasibleBase.length === 0 ? null
    : feasibleBase.reduce((a, b) => (b.m.totalUsd < a.m.totalUsd ? b : a)).p.vendor;

  const vendors: VendorEstimate[] = base.map(({ p, gate, m }) => {
    const ok = gate.ok && m.feasible;
    const rPeak = vendorResources(fn, p, sizing, peak);
    const h = hourlyCost(p, rPeak);
    return {
      vendor: p.vendor, feasible: ok, ...(ok ? {} : { reason: gate.reason ?? m.reason ?? "INFEASIBLE" }),
      nodeSku: m.nodeSku, dbSku: m.dbSku, avgNodes: r2(m.avgNodes), peakNodes: m.peakNodes,
      monthlyUsd: m.feasible ? rangeOf(p.vendor, m.totalUsd) : null,
      parts: { fixed: r2(m.parts.fixed), nodes: r2(m.parts.nodes), db: r2(m.parts.db), storage: r2(m.parts.storage), egress: r2(m.parts.egress) },
      integralUsd: Number.isFinite(m.integralUsd) ? r2(m.integralUsd) : 0,
      egressTierAdjustUsd: r2(m.egressTierAdjustUsd), creditUsd: r2(m.creditUsd),
      egressGB: r2(m.egressGB), storageEndGB: r2(m.storageEndGB),
      peakHourlyUsd: h.feasible ? h.total : null,
      probBest: draws > 0 ? (winners.get(p.vendor) ?? 0) / draws : p.vendor === bestV ? 1 : 0,
      unknownItems: p.unknownItems, constraintNotes: gate.notes,
    };
  });

  // 역전점: 실제 C와 근사 C̃를 나눠서
  const hiDefault = Math.max(peak * 3, 10, fn.knots[fn.knots.length - 1] ?? 10);
  const [lo, hi] = opts.lambdaRange ?? [0, hiDefault];
  const ok = base.filter((b) => b.gate.ok).map((b) => b.p);
  const actualCurves = ok.map((p) => curveActual(p, fn, sizing, lo, hi));
  const approxCurves = ok.map((p) => curveApprox(p, fn, sizing));
  const extra = fn.knots;
  const actual: CrossPoint[] = []; const approx: CrossPoint[] = [];
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      actual.push(...findCrossovers(actualCurves[i]!, actualCurves[j]!, lo, hi, { extraPoints: extra }));
      const grid = Array.from({ length: 401 }, (_, n) => lo + ((hi - lo) * n) / 400);
      approx.push(...findCrossovers(approxCurves[i]!, approxCurves[j]!, lo, hi, { extraPoints: [...extra, ...grid], samples: 2 }));
    }
  }
  const envelope = cheapestEnvelope(actualCurves, lo, hi, { extraPoints: extra });
  const gradients = ok.map((p) => gradientAt(p, fn, sizing, peak));

  // 이전 판단
  let decision: KrossEstimate["decision"] = null;
  if (input.from) {
    const params = MigrationParams.parse(input.migration ?? {});
    const from = base.find((b) => b.p.vendor === input.from);
    const cur = from && from.m.feasible ? rangeOf(input.from, from.m.totalUsd) : null;
    const cands = feasibleBase.filter((b) => b.p.vendor !== input.from).map((b) => {
      const saved = savingRange(samples.get(input.from!) ?? [], samples.get(b.p.vendor) ?? [], (from?.m.totalUsd ?? Infinity) - b.m.totalUsd);
      const rPeak = vendorResources(fn, b.p, sizing, peak);
      const hourly = hourlyCost(b.p, rPeak).total;
      const dataGB = params.dataGB ?? vendorResources(fn, b.p, sizing, peak).storageGB;
      return {
        vendor: b.p.vendor, monthly: rangeOf(b.p.vendor, b.m.totalUsd), saving: saved,
        oneTime: oneTimeCost({ params, targetHourlyUsd: hourly, sourceEgressPerGB: from?.p.egressPerGB ?? 0, dataGB }),
      };
    });
    decision = decide(input.from, cur, cands, params);
  }

  return KrossEstimate.parse({
    schema: "kross-estimate/v0",
    source: profile.source,
    evidence: input.evidence ?? [],
    hoursInMonth: opts.hours ?? 730,
    peakLambda: peak,
    vendors,
    best: bestV,
    crossovers: { actual, approx },
    envelope,
    gradients,
    decision,
    warnings,
  });
}

function savingRange(fromS: number[], toS: number[], center: number): Range {
  const d: number[] = [];
  for (let i = 0; i < Math.min(fromS.length, toS.length); i++) {
    const v = fromS[i]! - toS[i]!;
    if (Number.isFinite(v)) d.push(v);
  }
  if (d.length === 0) return { base: r2(center), low: r2(center), high: r2(center) };
  return { base: r2(center), low: r2(Math.min(center, quantile(d, 0.1))), high: r2(Math.max(center, quantile(d, 0.9))) };
}

function nearestPoint(p: ResourceProfile, l: number) {
  let best = p.points[0];
  for (const x of p.points) if (best && Math.abs(x.lambda - l) < Math.abs(best.lambda - l)) best = x;
  return best;
}
