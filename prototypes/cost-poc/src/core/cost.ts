import { type DbClass, NKeys, type NKey, type NodeType, type Parts, type VendorPricing } from "./types.js";
import type { ResourceVector } from "./resource.js";

// DRAFT(ai): C_v(r) = F_v + p_v ⌈max_{k∈N} r_k / a_{v,k}⌉ + Σ_{m∈M} q_{v,m} r_m  (달러/시간)
// 확장: 노드 종류 t와 DB 등급 d에 대한 min (페이지의 "노드 항에 min을 추가"). 다중 노드 풀은 범위 밖.

export const HOURS_PER_MONTH = 730;
const CEIL_EPS = 1e-9;

const capOf = (t: NodeType, k: NKey): number | undefined => {
  if (k === "cpu") return t.capacity.cpu;
  if (k === "cpuRequested") return t.capacity.cpuRequested ?? t.capacity.cpu;
  if (k === "mem") return t.capacity.mem;
  return t.capacity.gpu;
};

// max_k r_k / a_{v,k}. 필요한 자원이 없는 노드(a=0, r>0)면 Infinity.
export function maxRatio(t: NodeType, r: ResourceVector): { ratio: number; ratios: Record<NKey, number> } {
  const ratios = {} as Record<NKey, number>;
  let ratio = 0;
  for (const k of NKeys) {
    const need = r.N[k];
    const cap = capOf(t, k) ?? 0;
    const x = need <= 0 ? 0 : cap > 0 ? need / cap : Infinity;
    ratios[k] = x;
    if (x > ratio) ratio = x;
  }
  return { ratio, ratios };
}

export function nodeCount(t: NodeType, r: ResourceVector, minNodes: number): number {
  const { ratio } = maxRatio(t, r);
  if (!Number.isFinite(ratio)) return Infinity;
  return Math.max(minNodes, Math.ceil(ratio - CEIL_EPS));
}

export function pickDbClass(p: VendorPricing, r: ResourceVector): DbClass | null {
  let best: DbClass | null = null;
  for (const d of p.dbClasses) {
    if (d.capacity.cpu + CEIL_EPS < r.dbCpuNeed || d.capacity.mem + CEIL_EPS < r.dbMemNeed) continue;
    if (!best || d.hourly < best.hourly || (d.hourly === best.hourly && d.sku < best.sku)) best = d;
  }
  return best;
}

export type HourlyResult = {
  feasible: boolean;
  reason?: string;
  total: number;
  parts: Parts;
  nodeSku: string | null;
  nodes: number;
  dbSku: string | null;
  kStar: NKey[];
};

const INF: HourlyResult = {
  feasible: false, total: Infinity, nodeSku: null, nodes: 0, dbSku: null, kStar: [],
  parts: { fixed: 0, nodes: 0, db: 0, storage: 0, egress: 0 },
};

export const storagePerHour = (p: VendorPricing) => p.storagePerGBMonth / HOURS_PER_MONTH;

function metered(p: VendorPricing, r: ResourceVector, db: DbClass | null) {
  return {
    db: db ? db.hourly * r.dbUnits : 0,
    storage: storagePerHour(p) * r.storageGB,
    egress: p.egressPerGB * r.egressGBh,
  };
}

const kStarOf = (ratios: Record<NKey, number>, ratio: number): NKey[] =>
  NKeys.filter((k) => ratio > 0 && Math.abs(ratios[k] - ratio) <= 1e-9 * ratio);

// 노드 종류와 DB 등급을 고정한 C_v
export function hourlyFixedConfig(p: VendorPricing, r: ResourceVector, t: NodeType, db: DbClass | null): HourlyResult {
  if (p.maxEgressGBh !== undefined && r.egressGBh > p.maxEgressGBh) return { ...INF, reason: "LINE_CAPACITY_EXCEEDED" };
  const { ratio, ratios } = maxRatio(t, r);
  if (!Number.isFinite(ratio)) return { ...INF, reason: "NO_NODE_FOR_RESOURCE" };
  const n = Math.max(p.minNodes, Math.ceil(ratio - CEIL_EPS));
  if (p.capVcpuTotal !== undefined && n * t.capacity.cpu > p.capVcpuTotal) return { ...INF, reason: "ONPREM_CAPACITY_EXCEEDED" };
  if (p.maxNodes !== undefined && n > p.maxNodes) return { ...INF, reason: "NODE_LIMIT_EXCEEDED" };
  const m = metered(p, r, db);
  const parts: Parts = { fixed: p.fixedHourly, nodes: t.hourly * n, ...m };
  return {
    feasible: true, total: parts.fixed + parts.nodes + parts.db + parts.storage + parts.egress, parts,
    nodeSku: t.sku, nodes: n, dbSku: db?.sku ?? null, kStar: kStarOf(ratios, ratio),
  };
}

