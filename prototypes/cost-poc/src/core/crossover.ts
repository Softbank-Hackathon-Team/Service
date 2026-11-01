import { hourlyCost, hourlyTilde } from "./cost.js";
import { type ResourceFn, vendorResources } from "./resource.js";
import { type CrossPoint, type EnvelopeSegment, NKeys, type Sizing, type VendorId, type VendorPricing } from "./types.js";

// DRAFT(ai): λ* : Cost_a(λ*; θ) = Cost_b(λ*; θ). 계단 때문에 여러 개일 수 있다.
// 실제 C는 연속 구간(계단 사이)마다 근을 찾고, 계단에서 순서만 뒤집히는 지점은 kind=jump로 구분한다.
// 근사 C̃는 연속이라 exact만 나온다.

export type CostFn = (lambda: number) => number;
export type Curve = { vendor: VendorId; cost: CostFn; events: number[] };

const GRID = 400;

// C_v의 불연속점: r_k/a_{t,k}가 정수를 넘는 λ, DB 등급 한도를 넘는 λ
export function stepEvents(p: VendorPricing, fn: ResourceFn, sizing: Sizing, lo: number, hi: number): number[] {
  const out = new Set<number>();
  const r = (l: number) => vendorResources(fn, p, sizing, l);
  const grid: number[] = [];
  for (let i = 0; i <= GRID; i++) grid.push(lo + ((hi - lo) * i) / GRID);
  const rs = grid.map(r);
  const solve = (g: (l: number) => number, a: number, b: number, target: number) => {
    let x = a; let y = b;
    const up = g(b) >= g(a);
    for (let it = 0; it < 60; it++) {
      const m = (x + y) / 2;
      if ((g(m) < target) === up) x = m; else y = m;
    }
    out.add((x + y) / 2);
  };
  const scan = (g: (l: number) => number, levels: (v0: number, v1: number) => number[]) => {
    for (let i = 0; i < GRID; i++) {
      const a = grid[i]!; const b = grid[i + 1]!;
      const v0 = g(a); const v1 = g(b);
      for (const lev of levels(v0, v1)) solve(g, a, b, lev);
    }
  };
  const ints = (v0: number, v1: number) => {
    const lo2 = Math.min(v0, v1); const hi2 = Math.max(v0, v1);
    const res: number[] = [];
    for (let n = Math.floor(lo2) + 1; n <= hi2 && res.length < 10000; n++) res.push(n);
    return res;
  };
  for (const t of p.nodeTypes) {
    for (const k of NKeys) {
      const cap = k === "cpu" ? t.capacity.cpu : k === "cpuRequested" ? t.capacity.cpuRequested ?? t.capacity.cpu : k === "mem" ? t.capacity.mem : t.capacity.gpu;
      if (!(cap > 0)) continue;
      if (rs.every((x) => x.N[k] === rs[0]!.N[k])) continue;
      scan((l) => r(l).N[k] / cap, ints);
    }
  }
  for (const d of p.dbClasses) {
    const thr = (v0: number, v1: number, cap: number) => (Math.min(v0, v1) < cap && Math.max(v0, v1) >= cap ? [cap] : []);
    if (rs.some((x) => x.dbCpuNeed !== rs[0]!.dbCpuNeed)) scan((l) => r(l).dbCpuNeed, (a, b) => thr(a, b, d.capacity.cpu));
    if (rs.some((x) => x.dbMemNeed !== rs[0]!.dbMemNeed)) scan((l) => r(l).dbMemNeed, (a, b) => thr(a, b, d.capacity.mem));
  }
  return [...out].sort((x, y) => x - y);
}

export function curveActual(p: VendorPricing, fn: ResourceFn, sizing: Sizing, lo: number, hi: number): Curve {
  return {
    vendor: p.vendor,
    cost: (l) => hourlyCost(p, vendorResources(fn, p, sizing, l)).total,
    events: stepEvents(p, fn, sizing, lo, hi),
  };
}

export function curveApprox(p: VendorPricing, fn: ResourceFn, sizing: Sizing): Curve {
  return { vendor: p.vendor, cost: (l) => hourlyTilde(p, vendorResources(fn, p, sizing, l)).total, events: [] };
}

const SAME = 1e-12;
const JUMP_MIN = 1e-6; // 달러/시간. 이보다 작은 변화는 계단이 아니라 연속 변화다
const sgn = (d: number) => (d > SAME ? 1 : d < -SAME ? -1 : 0);
const diff = (a: number, b: number) => {
  if (a === Infinity && b === Infinity) return 0;
  return a - b;
};

