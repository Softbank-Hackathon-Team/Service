import { HOURS_PER_MONTH, hourlyCost, hourlyFixedConfig, pickDbClass } from "./cost.js";
import { type ResourceFn, vendorResources } from "./resource.js";
import type { DbClass, NodeType, Parts, Sizing, Traffic, VendorPricing } from "./types.js";

// DRAFT(ai): Cost_v^month = ∫_0^T C_v(r_v(λ(t); θ)) dt. 원래 C_v를 쓰고, 스토리지는 누적량이라 r_m(t)를 시점별로 넣는다.
// 노드 종류·DB 등급은 한 달 동안 고정한다 (min_{t,d} ∫ C_{v,t,d} dt). 시간마다 종류를 바꾸는 min inside는 비교용 free-type.
// 노드 수는 시간마다 트래픽을 따른다 (provisioning=autoscale). peak는 팀의 현재 방식처럼 피크로 한 달 고정.

export function lambdaAt(tr: Traffic, tHours: number): number {
  if (tr.kind === "constant") return tr.lambda;
  if (tr.kind === "series") return tr.hourly[Math.min(tr.hourly.length - 1, Math.floor(tHours) % tr.hourly.length)]!;
  // 하루 주기 사인. 최저 = peak x troughRatio, 최고 = peak (형태는 가정)
  const phase = 0.5 + 0.5 * Math.sin((2 * Math.PI * (tHours - 8)) / 24);
  return tr.peak * (tr.troughRatio + (1 - tr.troughRatio) * phase);
}

export function peakLambda(tr: Traffic): number {
  if (tr.kind === "constant") return tr.lambda;
  if (tr.kind === "series") return Math.max(...tr.hourly);
  return tr.peak;
}

export function tieredEgress(tiers: { fromGB: number; usdPerGB: number }[], gb: number): number {
  if (tiers.length === 0 || gb <= 0) return 0;
  const sorted = [...tiers].sort((a, b) => a.fromGB - b.fromGB);
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    const end = sorted[i + 1]?.fromGB ?? Infinity;
    if (gb <= t.fromGB) break;
    total += (Math.min(gb, end) - t.fromGB) * t.usdPerGB;
  }
  return total;
}

export type MonthlyOptions = {
  hours?: number;
  dtHours?: number;
  provisioning?: "autoscale" | "peak";
  nodeChoice?: "fixed-type" | "free-type";
  applyEgressTiers?: boolean;
  applyCredit?: boolean;
};

export type MonthlyResult = {
  feasible: boolean;
  reason?: string;
  totalUsd: number;        // 적분 + 계단 조정 - 크레딧
  integralUsd: number;     // ∫ C_v dt (페이지 원식)
  egressTierAdjustUsd: number;
  creditUsd: number;
  parts: Parts;
  nodeSku: string | null;
  dbSku: string | null;
  avgNodes: number;
  peakNodes: number;
  egressGB: number;
  storageEndGB: number;
  hours: number;
};

const EMPTY: Parts = { fixed: 0, nodes: 0, db: 0, storage: 0, egress: 0 };

type Step = { rBill: ReturnType<typeof vendorResources>; egressGBh: number };

function precompute(p: VendorPricing, fn: ResourceFn, sizing: Sizing, tr: Traffic, o: Required<MonthlyOptions>) {
  const n = Math.round(o.hours / o.dtHours);
  const steps: Step[] = [];
  let extraStorage = 0;
  const peak = peakLambda(tr);
  for (let i = 0; i < n; i++) {
    const tMid = (i + 0.5) * o.dtHours;
    const lam = lambdaAt(tr, tMid);
    // 이 칸의 누적 스토리지는 칸 가운데 값 (중점 규칙)
    const grow = fn.growthGBPerRequest * lam * 3600 * o.dtHours;
    const rNow = vendorResources(fn, p, sizing, lam, extraStorage + grow / 2);
    const rSize = o.provisioning === "peak" ? vendorResources(fn, p, sizing, peak, extraStorage + grow / 2) : rNow;
    steps.push({ rBill: { ...rSize, egressGBh: rNow.egressGBh, storageGB: rNow.storageGB }, egressGBh: rNow.egressGBh });
    extraStorage += grow;
  }
  const storageEndGB = vendorResources(fn, p, sizing, lambdaAt(tr, o.hours), extraStorage).storageGB;
  return { steps, storageEndGB };
}

