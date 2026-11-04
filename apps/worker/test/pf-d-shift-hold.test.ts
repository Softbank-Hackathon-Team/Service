// pf-d FM-TRF-15: shift 단계 관찰 초 = 승인 계획 holdSec. TRAFFIC_OBSERVE_SEC 를 명시했을 때만 덮어씀
import { test } from "node:test";
import assert from "node:assert/strict";
import { shiftObserveSec } from "../src/jobs/shift.js";

test("FM-TRF-15: env 없으면 계획 holdSec 그대로, 명시하면 env 로 덮어씀(계획 값은 남김)", () => {
  assert.deepEqual(shiftObserveSec(30, {}), { sec: 30, source: "plan", planHoldSec: 30 });
  assert.deepEqual(shiftObserveSec(45, {}), { sec: 45, source: "plan", planHoldSec: 45 });
  assert.deepEqual(shiftObserveSec(30, { TRAFFIC_OBSERVE_SEC: "4" }), { sec: 4, source: "env", planHoldSec: 30 });
  assert.deepEqual(shiftObserveSec(undefined, {}), { sec: 30, source: "default" });   // 옛 계획
});

test("FM-TRF-15 거부: 계획이 T22 최소보다 짧거나 env 가 빈 값·글자면 최소/계획으로 (조건이 꺼지지 않게)", () => {
  assert.deepEqual(shiftObserveSec(10, {}), { sec: 30, source: "plan", planHoldSec: 10 });            // T22 최소 30
  assert.deepEqual(shiftObserveSec(30, { TRAFFIC_OBSERVE_SEC: "" }), { sec: 30, source: "plan", planHoldSec: 30 });
  assert.deepEqual(shiftObserveSec(30, { TRAFFIC_OBSERVE_SEC: "abc" }), { sec: 30, source: "plan", planHoldSec: 30 });
  assert.deepEqual(shiftObserveSec(30, { TRAFFIC_OBSERVE_SEC: "4", PROM_URL: "http://p" }), { sec: 30, source: "env", planHoldSec: 30 });   // 진짜 지표면 30 밑으로 못 감
});

// pf-d hunt-traffic-ops-02: 관찰 초가 크면 shift 한 번이 큐 만료(3600초)를 넘어 도는 중에 만료·재시도된다 → 가중치 전에 막음
test("hunt-traffic-ops-02: 기본 30초 × 3단계 × (1+2) = 270초 는 통과, 몫 확인 끄면 100% 관찰만 셈", async () => {
  const { shiftBudget } = await import("../src/jobs/shift.js");
  assert.deepEqual(shiftBudget(3, 30, true), { worstSec: 270, limitSec: 3240, expireSec: 3600, over: false });
  assert.equal(shiftBudget(3, 400, false).worstSec, 400);
  assert.equal(shiftBudget(3, 400, false).over, false);
});

test("hunt-traffic-ops-02 거부: 관찰 400초 × 3단계 × 3 = 3600초 > 3240 → over (shift 는 paused TRAFFIC_OBSERVE_TOO_LONG)", async () => {
  const { shiftBudget } = await import("../src/jobs/shift.js");
  const b = shiftBudget(3, 400, true);
  assert.equal(b.worstSec, 3600);
  assert.equal(b.over, true);
  assert.equal(shiftBudget(3, 360, true).over, false, "360 × 9 = 3240 는 경계 안");
});
