import { dbTilde, hourlyTilde, maxRatio, storagePerHour } from "./cost.js";
import type { ResourceFn, ResourceVector } from "./resource.js";
import { vendorResources } from "./resource.js";
import type { GradientReport, NKey, Sizing, VendorPricing } from "./types.js";
import { NKeys } from "./types.js";

// DRAFT(ai): ∂Cost_v/∂λ = (p_v / a_{v,k*}) ∂r_{v,k*}/∂λ + Σ_{m∈M} q_{v,m} ∂r_{v,m}/∂λ, k* = argmax_k r_k / a_{v,k}
// 병목 동률이면 미분이 정의되지 않는다. max의 한쪽 미분으로 처리한다.
//   오른쪽 미분 = 동률 자원 항의 최댓값, 왼쪽 미분 = 동률 자원 항의 최솟값. total은 오른쪽 미분(비용을 크게 보는 쪽)이다.

const TIE_TOL = 1e-9;

const capOf = (t: { capacity: { cpu: number; cpuRequested?: number | undefined; mem: number; gpu: number } }, k: NKey) =>
  k === "cpu" ? t.capacity.cpu : k === "cpuRequested" ? t.capacity.cpuRequested ?? t.capacity.cpu : k === "mem" ? t.capacity.mem : t.capacity.gpu;

type Delta = { N: Record<NKey, number>; storage: number; egress: number; dbCpu: number };

function delta(a: ResourceVector, b: ResourceVector, h: number): Delta {
  const N = {} as Record<NKey, number>;
  for (const k of NKeys) N[k] = (b.N[k] - a.N[k]) / h;
  return { N, storage: (b.storageGB - a.storageGB) / h, egress: (b.egressGBh - a.egressGBh) / h, dbCpu: (b.dbCpuNeed - a.dbCpuNeed) / h };
}

export function gradientAt(
  p: VendorPricing, fn: ResourceFn, sizing: Sizing, lambda: number,
  opts: { respectMinNodes?: boolean } = {},
): GradientReport {
  const respect = opts.respectMinNodes ?? true;
  const r = vendorResources(fn, p, sizing, lambda);
  const tilde = hourlyTilde(p, r, respect);
  const t = p.nodeTypes.find((x) => x.sku === tilde.nodeSku) ?? p.nodeTypes[0]!;
  const h = 1e-6 * Math.max(1, lambda);
  const up = delta(r, vendorResources(fn, p, sizing, lambda + h), h);
  const down = lambda - h >= 0 ? delta(vendorResources(fn, p, sizing, lambda - h), r, h) : up;

  const { ratio, ratios } = maxRatio(t, r);
  const ties = NKeys.filter((k) => ratio > 0 && Math.abs(ratios[k] - ratio) <= TIE_TOL * ratio);
  const below = respect && ratio < p.minNodes;
  const atFloor = respect && Math.abs(ratio - p.minNodes) <= TIE_TOL * Math.max(1, p.minNodes);
  const term = (k: NKey, d: Delta) => (t.hourly / capOf(t, k)) * d.N[k];
  const rightTerms = ties.map((k) => term(k, up));
  const leftTerms = ties.map((k) => term(k, down));
  // 바닥(minNodes)에서는 왼쪽 0, 오른쪽은 병목 항
  const nodeRight = below ? 0 : rightTerms.length ? Math.max(...rightTerms, atFloor ? 0 : -Infinity) : 0;
  const nodeLeft = below || atFloor ? 0 : leftTerms.length ? Math.min(...leftTerms) : 0;

  const db = dbTilde(p, r);
  const dbRight = db.active ? db.rate * up.dbCpu : 0;
  const dbLeft = db.active ? db.rate * down.dbCpu : 0;
  const stHourly = storagePerHour(p);
  const stRight = stHourly * up.storage; const stLeft = stHourly * down.storage;
  const egRight = p.egressPerGB * up.egress; const egLeft = p.egressPerGB * down.egress;

  const right = nodeRight + dbRight + stRight + egRight;
  const left = nodeLeft + dbLeft + stLeft + egLeft;
  return {
    vendor: p.vendor, lambda, sku: t.sku, kStar: ties, tie: ties.length > 1,
    belowMinNodes: below, nodeTerm: nodeRight, dbTerm: dbRight, storageTerm: stRight, egressTerm: egRight,
    total: right, leftDerivative: left, rightDerivative: right,
  };
}
