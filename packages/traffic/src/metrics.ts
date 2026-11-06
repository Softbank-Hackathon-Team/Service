import type { Window } from "./rule.js";
import type { FetchLike } from "./providers/http.js";

// 두 Ingress의 최근 30초 지표를 읽는 쪽. 진짜는 중앙 Prometheus 질의다.
export interface MetricsSource {
  window(migrationId: string, targetPct: number): Promise<Window>;
  // pf-d FM-TRF-10: 지표 출처. "stub" 이면 몫·오류율이 가중치에서 계산한 값이다 (실측 아님). 없으면 모름
  source?: "prometheus" | "stub";
}

// DRAFT(ai): 계약 문서 미정 2번 추천안. 두 클러스터에서 같은 이름을 쓰고 관측 표시를 붙인다
// tenant·environment 는 OTel 게이트웨이가 지표 토큰으로 덮어쓴다. env(source|target)·migration 은 보낸 쪽이 붙인다
export const METRIC_NAMES = {
  requests: "svc_ingress_requests_total",                 // 표시: tenant, environment, env, migration, code
  latency: "svc_ingress_request_duration_seconds_bucket", // 표시: tenant, environment, env, migration, le
} as const;

// 순수 함수: 한 쪽(source|target)의 30초 창 PromQL 세 줄. 매개변수는 따옴표 안에 넣기 전에 걸러 낸다
// tenant 조건: 다른 회사가 이 이전 번호를 붙여 밀어도 판정에 안 섞인다 (tenant 는 게이트웨이가 덮어쓴 값)
export function promQueries(tenantId: string, migrationId: string, side: "source" | "target", windowSec = 30) {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error("tenantId 형식이 아니다 (PromQL 주입 방지)");
  if (!/^[0-9a-f-]{36}$/i.test(migrationId)) throw new Error("migrationId 형식이 아니다 (PromQL 주입 방지)");
  const sel = `tenant="${tenantId}",migration="${migrationId}",env="${side}"`;
  const w = `${windowSec}s`;
  return {
    total: `sum(increase(${METRIC_NAMES.requests}{${sel}}[${w}]))`,
    err5xx: `sum(increase(${METRIC_NAMES.requests}{${sel},code=~"5.."}[${w}]))`,
    p95: `histogram_quantile(0.95, sum by (le) (rate(${METRIC_NAMES.latency}{${sel}}[${w}])))`,
  };
}

// Prometheus HTTP API (/api/v1/query) 로 창 하나를 읽는다.
// p95 는 Prometheus 가 계산한 값을 p95Ms 로 넘긴다 (원래 지연 목록은 안 가져온다)
// DRAFT(ai): 출발 쪽 표본이 모자랄 때 쓰는 기준 p95 는 전환 직전 10초 값을 부르는 쪽이 넣는다 (baselineP95Ms)
// #245: sourceBaselineRps = 전환 직전 출발의 초당 요청 수. 출발 응답 수 지표가 없을 때만 "전체(기준값) - 도착" 을 추정 출발 수로 내서 몫 계산에 쓴다. 지표가 있으면 지표가 먼저다
export function prometheusMetrics(o: { baseUrl: string; tenantId: string; fetch?: FetchLike; baselineP95Ms: number; windowSec?: number;
  authHeader?: () => Promise<string | undefined>; sourceBaselineRps?: number }): MetricsSource {
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  async function scalar(q: string, missing = 0): Promise<number> {
    const url = `${o.baseUrl.replace(/\/$/, "")}/api/v1/query?query=${encodeURIComponent(q)}`;
    const auth = await o.authHeader?.();
    const res = await f(url, { method: "GET", headers: auth ? { authorization: auth } : {} });
    const body = await res.json() as { status?: string; data?: { result?: Array<{ value?: [number, string] }> } };
    if (res.status >= 400 || body.status !== "success") throw new Error(`Prometheus 질의 실패 HTTP ${res.status}`);
    const v = body.data?.result?.[0]?.value?.[1];
    const n = v === undefined ? missing : Number(v);
    return Number.isFinite(n) ? n : NaN;   // 표본 0 이면 histogram_quantile 이 NaN
  }
  async function side(id: string, s: "source" | "target") {
    const q = promQueries(o.tenantId, id, s, o.windowSec);
    // 지연 지표가 없으면(cloudflared 도착) p95 결과가 빈 줄이다. 0ms 가 아니라 NaN = 못 잼 (rule.ts latencyMeasured)
    // 응답 수 줄이 없으면(NaN) 지표가 없는 것. 값 0 은 지표가 있고 요청이 없는 것이라 구분한다
    const [total, err, p95s] = await Promise.all([scalar(q.total, NaN), scalar(q.err5xx), scalar(q.p95, NaN)]);
    return { n: Number.isNaN(total) ? 0 : Math.round(total), err5xx: Math.round(err), latenciesMs: [] as number[], p95Ms: p95s * 1000, absent: Number.isNaN(total) };
  }
  return {
    source: "prometheus",
    async window(id) {
      const [{ absent: _t, ...target }, { absent, ...source }] = await Promise.all([side(id, "target"), side(id, "source")]);
      return { target, source, baselineP95Ms: o.baselineP95Ms,
        ...(absent && o.sourceBaselineRps ? { estimatedSourceN: Math.max(0, Math.round(o.sourceBaselineRps * (o.windowSec ?? 30)) - target.n) } : {}) };
    },
  };
}

// STUB: 가짜 지표. 시나리오별로 결정적인 숫자를 만든다 (랜덤 없음, 시험이 흔들리지 않게)
// clean = 정상, err = 도착 5xx 10%, slow = 도착 p95 3배, down = 도착 전부 5xx, failAt = 그 비율부터 나빠짐
export function stubMetrics(scenario: "clean" | "err" | "slow" | "down", o: { rps?: number; failAt?: number } = {}): MetricsSource {
  const rps = o.rps ?? 50;
  const failAt = o.failAt ?? 0;
  return {
    source: "stub",
    async window(_id, pct) {
      const total = rps * 30;
      const tn = Math.round(total * pct / 100), sn = total - tn;
      const bad = pct >= failAt ? scenario : "clean";
      const lat = (n: number, ms: number) => Array.from({ length: n }, (_, i) => ms + (i % 20));
      const tErr = bad === "err" ? Math.round(tn * 0.1) : bad === "down" ? tn : 0;
      const tMs = bad === "slow" ? 360 : 120;
      return {
        target: { n: tn, err5xx: tErr, latenciesMs: lat(tn, tMs) },
        source: { n: sn, err5xx: 0, latenciesMs: lat(sn, 120) },
        baselineP95Ms: 139,
      };
    },
  };
}
