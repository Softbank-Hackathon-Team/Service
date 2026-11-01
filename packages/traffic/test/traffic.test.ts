import { test } from "node:test";
import assert from "node:assert/strict";
import { TrafficJudgement } from "@svc/contracts";
import { evaluate, makeDecider, runShift, stubCloudflareLb, stubMetrics, checkWeights, InvalidWeights } from "../src/index.js";

const M = "44444444-4444-4444-8444-444444444444";
// 가짜 시계: sleep(ms)가 시계를 ms만큼 민다 (M7: 관찰 시간은 시계로 잰다)
let clockMs = Date.parse("2026-11-07T01:00:00Z");
const fast = { sleep: async (ms: number) => { clockMs += ms; }, now: () => new Date(clockMs) };
const side = (n: number, err: number, ms: number) => ({ n, err5xx: err, latenciesMs: Array(n).fill(ms) });

test("판정: 표본 100 미만은 보류, 출발도 아프면 롤백 아님, 지연 2배는 롤백", () => {
  assert.equal(evaluate({ target: side(80, 5, 100), source: side(500, 0, 100), baselineP95Ms: 100 }).reason, "insufficient_samples");
  assert.equal(evaluate({ target: side(200, 4, 100), source: side(500, 5, 100), baselineP95Ms: 100 }).hit, false);
  assert.equal(evaluate({ target: side(200, 0, 300), source: side(500, 0, 100), baselineP95Ms: 100 }).reason, "latency");
  assert.equal(evaluate({ target: side(30, 25, 100), source: side(500, 0, 100), baselineP95Ms: 100 }).reason, "error_rate_hard");
});

test("판정: 한 번 걸린 것은 롤백 아님, 연속 2번이면 롤백", () => {
  const d = makeDecider();
  const bad = { target: side(200, 10, 100), source: side(500, 0, 100), baselineP95Ms: 100 };
  const good = { target: side(200, 0, 100), source: side(500, 0, 100), baselineP95Ms: 100 };
  assert.equal(d(bad).rollback, false);
  assert.equal(d(good).rollback, false);
  assert.equal(d(bad).rollback, false);
  assert.equal(d(bad).rollback, true);
});

test("정상: 10→50→100% 도달, 판정은 모두 TrafficJudgement 계약 통과", async () => {
  const lb = stubCloudflareLb(); const weights: number[] = [];
  const r = await runShift({ migrationId: M, lbId: "lb1", switcher: lb, metrics: stubMetrics("clean"), onWeight: (p) => { weights.push(p); }, ...fast });
  assert.equal(r.outcome, "reached_100");
  assert.deepEqual(weights, [10, 50, 100]);
  assert.deepEqual(r.finalWeights, { source: 0, target: 1 });
  r.judgements.forEach((j) => TrafficJudgement.parse(j));
  assert.equal(r.judgements.length, 3 + 3 + 30);
});

test("50%에서 5xx 10% → 롤백, 가중치 0으로 되돌림", async () => {
  const lb = stubCloudflareLb();
  const r = await runShift({ migrationId: M, lbId: "lb1", switcher: lb, metrics: stubMetrics("err", { failAt: 50 }), ...fast });
  assert.equal(r.outcome, "rolled_back");
  assert.match(r.rollbackReason!, /error_rate @50%/);
  assert.deepEqual(r.finalWeights, { source: 1, target: 0 });
});

test("도착이 통째로 죽으면 첫 판정에서 지름길 롤백", async () => {
  const r = await runShift({ migrationId: M, lbId: "lb1", switcher: stubCloudflareLb(), metrics: stubMetrics("down"), ...fast });
  assert.equal(r.outcome, "rolled_back");
  assert.equal(r.judgements.length, 1);
  assert.equal(r.judgements[0]!.verdict, "bad_shortcut");
});

test("가중치는 0.1 단위, 합 1만 허용 (Cloudflare 제약)", () => {
  assert.throws(() => checkWeights({ source: 0.95, target: 0.05 }), InvalidWeights);
  assert.throws(() => checkWeights({ source: 0.5, target: 0.6 }), InvalidWeights);
  checkWeights({ source: 0.9, target: 0.1 });
});
