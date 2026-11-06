// 공유 흉내 판(MOCK_TRAFFIC=1)에서 이전 하나만 진짜 지표·진짜 LB 로 돌린다 (등록한 이전 = cf-check --register 로 DB 줄 + mock 아닌 전환기).
// 고치기 전: PROM_URL 은 워커 전역이라 넣으면 모든 이전이 Prometheus 로 판정됐고(mock LB 이전은 실측 몫이 안 맞음),
//   빼면 등록한 진짜 LB 이전도 가짜 정상 지표로 판정됐다
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mockLb, restoreSource } from "@svc/traffic";
import { missingTrafficConfig, registeredRealLb, trafficMetrics, trafficMetricsKind, trafficTickMs, type TrafficTargetKind } from "../src/platform.js";

const T = randomUUID();
const PROM = "http://prom:9090";
const REG: TrafficTargetKind = { from: "db", provider: "cloudflare" };        // cf-check --register 로 이 이전에만 등록한 진짜 LB
const ENV_MOCK: TrafficTargetKind = { from: "env", provider: "mock" };       // 공유 판의 다른 이전 (등록 없음)
const DB_MOCK: TrafficTargetKind = { from: "db", provider: "mock" };         // 등록했지만 mock 전환기
const ENV_REAL: TrafficTargetKind = { from: "env", provider: "cloudflare" }; // 워커 env TRAFFIC_PROVIDER (예전 길)
const STUB = { MOCK_TRAFFIC: "1" };

test("등록한 진짜 LB 만 진짜로: registeredRealLb", () => {
  assert.equal(registeredRealLb(REG), true);
  for (const t of [ENV_MOCK, DB_MOCK, ENV_REAL, { from: "db", provider: undefined } as TrafficTargetKind]) assert.equal(registeredRealLb(t), false, JSON.stringify(t));
});

test("흉내 판 + PROM_URL: 등록한 이전만 Prometheus, 나머지는 예전처럼 가짜 지표", () => {
  for (const env of [{ ...STUB, PROM_URL: PROM }, { MOCK_IAC: "1", PROM_URL: PROM }]) {
    assert.equal(trafficMetricsKind(REG, env), "prometheus", JSON.stringify(env));
    assert.equal(trafficMetricsKind(ENV_MOCK, env), "stub", JSON.stringify(env));
    assert.equal(trafficMetricsKind(DB_MOCK, env), "stub", JSON.stringify(env));
    assert.equal(trafficMetricsKind(ENV_REAL, env), "prometheus", "워커 env 진짜 전환기는 예전처럼 PROM_URL 이면 Prometheus");
    assert.equal(trafficMetrics(T, { target: REG }, env)?.source, "prometheus");
    assert.equal(trafficMetrics(T, { target: ENV_MOCK }, env)?.source, "stub");
    assert.equal(trafficMetrics(T, {}, env)?.source, "stub", "target 이 없으면 워커 env mock 전환기로 본다");
    assert.deepEqual(missingTrafficConfig("cloudflare", env, "db"), []);
    assert.deepEqual(missingTrafficConfig("mock", env, "env"), []);
  }
});

test("흉내 판 + PROM_URL 없음 거부: 등록한 진짜 LB 이전은 가짜 숫자로 판정하지 않고 PROM_URL 을 빠진 설정으로 낸다", () => {
  assert.equal(trafficMetricsKind(REG, STUB), "none");
  assert.equal(trafficMetrics(T, { target: REG }, STUB), undefined);
  assert.deepEqual(missingTrafficConfig("cloudflare", STUB, "db"), ["PROM_URL"]);
  assert.deepEqual(missingTrafficConfig("cloudflare", { MOCK_IAC: "1" }, "db"), ["PROM_URL"]);
  // 다른 이전은 예전 그대로 흉내로 돈다
  assert.equal(trafficMetricsKind(ENV_MOCK, STUB), "stub");
  assert.equal(trafficMetricsKind(DB_MOCK, STUB), "stub");
  assert.equal(trafficMetricsKind(ENV_REAL, STUB), "stub", "워커 env 진짜 전환기 + 가짜 지표는 예전 길 그대로");
  assert.deepEqual(missingTrafficConfig("mock", STUB), []);
  assert.deepEqual(missingTrafficConfig("cloudflare", STUB, "env"), []);
});

