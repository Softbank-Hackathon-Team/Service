// #245: 도착 응답 시간 지표가 없으면(cloudflared) 지연 조건을 못 본다. 0ms 정상처럼 남기지 않고 "지연 미측정"으로 남긴다
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, mockLb, prometheusMetrics, runShift, stubMetrics, type MetricsSource } from "../src/index.js";
import type { FetchLike } from "../src/providers/http.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TEN = "11111111-1111-4111-8111-111111111111";
function clock() {
  let ms = Date.parse("2026-11-07T01:00:00Z");
  return { now: () => new Date(ms), sleep: async (d: number) => { ms += d; } };
}
const noP95 = (err5xx: number): MetricsSource => ({
  source: "prometheus",
  window: async () => ({ target: { n: 200, err5xx, latenciesMs: [], p95Ms: NaN }, source: { n: 0, err5xx: 0, latenciesMs: [], p95Ms: NaN }, baselineP95Ms: 200 }),
});

test("Prometheus: 지연 지표가 없으면 p95 는 0 이 아니라 NaN, 요청 수는 그대로 0", async () => {
  const f: FetchLike = async (url) => {
    const q = decodeURIComponent(url.split("query=")[1]!);
    const result = q.startsWith("histogram_quantile") || q.includes('env="source"') ? [] : [{ value: [0, q.includes('code=~"5.."') ? "1" : "200"] }];
    return { status: 200, json: async () => ({ status: "success", data: { result } }) };
  };
  const w = await prometheusMetrics({ baseUrl: "http://prom:9090", tenantId: TEN, fetch: f, baselineP95Ms: 200 }).window(ID, 10);
  assert.deepEqual([w.target.n, w.target.err5xx], [200, 1]);
  assert.ok(Number.isNaN(w.target.p95Ms));
  assert.equal(w.source.n, 0);
  assert.equal(evaluate(w).latencyMeasured, false);
});

test("정상: 지표가 있으면 측정됨, 기록에 표시 없음", async () => {
  const r = await runShift({ migrationId: ID, lbId: "lb", switcher: mockLb(), metrics: stubMetrics("clean"), ...clock(), observeSec: 1 });
  assert.equal(r.outcome, "reached_100");
  assert.equal(r.latencyUnmeasured, undefined);
  assert.ok(r.judgements.every((j) => j.latencyMeasured === undefined));
});

test("p95 없이 오류율만 정상: 100% 까지 가고, 판정과 결과에 미측정이 남는다", async () => {
  const r = await runShift({ migrationId: ID, lbId: "lb", switcher: mockLb(), metrics: noP95(0), ...clock(), observeSec: 1 });
  assert.equal(r.outcome, "reached_100");
  assert.equal(r.latencyUnmeasured, true);
  assert.ok(r.judgements.length > 0 && r.judgements.every((j) => j.latencyMeasured === false));
});

test("거부: p95 가 없어도 오류율이 나쁘면 되돌린다", async () => {
  const r = await runShift({ migrationId: ID, lbId: "lb", switcher: mockLb(), metrics: noP95(20), ...clock(), observeSec: 1 });
  assert.equal(r.outcome, "rolled_back");
  assert.equal(r.failureCode, "TRAFFIC_ERROR_RATE");
  assert.equal(r.latencyUnmeasured, true);
});
