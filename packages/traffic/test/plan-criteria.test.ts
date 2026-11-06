// 사람이 승인한 계획의 롤백 기준(plan rollbackCriteria)으로 판정한다. 예전엔 계획 값은 화면에만 쓰이고
// 판정은 RULE_DEFAULTS 만 봤다 (지금은 숫자가 같아 티가 안 났을 뿐, 계획을 바꿔도 판정이 안 바뀌었다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockLb, ruleFromCriteria, runShift, stubMetrics } from "../src/index.js";

const M = "55555555-5555-4555-8555-555555555555";
let clockMs = 0;
const fast = { sleep: async (ms: number) => { clockMs += ms; }, now: () => new Date(clockMs) };
const run = (scenario: "err" | "slow", c: { errorRatePct: number; p95Multiplier: number } | undefined) =>
  runShift({ migrationId: M, lbId: "lb", switcher: mockLb(), metrics: stubMetrics(scenario), rule: ruleFromCriteria(c), observeSec: 0, ...fast });

test("오류율 기준: 승인 값 20% 면 도착 5xx 10% 를 넘기고, 1% 면 되돌린다", async () => {
  assert.equal((await run("err", { errorRatePct: 20, p95Multiplier: 2 })).outcome, "reached_100");
  const r = await run("err", { errorRatePct: 1, p95Multiplier: 2 });
  assert.deepEqual([r.outcome, r.failureCode], ["rolled_back", "TRAFFIC_ERROR_RATE"]);
});

test("응답 시간 배수: 승인 값 4배면 약 2.7배 느린 도착을 넘기고, 2배면 되돌린다", async () => {
  assert.equal((await run("slow", { errorRatePct: 1, p95Multiplier: 4 })).outcome, "reached_100");
  const r = await run("slow", { errorRatePct: 1, p95Multiplier: 2 });
  assert.deepEqual([r.outcome, r.failureCode], ["rolled_back", "TRAFFIC_LATENCY"]);
});

test("계획이 없으면(옛 이전) 기본 규칙(5xx 1%) 그대로 되돌린다", async () => {
  assert.equal((await run("err", undefined)).failureCode, "TRAFFIC_ERROR_RATE");
});
