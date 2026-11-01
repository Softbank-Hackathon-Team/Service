import type { NKey, ResourcePoint, ResourceProfile, Sizing, VendorPricing } from "./types.js";

// DRAFT(ai): r_v : (λ; θ) ↦ r. 측정 점에서 함수를 만들고 벤더별로 여유분과 배치를 입힌다.

export type Fit = { intercept: number; slope: number; r2: number; rmse: number; n: number };

// 최소제곱 직선. 점이 하나면 기울기 0.
export function fitLinear(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  if (n === 0 || n !== ys.length) throw new Error("FIT_BAD_INPUT");
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0; let sxy = 0; let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    syy += (ys[i]! - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
  const r2 = syy === 0 ? 1 : 1 - sse / syy;
  return { intercept, slope, r2, rmse: Math.sqrt(sse / n), n };
}

export const POINT_FIELDS = ["cpu", "memGiB", "egressGBh", "storageGB", "gpu", "dbCpu", "dbMemGiB"] as const;
export type PointField = (typeof POINT_FIELDS)[number];

export type ResourceFn = {
  at: (lambda: number) => Record<PointField, number>;
  extrapolated: (lambda: number) => boolean;
  knots: number[];
  growthGBPerRequest: number;
  mode: "segment" | "regression";
  fits?: Record<PointField, Fit>;
};

const val = (p: ResourcePoint, f: PointField) => p[f] ?? 0;

// 구간 차분(∂r/∂λ ≈ Δr/Δλ)과 같은 뜻의 조각 선형 함수.
function segmentAt(points: ResourcePoint[], lambda: number, f: PointField): number {
  if (points.length === 1) return val(points[0]!, f);
  let i = 0;
  while (i < points.length - 2 && lambda > points[i + 1]!.lambda) i++;
  const a = points[i]!; const b = points[i + 1]!;
  const s = (val(b, f) - val(a, f)) / (b.lambda - a.lambda);
  return Math.max(0, val(a, f) + s * (lambda - a.lambda));
}

export function makeResourceFn(profile: ResourceProfile, mode: "segment" | "regression" = "segment"): ResourceFn {
  const pts = profile.points;
  const lo = pts[0]!.lambda; const hi = pts[pts.length - 1]!.lambda;
  const extrapolated = (l: number) => l < lo || l > hi;
  const base = { knots: pts.map((p) => p.lambda), extrapolated, growthGBPerRequest: profile.storageGrowthGBPerRequest };
  if (mode === "segment") {
    return { ...base, mode, at: (l) => {
      const out = {} as Record<PointField, number>;
      for (const f of POINT_FIELDS) out[f] = segmentAt(pts, l, f);
      return out;
    } };
  }
  const xs = pts.map((p) => p.lambda);
  const fits = {} as Record<PointField, Fit>;
  for (const f of POINT_FIELDS) fits[f] = fitLinear(xs, pts.map((p) => val(p, f)));
  return { ...base, mode, fits, at: (l) => {
    const out = {} as Record<PointField, number>;
    for (const f of POINT_FIELDS) out[f] = Math.max(0, fits[f].intercept + fits[f].slope * l);
    return out;
  } };
}

// r ∈ R^n: 벤더 v에서 필요한 값. N은 노드 자원, 나머지는 M.
export type ResourceVector = {
  N: Record<NKey, number>;
  dbCpuNeed: number;
  dbMemNeed: number;
  dbUnits: number;     // r_db: 관리형 DB 인스턴스 수. 온프레는 0
  storageGB: number;   // r_storage
  egressGBh: number;   // r_egress
};

export function vendorResources(
  fn: ResourceFn, pricing: VendorPricing, sizing: Sizing, lambda: number, extraStorageGB = 0,
): ResourceVector {
  const u = fn.at(lambda);
  const onNodes = pricing.dbOnNodes && sizing.hasDatabase;
  const dbCpuNeed = sizing.hasDatabase ? u.dbCpu / sizing.dbTargetUtil : 0;
  const dbMemNeed = sizing.hasDatabase ? u.dbMemGiB / sizing.dbTargetUtil : 0;
  const rep = pricing.dbReplicasOnNodes;
  const cpuUse = u.cpu / sizing.targetUtil + sizing.systemCpu + (onNodes ? dbCpuNeed * rep : 0);
  const memUse = Math.max(u.memGiB / sizing.targetUtil, sizing.memRequestFloorGiB) + sizing.systemMemGiB + (onNodes ? dbMemNeed * rep : 0);
  const cpuReq = sizing.cpuRequestFloor + sizing.systemCpu + (onNodes ? dbCpuNeed * rep : 0);
  return {
    N: { cpu: cpuUse, cpuRequested: cpuReq, mem: memUse, gpu: u.gpu },
    dbCpuNeed, dbMemNeed,
    dbUnits: sizing.hasDatabase && !onNodes ? 1 : 0,
    storageGB: sizing.hasDatabase ? u.storageGB + extraStorageGB : 0,
    egressGBh: u.egressGBh,
  };
}
