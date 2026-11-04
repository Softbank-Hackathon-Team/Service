// pf-d RV-11: shift 도중 플랫폼 DB 오류 → 가중치가 반쯤 바뀐 채 작업이 죽지 않게, 이전 행 잠금은 PATCH 한 번 동안만
import { test } from "node:test";
import assert from "node:assert/strict";
import { runShift, setAndVerify, stubCloudflareLb, stubMetrics, MigrationMoved, MAX_METRIC_ERRORS, TRAFFIC_PLATFORM_ERROR, type TrafficSwitcher } from "../src/index.js";

const M = "55555555-5555-4555-8555-555555555555";
const fast = { sleep: async () => {}, now: () => new Date("2026-11-07T01:00:00Z"), observeSec: 0 };
const dbDown = () => new Error("connection terminated unexpectedly");

test("RV-11: 50% 로 올리는 guardSet 이 DB 오류로 두 번 실패 → 작업이 안 죽고 출발 100% + paused(TRAFFIC_PLATFORM_ERROR)", async () => {
  const lb = stubCloudflareLb(); const weights: number[] = [];
  let fails = 0;
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: lb, metrics: stubMetrics("clean"), ...fast,
    onWeight: (p) => { weights.push(p); },
    guardSet: async (apply) => { if (weights.includes(10)) { fails++; throw dbDown(); } await apply(); } });
  assert.equal(r.outcome, "paused");
  assert.equal(r.failureCode, TRAFFIC_PLATFORM_ERROR);
  assert.match(r.rollbackReason!, /단계 50% 플랫폼 오류: connection terminated.*출발 100%/);
  assert.equal(fails, 2, "한 번 더 해 보고 되돌림");
  assert.deepEqual(r.finalWeights, { source: 1, target: 0 });
  assert.deepEqual(weights, [10, 0]);
});

test("RV-11: guardSet 이 한 번만 실패(잠깐 끊김)하면 다시 해서 그대로 100% 까지", async () => {
  let once = true;
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: stubCloudflareLb(), metrics: stubMetrics("clean"), ...fast,
    guardSet: async (apply) => { if (once) { once = false; throw dbDown(); } await apply(); } });
  assert.equal(r.outcome, "reached_100");
  assert.deepEqual(r.finalWeights, { source: 0, target: 1 });
});

test("RV-11: 상태 확인(shouldPause) 이 50% 에서 연속 실패 → 출발 100% + paused, 잠깐(4번)이면 계속", async () => {
  let k = 0, at50 = false;
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: stubCloudflareLb(), metrics: stubMetrics("clean"), ...fast,
    onWeight: (p) => { at50 = p === 50; },
    shouldPause: async () => { if (at50) throw dbDown(); return false; } });
  assert.equal(r.outcome, "paused");
  assert.equal(r.failureCode, TRAFFIC_PLATFORM_ERROR);
  assert.match(r.rollbackReason!, new RegExp(`상태 확인 ${MAX_METRIC_ERRORS}번 연속 실패 @50%`));
  assert.deepEqual(r.finalWeights, { source: 1, target: 0 });
  const ok = await runShift({ migrationId: M, lbId: "lb", switcher: stubCloudflareLb(), metrics: stubMetrics("clean"), ...fast,
    shouldPause: async () => { if (++k <= MAX_METRIC_ERRORS - 1) throw dbDown(); return false; } });
  assert.equal(ok.outcome, "reached_100");
});

test("RV-11: 잠금(guard) 안에서는 PATCH 만. 확인 GET·재시도 대기는 잠금 밖", async () => {
  const lb = stubCloudflareLb(); let inGuard = false; const log: string[] = [];
  let firstGet = true;
  const sw: TrafficSwitcher = { ...lb,
    set: async (id, w) => { log.push(`set:${inGuard}`); await lb.set(id, w); },
    // 첫 확인은 다른 값을 읽음 → 재시도 (대기도 잠금 밖이어야 함)
    get: async (id) => { log.push(`get:${inGuard}`); if (firstGet) { firstGet = false; return { source: 1, target: 0 }; } return lb.get(id); } };
  await setAndVerify(sw, "lb", { source: 0.5, target: 0.5 }, { sleep: async () => { log.push(`sleep:${inGuard}`); },
    guard: async (set) => { inGuard = true; try { await set(); } finally { inGuard = false; } } });
  assert.deepEqual(log, ["set:true", "get:false", "sleep:false", "set:true", "get:false"]);
});

test("RV-11 거부: 상태가 바뀌었으면(MigrationMoved) 재시도·되돌림 없이 paused, 가중치 그대로 (롤백 작업이 맡음)", async () => {
  const lb = stubCloudflareLb(); let calls = 0; let moved = false;
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: lb, metrics: stubMetrics("clean"), ...fast,
    onWeight: (p) => { if (p === 10) moved = true; },
    guardSet: async (apply) => { if (moved) { calls++; throw new MigrationMoved("rolling_back"); } await apply(); } });
  assert.equal(r.outcome, "paused");
  assert.equal(r.failureCode, null);
  assert.equal(calls, 1);
  assert.deepEqual(await lb.get("lb"), { source: 0.9, target: 0.1 });
});