const infeasible = (reason: string, hours: number): MonthlyResult => ({
  feasible: false, reason, totalUsd: Infinity, integralUsd: Infinity, egressTierAdjustUsd: 0, creditUsd: 0,
  parts: { ...EMPTY }, nodeSku: null, dbSku: null, avgNodes: 0, peakNodes: 0, egressGB: 0, storageEndGB: 0, hours,
});

function integrate(
  p: VendorPricing, pre: ReturnType<typeof precompute>, o: Required<MonthlyOptions>,
  t: NodeType | null, db: DbClass | null,
): MonthlyResult {
  const parts: Parts = { ...EMPTY };
  let nodesSum = 0; let peakNodes = 0; let egressGB = 0;
  let sku: string | null = t?.sku ?? null;
  let dbSku: string | null = db?.sku ?? null;
  for (const s of pre.steps) {
    const c = t ? hourlyFixedConfig(p, s.rBill, t, db) : hourlyCost(p, s.rBill);
    if (!c.feasible) return infeasible(c.reason ?? "INFEASIBLE", o.hours);
    parts.fixed += c.parts.fixed * o.dtHours;
    parts.nodes += c.parts.nodes * o.dtHours;
    parts.db += c.parts.db * o.dtHours;
    parts.storage += c.parts.storage * o.dtHours;
    parts.egress += c.parts.egress * o.dtHours;
    nodesSum += c.nodes * o.dtHours;
    if (c.nodes > peakNodes) peakNodes = c.nodes;
    egressGB += s.egressGBh * o.dtHours;
    if (!t) { sku = c.nodeSku; dbSku = c.dbSku; }
  }
  const integralUsd = parts.fixed + parts.nodes + parts.db + parts.storage + parts.egress;
  const egressTierAdjustUsd = o.applyEgressTiers && p.egressTiers.length > 0
    ? tieredEgress(p.egressTiers, egressGB) - parts.egress : 0;
  const creditUsd = o.applyCredit ? Math.min(p.monthlyCreditUsd * (o.hours / HOURS_PER_MONTH), parts.fixed) : 0;
  return {
    feasible: true, totalUsd: integralUsd + egressTierAdjustUsd - creditUsd, integralUsd, egressTierAdjustUsd, creditUsd,
    parts, nodeSku: sku, dbSku, avgNodes: nodesSum / o.hours, peakNodes, egressGB, storageEndGB: pre.storageEndGB, hours: o.hours,
  };
}

export function monthlyCost(p: VendorPricing, fn: ResourceFn, sizing: Sizing, tr: Traffic, opts: MonthlyOptions = {}): MonthlyResult {
  const o: Required<MonthlyOptions> = {
    hours: opts.hours ?? HOURS_PER_MONTH, dtHours: opts.dtHours ?? 1,
    provisioning: opts.provisioning ?? "autoscale", nodeChoice: opts.nodeChoice ?? "fixed-type",
    applyEgressTiers: opts.applyEgressTiers ?? true, applyCredit: opts.applyCredit ?? true,
  };
  if (!(o.hours > 0) || !(o.dtHours > 0)) throw new Error("MONTHLY_BAD_RANGE");
  const pre = precompute(p, fn, sizing, tr, o);
  if (o.nodeChoice === "free-type") return integrate(p, pre, o, null, null);

  // DB 등급은 피크 필요량으로 고른다 (시간마다 등급을 바꿀 수 없다)
  const rPeak = vendorResources(fn, p, sizing, peakLambda(tr));
  let db: DbClass | null = null;
  if (rPeak.dbUnits > 0) {
    db = pickDbClass(p, rPeak);
    if (!db) return infeasible(p.dbClasses.length === 0 ? "DB_PRICE_MISSING" : "DB_CLASS_EXCEEDED", o.hours);
  }
  let best: MonthlyResult | null = null;
  let lastReason: string | undefined;
  for (const t of p.nodeTypes) {
    const m = integrate(p, pre, o, t, db);
    if (!m.feasible) { lastReason = m.reason; continue; }
    if (!best || m.totalUsd < best.totalUsd - 1e-9 || (Math.abs(m.totalUsd - best.totalUsd) <= 1e-9 && (m.nodeSku ?? "") < (best.nodeSku ?? ""))) best = m;
  }
  return best ?? infeasible(lastReason ?? "INFEASIBLE", o.hours);
}
