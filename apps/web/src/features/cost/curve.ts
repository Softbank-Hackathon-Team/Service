import type { EnvEstimate, Provider } from '../../lib/types';

// 월 비용 곡선(계획 승인 "월 비용 (추정)" 카드)의 순수 계산. 시험은 test/cost-curve.test.ts
// x = 초당 피크 요청(로그 눈금), y = 한 달 비용(USD). 점은 서버 POST /cost/estimate 를 요청 수마다 불러 얻는다.

/** 곡선을 그릴 요청 수 (조건 바꿔 보기 슬라이더와 같은 범위 1~8000, 로그로 고르게) */
export const RPS_SAMPLES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 4000, 8000] as const;
export const RPS_MIN = 1;
export const RPS_MAX = 8000;

/**
 * 한 환경의 한 달 비용. 온프레는 처음 환경을 갖출 때 드는 하드웨어 고정비(parts.fixed, 월로 나눈 값)를 뺀다 (11/08 사용자 결정).
 * 계산할 수 없으면(용량 초과·가격 없음) null → 곡선을 끊는다
 */
export function curveCost(env: Pick<EnvEstimate, 'provider' | 'feasible' | 'monthlyUsd' | 'parts'> | undefined): number | null {
  if (!env || !env.feasible || env.monthlyUsd === null) return null;
  return Math.max(0, env.monthlyUsd - (env.provider === 'onprem' ? env.parts.fixed : 0));
}

export type CurvePoint = { rps: number; usd: number | null };

/** 견적 묶음(요청 수마다 envs) → 환경 하나의 점들 */
export const curveOf = (samples: readonly { rps: number; envs: readonly EnvEstimate[] }[], provider: Provider): CurvePoint[] =>
  samples.map((sample) => ({ rps: sample.rps, usd: curveCost(sample.envs.find((env) => env.provider === provider)) }));

/** 로그 x 눈금: 요청 수 → 0..1 */
export const xOf = (rps: number) => (Math.log10(Math.max(RPS_MIN, rps)) - Math.log10(RPS_MIN)) / (Math.log10(RPS_MAX) - Math.log10(RPS_MIN));
/** 0..1 → 요청 수 (정수) */
export const rpsAt = (x: number) => Math.round(10 ** (Math.log10(RPS_MIN) + Math.min(1, Math.max(0, x)) * (Math.log10(RPS_MAX) - Math.log10(RPS_MIN))));

/** 끊긴 곳(null) 없이 이어진 조각들 */
export function segments(points: readonly CurvePoint[]): { rps: number; usd: number }[][] {
  const out: { rps: number; usd: number }[][] = [];
  let run: { rps: number; usd: number }[] = [];
  for (const point of points) {
    if (point.usd === null) {
      if (run.length) out.push(run);
      run = [];
    } else run.push({ rps: point.rps, usd: point.usd });
  }
  if (run.length) out.push(run);
  return out;
}

/**
 * 단조 3차 보간(Fritsch–Carlson) 기울기. 점 사이가 출렁이지 않아 비용이 없던 꼭대기·바닥을 만들지 않는다.
 * xs 는 늘어나는 순서
 */
function slopes(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  if (n < 2) return new Array(n).fill(0);
  const d = xs.slice(1).map((x, i) => (ys[i + 1]! - ys[i]!) / (x - xs[i]!));
  const m = [d[0]!, ...d.slice(1).map((v, i) => (v * d[i]! <= 0 ? 0 : (v + d[i]!) / 2)), d[n - 2]!];
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  return m;
}

/** 화면 좌표 점들 → 부드러운 SVG 경로 (단조 3차 → 베지어) */
export function smoothPath(pts: readonly { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0]!.x},${pts[0]!.y}`;
  const m = slopes(pts.map((p) => p.x), pts.map((p) => p.y));
  let path = `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const q = pts[i + 1]!;
    const h = (q.x - p.x) / 3;
    path += ` C${(p.x + h).toFixed(1)},${(p.y + m[i]! * h).toFixed(1)} ${(q.x - h).toFixed(1)},${(q.y - m[i + 1]! * h).toFixed(1)} ${q.x.toFixed(1)},${q.y.toFixed(1)}`;
  }
  return path;
}

/** 요청 수 rps 에서 곡선 값 (그린 곡선과 같은 보간, x 는 로그). 곡선이 끊긴 곳이거나 범위 밖이면 null */
export function valueAt(points: readonly CurvePoint[], rps: number): number | null {
  const x = xOf(rps);
  for (const run of segments(points)) {
    const xs = run.map((p) => xOf(p.rps));
    const ys = run.map((p) => p.usd);
    if (x < xs[0]! || x > xs[xs.length - 1]!) continue;
    if (run.length === 1) return ys[0]!;
    const m = slopes(xs, ys);
    const i = Math.min(xs.length - 2, Math.max(0, xs.findIndex((v, k) => x >= v && x <= xs[k + 1]!)));
    const h = xs[i + 1]! - xs[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h * m[i + 1]!;
  }
  return null;
}

/** y 축 눈금: 0 부터 위로 1·2·5 단위 3~4칸, 맨 위 값은 가장 큰 비용보다 크게 */
export function yTicks(max: number): number[] {
  const top = Math.max(1, max) * 1.1;
  const raw = top / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v < top + step; v += step) {
    ticks.push(v);
    if (v >= top) break;
  }
  return ticks;
}

/** x 축 눈금 */
export const X_TICKS = [1, 10, 100, 1000, 8000] as const;
export const rpsLabel = (rps: number) => (rps >= 1000 ? `${Number((rps / 1000).toFixed(1))}k` : String(rps));