export function findCrossovers(a: Curve, b: Curve, lo: number, hi: number, opts: { samples?: number; extraPoints?: number[] } = {}): CrossPoint[] {
  const events = [...new Set([lo, hi, ...a.events, ...b.events, ...(opts.extraPoints ?? [])])].filter((e) => e >= lo && e <= hi).sort((x, y) => x - y);
  const D = (l: number) => diff(a.cost(l), b.cost(l));
  const samples = opts.samples ?? 8;
  const out: CrossPoint[] = [];
  const who = (s: number): VendorId | null => (s > 0 ? b.vendor : s < 0 ? a.vendor : null); // D>0이면 b가 싸다
  let tieStart: number | null = null;
  let prevSign: number | null = null;
  const flush = (end: number) => {
    if (tieStart !== null) {
      if (end > tieStart + 1e-6) out.push({ a: a.vendor, b: b.vendor, lambda: tieStart, toLambda: end, kind: "tie", before: null, after: null });
      tieStart = null;
    }
  };
  for (let i = 0; i < events.length - 1; i++) {
    const e0 = events[i]!; const e1 = events[i + 1]!;
    if (e1 - e0 < 1e-9) continue;
    const eps = Math.min((e1 - e0) * 1e-4, 1e-6 * Math.max(1, e0));
    // 계단 바로 뒤 (왼쪽 연속: 정수에 닿은 값은 앞 구간에 속한다)
    let lastL = e0 + eps;
    let last = D(lastL);
    if (prevSign !== null && sgn(last) !== 0 && prevSign !== 0 && sgn(last) !== prevSign) {
      flush(e0);
      const atE0 = D(e0);
      const isJump = !Number.isFinite(atE0) || !Number.isFinite(last) || Math.abs(last - atE0) > JUMP_MIN;
      out.push({ a: a.vendor, b: b.vendor, lambda: e0, kind: isJump ? "jump" : "exact", before: who(prevSign), after: who(sgn(last)) });
    }
    for (let s = 1; s <= samples; s++) {
      const l = s === samples ? e1 : e0 + ((e1 - e0) * s) / samples;
      const v = D(l);
      const s0 = sgn(last); const s1 = sgn(v);
      if (s0 === 0 && tieStart === null) tieStart = lastL;
      if (s0 !== 0 && tieStart !== null) flush(lastL);
      if (s0 !== 0 && s1 !== 0 && s0 !== s1) {
        // 연속 구간의 근 (이분법)
        let x = lastL; let y = l;
        for (let it = 0; it < 80; it++) {
          const m = (x + y) / 2;
          if (sgn(D(m)) === s0) x = m; else y = m;
        }
        out.push({ a: a.vendor, b: b.vendor, lambda: (x + y) / 2, kind: "exact", before: who(s0), after: who(s1) });
      }
      if (s0 !== 0 && s1 === 0 && s < samples) {
        // 표본이 근에 정확히 닿은 경우
        const nxt = sgn(D(l + (e1 - e0) / samples / 2));
        if (nxt !== 0 && nxt !== s0) out.push({ a: a.vendor, b: b.vendor, lambda: l, kind: "exact", before: who(s0), after: who(nxt) });
      }
      last = v; lastL = l;
    }
    prevSign = sgn(last) !== 0 ? sgn(last) : prevSign;
  }
  flush(hi);
  // 같은 근이 구간 경계에서 두 번 잡히면 합친다
  const seen: CrossPoint[] = [];
  for (const c of out) {
    const prev = seen[seen.length - 1];
    if (prev && prev.kind === c.kind && Math.abs(prev.lambda - c.lambda) < 1e-6 * Math.max(1, c.lambda)) continue;
    seen.push(c);
  }
  return seen;
}

// 트래픽 구간별 최저 벤더. 경계 = 모든 계단 + 모든 쌍의 역전점
export function cheapestEnvelope(curves: Curve[], lo: number, hi: number, opts: { extraPoints?: number[] } = {}): EnvelopeSegment[] {
  const pts = new Set<number>([lo, hi, ...(opts.extraPoints ?? [])]);
  for (const c of curves) c.events.forEach((e) => pts.add(e));
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      for (const x of findCrossovers(curves[i]!, curves[j]!, lo, hi, opts)) pts.add(x.lambda);
    }
  }
  const sorted = [...pts].filter((x) => x >= lo && x <= hi).sort((x, y) => x - y);
  const segs: EnvelopeSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!; const b = sorted[i + 1]!;
    if (b - a < 1e-9) continue;
    const mid = (a + b) / 2;
    let bestV: VendorId | null = null; let best = Infinity;
    for (const c of curves) { const v = c.cost(mid); if (v < best - 1e-12) { best = v; bestV = c.vendor; } }
    const prev = segs[segs.length - 1];
    if (prev && prev.vendor === bestV) prev.toLambda = b;
    else segs.push({ fromLambda: a, toLambda: b, vendor: bestV });
  }
  return segs;
}
