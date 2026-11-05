// 자동 롤백 판정 (순수 함수). 전환 처리기가 1초마다 부른다.
// DECISION(team): 5xx > 1% 또는 p95 > 출발 × 2, 30초 창 (10/30 아키텍처 결정)
// DRAFT(ai): 아래 보호 장치(표본 하한, 5xx 개수 하한, 출발 대비 3배, 연속 2번, 지름길)는 트래픽 전환 설계 v1 PoC에서 찾은 값이다
export const RULE_DEFAULTS = {
  errRatio: 0.01,
  p95Factor: 2,
  minSamples: 100,
  minErrors: 3,
  relErrFactor: 3,
  minSourceSamples: 50,
  consecutive: 2,
  hardErrors: 20,
};
export type RuleOpts = typeof RULE_DEFAULTS;

// p95Ms 가 있으면 그 값을 쓴다 (Prometheus 처럼 이미 분위수를 계산해 주는 지표). 없으면 latenciesMs 로 계산
export interface Side { n: number; err5xx: number; latenciesMs: number[]; p95Ms?: number }
const sideP95 = (s: Side) => s.p95Ms ?? p95(s.latenciesMs);
export interface Window { target: Side; source: Side; baselineP95Ms: number }

export function p95(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

export type Reason = "error_rate" | "error_rate_hard" | "latency" | "insufficient_samples" | "ok";
export interface Evaluation {
  hit: boolean; reason: Reason;
  targetRatio: number; sourceRatio: number; targetP95Ms: number; refP95Ms: number;
  latencyMeasured: boolean;   // false 면 지연 조건을 판정하지 못했다 (NaN 비교는 항상 통과). 오류율로만 본 판정이다
}

export function evaluate(w: Window, opts: Partial<RuleOpts> = {}): Evaluation {
  const o = { ...RULE_DEFAULTS, ...opts };
  const { target: t, source: s } = w;
  const targetRatio = t.n > 0 ? t.err5xx / t.n : 0;
  const sourceRatio = s.n > 0 ? s.err5xx / s.n : 0;
  const targetP95Ms = sideP95(t);
  const refP95Ms = s.n >= o.minSourceSamples ? sideP95(s) : w.baselineP95Ms;
  const base = { targetRatio, sourceRatio, targetP95Ms, refP95Ms, latencyMeasured: Number.isFinite(targetP95Ms) && Number.isFinite(refP95Ms) };
  // 지름길: 도착이 통째로 죽었으면 표본 하한과 상관없이 바로
  if (t.err5xx >= o.hardErrors && targetRatio > 0.5) return { ...base, hit: true, reason: "error_rate_hard" };
  if (t.n < o.minSamples) return { ...base, hit: false, reason: "insufficient_samples" };
  if (targetRatio > o.errRatio && t.err5xx >= o.minErrors && targetRatio > o.relErrFactor * sourceRatio)
    return { ...base, hit: true, reason: "error_rate" };
  if (Number.isFinite(refP95Ms) && targetP95Ms > o.p95Factor * refP95Ms) return { ...base, hit: true, reason: "latency" };
  return { ...base, hit: false, reason: "ok" };
}

// 연속 판정: hit 가 consecutive 번 이어지면 롤백. 지름길은 한 번에
export function makeDecider(opts: Partial<RuleOpts> = {}) {
  const o = { ...RULE_DEFAULTS, ...opts };
  let streak = 0;
  return (w: Window) => {
    const e = evaluate(w, o);
    streak = e.hit ? streak + 1 : 0;
    return { ...e, streak, rollback: e.reason === "error_rate_hard" || streak >= o.consecutive };
  };
}
