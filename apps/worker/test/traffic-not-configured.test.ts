// 진짜 판(MOCK_IAC·MOCK_TRAFFIC 꺼짐)에서 트래픽 전환이 가짜 지표·mock 전환기로 조용히 돌지 않는다.
// 고치기 전: PROM_URL 이 없으면 trafficMetrics 가 늘 가짜 정상 지표(5xx 0, 약 120ms)를 줘서 자동 롤백이 걸릴 수 없었다
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { checkGuard, type GuardFacts } from "@svc/core";
import { mockLb, runShift, shiftTransition } from "@svc/traffic";
import { missingTrafficConfig, trafficMetrics } from "../src/platform.js";

const T = randomUUID();
const REAL: NodeJS.ProcessEnv = {};
const PROM = "http://prom:9090";

test("진짜 판: PROM_URL 이 없으면 가짜 정상 지표를 만들지 않는다 (시나리오 이름만으로는 흉내를 켜지 않는다)", () => {
  assert.equal(trafficMetrics(T, {}, REAL), undefined);
  assert.equal(trafficMetrics(T, {}, { TRAFFIC_STUB_SCENARIO: "clean" }), undefined);
});

test("진짜 판: 비어 있는 설정을 이름으로 낸다", () => {
  assert.deepEqual(missingTrafficConfig("mock", REAL), ["PROM_URL", "TRAFFIC_PROVIDER"]);
  assert.deepEqual(missingTrafficConfig("cloudflare", REAL), ["PROM_URL"]);
  assert.deepEqual(missingTrafficConfig("mock", { PROM_URL: PROM }), ["TRAFFIC_PROVIDER"]);
  assert.deepEqual(missingTrafficConfig("cloudflare", { PROM_URL: PROM }), []);
  assert.deepEqual(missingTrafficConfig("mock", { MOCK_TRAFFIC: "0" }), ["PROM_URL", "TRAFFIC_PROVIDER"]);
});

test("흉내는 명시 스위치로만: MOCK_TRAFFIC=1, 또는 도착을 흉내로 만든 판(MOCK_IAC=1)", () => {
  for (const env of [{ MOCK_TRAFFIC: "1" }, { MOCK_IAC: "1" }]) {
    assert.deepEqual(missingTrafficConfig("mock", env), [], JSON.stringify(env));
    assert.equal(trafficMetrics(T, {}, env)?.source, "stub", JSON.stringify(env));
  }
});

test("PROM_URL 이 있으면 Prometheus 응답으로 10·50·100% 를 판정하고, 100% 도착 표본으로 T22 를 넘는다", async () => {
  const sw = mockLb();
  const M = randomUUID();
  const REQS = 3000;
  const srv = createServer((req, res) => {
    const q = new URL(req.url!, "http://prom").searchParams.get("query") ?? "";
    void sw.get("lb").then((w) => {
      const share = q.includes('env="target"') ? w.target : w.source;
      const v = q.startsWith("histogram_quantile") ? 0.12 : q.includes('code=~"5.."') ? 0 : Math.round(REQS * share);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [0, String(v)] }] } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const env = { PROM_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
    assert.deepEqual(missingTrafficConfig("cloudflare", env), []);
    const metrics = trafficMetrics(T, {}, env);
    assert.equal(metrics?.source, "prometheus");
    let clock = 0;
    const r = await runShift({ migrationId: M, lbId: "lb", switcher: sw, metrics: metrics!, observeSec: 30, shareTolPct: 10, stepObserveSec: 1,
      now: () => new Date(clock), sleep: async () => { clock += 1000; } });
    assert.equal(r.outcome, "reached_100");
    assert.deepEqual(r.stepShares?.map((s) => [s.stepPct, s.observedPct]), [[10, 10], [50, 50], [100, 100]]);
    assert.equal(r.judgements.at(-1)?.samples, REQS);
    const t = shiftTransition(r, { targetLogsSeen: r.judgements.some((x) => x.stepPct === 100 && x.samples > 0) });
    assert.equal(t.to, "cutover");
    assert.equal(checkGuard("shifting", "cutover", { facts: {} as GuardFacts, ev: t.evidence }), null);
  } finally { srv.close(); }
});
