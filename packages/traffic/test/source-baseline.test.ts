// #245: 출발 응답 수 지표가 없을 때 전환 직전 요청 수를 기준으로 몫을 낸다. 지표가 있으면 지표가 먼저고, 추정값은 판정에 안 섞는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudflareLb, evaluate, observedTargetPct, prometheusMetrics, runShift, mockLb } from "../src/index.js";

const TENANT = "11111111-1111-4111-8111-111111111111", ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// 쿼리에 env="target" 이면 도착 수, env="source" 면 출발 수. null = 그 지표 줄이 없음. 5xx·p95 줄은 비운다
function prom(target: number, source: number | null) {
  return (async (url: string) => {
    const q = decodeURIComponent(url);
    const n = q.includes('code=~"5..') || q.includes("histogram_quantile") ? null : q.includes('env="target"') ? target : source;
    return { status: 200, json: async () => ({ status: "success", data: { result: n === null ? [] : [{ value: [0, String(n)] }] } }) };
  }) as never;
}
const metrics = (t: number, s: number | null, rps?: number) =>
  prometheusMetrics({ baseUrl: "http://p", tenantId: TENANT, baselineP95Ms: 200, fetch: prom(t, s), ...(rps ? { sourceBaselineRps: rps } : {}) });

test("출발 지표가 없으면 기준값으로 몫을 낸다. 추정값은 출발 수에 안 들어가 판정 기준 p95 는 그대로다", async () => {
  const w = await metrics(150, null, 50).window(ID, 10);
  assert.equal(w.estimatedSourceN, 1350);
  assert.equal(observedTargetPct(w), 10);
  assert.equal(w.source.n, 0);
  assert.equal(evaluate(w).refP95Ms, 200);
});

test("출발 지표가 있으면 값이 0 이어도 기준값을 안 쓰고, 기준값이 없으면 예전 그대로다", async () => {
  assert.equal((await metrics(150, 700, 50).window(ID, 10)).estimatedSourceN, undefined);
  const zero = await metrics(1500, 0, 50).window(ID, 100);
  assert.equal(zero.estimatedSourceN, undefined);
  assert.equal(observedTargetPct(zero), 100);
  assert.equal(observedTargetPct(await metrics(150, null).window(ID, 10)), 100);
});

test("거부: 도착이 기준값보다 많아도 추정 출발 수는 음수가 되지 않는다", async () => {
  assert.equal((await metrics(2000, null, 50).window(ID, 100)).estimatedSourceN, 0);
});

test("기준값이 있으면 출발 지표 없이 10·50·100 몫 확인을 지나 끝까지 간다", async () => {
  let ms = Date.parse("2026-11-07T01:00:00Z");
  const r = await runShift({ migrationId: ID, lbId: "lb", switcher: mockLb(), shareTolPct: 10, stepObserveSec: 2, observeSec: 2, now: () => new Date(ms), sleep: async (d) => { ms += d; },
    metrics: { source: "prometheus", window: (_i, pct) => metrics(Math.round(1500 * pct / 100), null, 50).window(ID, pct) } });
  assert.equal(r.outcome, "reached_100", JSON.stringify(r.rollbackReason));
  assert.deepEqual(r.stepShares?.map((s) => s.observedPct), [10, 50, 100]);
});

test("Cloudflare: 출발 풀의 켜진 원본 주소만 돌려준다", async () => {
  const seen: string[] = [];
  const fetch = (async (url: string) => {
    seen.push(url);
    const result = url.endsWith("/zones/z1") ? { account: { id: "acc" } }
      : { origins: [{ address: "shop.elb.amazonaws.com" }, { address: "off.example.com", enabled: false }] };
    return { status: 200, headers: { get: () => null }, json: async () => ({ success: true, result }), text: async () => JSON.stringify({ success: true, result }) };
  }) as never;
  const sw = cloudflareLb({ zoneId: "z1", sourcePoolId: "src", targetPoolId: "dst", token: async () => "t", fetch, baseUrl: "http://cf" });
  assert.deepEqual(await sw.sourceOrigins!(), ["shop.elb.amazonaws.com"]);
  assert.ok(seen[1]!.endsWith("/accounts/acc/load_balancers/pools/src"), seen[1]);
});
