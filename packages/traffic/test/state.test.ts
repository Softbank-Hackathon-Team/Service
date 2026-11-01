import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGuard } from "@svc/core";
import { runShift, shiftTransition, restoreSource, mockLb, stubMetrics, type MetricsSource } from "../src/index.js";

const M = "44444444-4444-4444-8444-444444444444";
// 가짜 시계: sleep(ms)가 시계를 ms만큼 민다 (M7: 관찰 시간은 시계로 잰다)
let clockMs = Date.parse("2026-11-07T01:00:00Z");
const fast = { sleep: async (ms: number) => { clockMs += ms; }, now: () => new Date(clockMs) };
const facts = { pausedFrom: null, failedAtStatus: null, rollbackWindowOver: false } as never;

test("100% 도달 → shifting→cutover 전이 조건(T22)을 core guard 가 그대로 통과", async () => {
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: mockLb(), metrics: stubMetrics("clean"), ...fast });
  const t = shiftTransition(r, { targetLogsSeen: true });
  assert.equal(t.to, "cutover");
  assert.equal(t.enqueue, "cutover");
  assert.deepEqual(t.evidence, { weightPct: 100, observedSec: 30, targetLogsSeen: true });
  assert.equal(checkGuard("shifting", "cutover", { facts, ev: t.evidence }), null);
  // 도착 로그를 못 받았으면 core 가 막는다
  assert.match(checkGuard("shifting", "cutover", { facts, ev: shiftTransition(r, { targetLogsSeen: false }).evidence })!, /target logs/);
});

test("지표 나쁨 → rolling_back + rollback 작업, 실패 코드 TRAFFIC_ERROR_RATE", async () => {
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: mockLb(), metrics: stubMetrics("err", { failAt: 50 }), ...fast });
  const t = shiftTransition(r, { targetLogsSeen: true });
  assert.deepEqual([t.to, t.enqueue, t.failureCode], ["rolling_back", "rollback", "TRAFFIC_ERROR_RATE"]);
  assert.equal(r.reachedPct, 0);
});

test("가중치 PATCH 가 계속 실패 → 출발로 되돌리기도 실패 → rollback_failed, 그래도 rolling_back 으로 간다", async () => {
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: mockLb(undefined, { failAllSets: true }), metrics: stubMetrics("clean"), ...fast });
  assert.equal(r.outcome, "rollback_failed");
  assert.equal(r.failureCode, "TRAFFIC_SWITCH_FAILED");
  assert.equal(shiftTransition(r, { targetLogsSeen: true }).to, "rolling_back");
});

test("일시정지: 50%에서 멈추면 가중치 유지, paused 조건(T30) 통과, 다시 시작은 50%부터", async () => {
  const lb = mockLb(); let ticks = 0;
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: lb, metrics: stubMetrics("clean"), ...fast,
    shouldPause: () => ++ticks > 4 });   // 10%에서 3번 + 50%에서 1번 판정 뒤 멈춤
  assert.equal(r.outcome, "paused");
  assert.deepEqual(r.finalWeights, { source: 0.5, target: 0.5 });
  const t = shiftTransition(r, { targetLogsSeen: true, pauseRule: "MG-3-01" });
  assert.equal(checkGuard("shifting", "paused", { facts, ev: t.evidence }), null);
  const weights: number[] = [];
  const r2 = await runShift({ migrationId: M, lbId: "lb", switcher: lb, metrics: stubMetrics("clean"), ...fast,
    resumeFromPct: 50, onWeight: (p) => { weights.push(p); } });
  assert.equal(r2.outcome, "reached_100");
  assert.deepEqual(weights, [50, 100]);   // 10% 로 다시 내리지 않는다
});

test("rollback 작업: 출발 100% 확인 → rolling_back→rolled_back 조건(T35) 통과, 두 번 불러도 같다", async () => {
  const lb = mockLb({ source: 0.5, target: 0.5 });
  const a = await restoreSource({ switcher: lb, lbId: "lb", migrationId: M, metrics: stubMetrics("clean"), sleep: async () => {} });
  assert.deepEqual(a.evidence, { sourceWeight100: true, sourceHealthy: true });
  assert.equal(checkGuard("rolling_back", "rolled_back", { facts, ev: a.evidence }), null);
  const sets = lb.calls.filter((c) => c.op === "set").length;
  const b = await restoreSource({ switcher: lb, lbId: "lb", migrationId: M, sleep: async () => {} });
  assert.equal(b.detail.alreadyRestored, true);
  assert.equal(lb.calls.filter((c) => c.op === "set").length, sets);   // 이미 되돌려졌으면 PATCH 안 함
});

test("rollback 작업: 출발도 아프면 sourceHealthy=false → core 가 rolled_back 을 막는다", async () => {
  const sick: MetricsSource = { async window() {
    return { target: { n: 0, err5xx: 0, latenciesMs: [] }, source: { n: 1000, err5xx: 50, latenciesMs: [] }, baselineP95Ms: 100 }; } };
  const r = await restoreSource({ switcher: mockLb(), lbId: "lb", migrationId: M, metrics: sick });
  assert.equal(r.evidence.sourceHealthy, false);
  assert.match(checkGuard("rolling_back", "rolled_back", { facts, ev: r.evidence })!, /source not healthy/);
});