// C_v(r): 노드 종류·DB 등급 중 가장 싼 안
export function hourlyCost(p: VendorPricing, r: ResourceVector): HourlyResult {
  let db: DbClass | null = null;
  if (r.dbUnits > 0) {
    db = pickDbClass(p, r);
    if (!db) return { ...INF, reason: p.dbClasses.length === 0 ? "DB_PRICE_MISSING" : "DB_CLASS_EXCEEDED" };
  }
  let best: HourlyResult | null = null;
  let lastReason = "NO_NODE_FOR_RESOURCE";
  for (const t of p.nodeTypes) {
    const c = hourlyFixedConfig(p, r, t, db);
    if (!c.feasible) { lastReason = c.reason ?? lastReason; continue; }
    if (!best || c.total < best.total - 1e-12 || (Math.abs(c.total - best.total) <= 1e-12 && (c.nodeSku ?? "") < (best.nodeSku ?? ""))) best = c;
  }
  return best ?? { ...INF, reason: lastReason };
}

// DB 항의 연속 완화: 가장 싼 등급 값과 vCPU당 단가 x 필요량 중 큰 값
export function dbTilde(p: VendorPricing, r: ResourceVector): { usd: number; rate: number; floor: number; active: boolean } {
  if (r.dbUnits === 0 || p.dbClasses.length === 0) return { usd: 0, rate: 0, floor: 0, active: false };
  const floor = Math.min(...p.dbClasses.map((d) => d.hourly));
  const rate = Math.min(...p.dbClasses.map((d) => d.hourly / d.capacity.cpu));
  const v = rate * r.dbCpuNeed;
  return { usd: Math.max(floor, v) * r.dbUnits, rate, floor, active: v > floor };
}

export type TildeResult = HourlyResult & { fractionalNodes: number };

// C̃_v(r): 올림만 뺀다. minNodes 바닥은 respectMinNodes일 때만 적용 (페이지 원식은 바닥 없음)
export function tildeFixedType(p: VendorPricing, r: ResourceVector, t: NodeType, respectMinNodes: boolean): TildeResult {
  const { ratio, ratios } = maxRatio(t, r);
  if (!Number.isFinite(ratio)) return { ...INF, reason: "NO_NODE_FOR_RESOURCE", fractionalNodes: Infinity };
  const x = respectMinNodes ? Math.max(p.minNodes, ratio) : ratio;
  const parts: Parts = {
    fixed: p.fixedHourly, nodes: t.hourly * x, db: dbTilde(p, r).usd,
    storage: storagePerHour(p) * r.storageGB, egress: p.egressPerGB * r.egressGBh,
  };
  return {
    feasible: true, total: parts.fixed + parts.nodes + parts.db + parts.storage + parts.egress, parts,
    nodeSku: t.sku, nodes: x, dbSku: null, kStar: kStarOf(ratios, ratio), fractionalNodes: ratio,
  };
}

export function hourlyTilde(p: VendorPricing, r: ResourceVector, respectMinNodes = true): TildeResult {
  let best: TildeResult | null = null;
  for (const t of p.nodeTypes) {
    const c = tildeFixedType(p, r, t, respectMinNodes);
    if (!c.feasible) continue;
    if (!best || c.total < best.total - 1e-12 || (Math.abs(c.total - best.total) <= 1e-12 && (c.nodeSku ?? "") < (best.nodeSku ?? ""))) best = c;
  }
  return best ?? { ...INF, reason: "NO_NODE_FOR_RESOURCE", fractionalNodes: Infinity };
}