test("진짜 판(흉내 불허)은 예전 규칙 그대로: PROM_URL 이면 모두 Prometheus, 없으면 지표 없음", () => {
  for (const t of [REG, ENV_MOCK, DB_MOCK, ENV_REAL]) {
    assert.equal(trafficMetricsKind(t, { PROM_URL: PROM }), "prometheus", JSON.stringify(t));
    assert.equal(trafficMetricsKind(t, {}), "none", JSON.stringify(t));
  }
  assert.deepEqual(missingTrafficConfig("cloudflare", {}, "db"), ["PROM_URL"]);
  assert.deepEqual(missingTrafficConfig("mock", { PROM_URL: PROM }, "db"), ["TRAFFIC_PROVIDER"]);
});

test("판정 간격은 이 이전의 지표를 따른다 (Prometheus 1초, 가짜 20ms). kind 가 없으면 예전처럼 PROM_URL 로", () => {
  assert.equal(trafficTickMs("prometheus", {}), 1000);
  assert.equal(trafficTickMs("stub", { PROM_URL: PROM }), 20, "PROM_URL 이 있어도 흉내 이전은 20ms");
  assert.equal(trafficTickMs(undefined, { PROM_URL: PROM }), 1000);
  assert.equal(trafficTickMs(undefined, {}), 20);
  assert.equal(trafficTickMs("prometheus", { TRAFFIC_TICK_MS: "5" }), 5);
});

// 롤백(rollback.ts)은 restoreSource 에 trafficMetrics(회사, { target }) 를 넘긴다. 같은 모양으로 부른다
async function withProm(fn: (url: string, queries: string[]) => Promise<void>) {
  const queries: string[] = [];
  const srv = createServer((req, res) => {
    const q = new URL(req.url!, "http://prom").searchParams.get("query") ?? "";
    queries.push(q);
    // 출발 1000 요청 중 5xx 50 (5%) → 출발 건강 나쁨
    const v = q.startsWith("histogram_quantile") ? 0.12 : q.includes('code=~"5.."') ? 50 : 1000;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [0, String(v)] }] } }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, queries); } finally { srv.close(); }
}
const restore = (target: TrafficTargetKind, env: NodeJS.ProcessEnv) =>
  restoreSource({ switcher: mockLb({ source: 0.5, target: 0.5 }), lbId: "lb", migrationId: randomUUID(), sleep: async () => {},
    metrics: trafficMetrics(T, { target }, env) });

test("롤백: 흉내 판 + PROM_URL 이면 등록한 이전만 Prometheus 로 출발 5xx 를 보고, 다른 이전은 Prometheus 를 안 부른다", async () => {
  await withProm(async (url, queries) => {
    const env = { ...STUB, PROM_URL: url };
    const other = await restore(ENV_MOCK, env);
    assert.equal(queries.length, 0, "다른 이전은 Prometheus 질의 0");
    assert.equal(other.detail.sourceErrPct, 0, "가짜 지표 (예전 흉내 그대로)");
    assert.equal(other.evidence.sourceHealthy, true);
    const real = await restore(REG, env);
    assert.ok(queries.length > 0);
    assert.equal(real.detail.sourceErrPct, 5);
    assert.equal(real.evidence.sourceHealthy, false, "진짜 지표로 출발 5xx 를 잡는다");
    assert.equal(real.evidence.sourceWeight100, true);
  });
});

test("롤백 거부: 흉내 판 + PROM_URL 없음이면 등록한 이전은 가짜 0% 를 안 남긴다 (지표 없음), 되돌리기는 그대로 한다", async () => {
  const real = await restore(REG, STUB);
  assert.equal(real.evidence.sourceWeight100, true);
  assert.equal(real.detail.sourceErrPct, null, "못 잼 = null (가짜 숫자 0 이 아님)");
  const other = await restore(ENV_MOCK, STUB);
  assert.equal(other.detail.sourceErrPct, 0, "다른 이전은 예전처럼 가짜 지표");
});
