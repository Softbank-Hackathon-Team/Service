// Z19 재현 시험: H5(지표 조회 실패 중 가중치 방치), H3(롤백이 먼저 확정됐는데 shift가 가중치를 올림)
import { test } from "node:test";
import assert from "node:assert/strict";
import { runShift, stubCloudflareLb, stubMetrics, MigrationMoved, MAX_METRIC_ERRORS, type MetricsSource } from "../src/index.js";

const M = "55555555-5555-4555-8555-555555555555";
// 시계가 멈춰 있으니 Z20 M7(100%에서 시계로 관찰)은 0초로 둔다. 안 그러면 끝나지 않는다 (통합 때 발견)
const fast = { sleep: async () => {}, now: () => new Date("2026-11-07T01:00:00Z"), observeSec: 0 };

// pct% 단계에서 n번째 조회부터 m번 던지는 지표 (나머지는 정상)
function flaky(o: { atPct: number; from: number; times: number }): MetricsSource {
  const ok = stubMetrics("clean"); let k = 0;
  return { window: async (id, pct) => {
    if (pct === o.atPct && ++k >= o.from && k < o.from + o.times) throw new Error("prometheus 503");
    return ok.window(id, pct);
  } };
}

test("H5 지표가 50%에서 계속 실패 → 5번째에 긴급 롤백(TRAFFIC_METRICS_UNAVAILABLE), 가중치 출발 100%", async () => {
  const lb = stubCloudflareLb();
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: lb, metrics: flaky({ atPct: 50, from: 1, times: 999 }), ...fast });
  assert.equal(r.outcome, "rolled_back");
  assert.equal(r.failureCode, "TRAFFIC_METRICS_UNAVAILABLE");
  assert.match(r.rollbackReason!, new RegExp(`${MAX_METRIC_ERRORS}번 연속 실패 @50%`));
  assert.deepEqual(r.finalWeights, { source: 1, target: 0 });
});

test("H5 지표가 잠깐(4번) 실패하고 돌아오면 그대로 100%까지 (보류로만 셈)", async () => {
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: stubCloudflareLb(), metrics: flaky({ atPct: 10, from: 2, times: MAX_METRIC_ERRORS - 1 }), ...fast });
  assert.equal(r.outcome, "reached_100");
  assert.equal(r.judgements.length, 3 + 3 + 30, "실패한 조회는 판정에 안 들어간다");
});

test("H3 50%로 올리기 직전 상태가 바뀌었으면(guardSet이 MigrationMoved) 가중치를 안 바꾸고 paused", async () => {
  const lb = stubCloudflareLb(); const weights: number[] = [];
  let moved = false;
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: lb, metrics: stubMetrics("clean"), ...fast,
    onWeight: (p) => { weights.push(p); if (p === 10) moved = true; },   // 10% 단계 도중 사람이 롤백을 누름
    guardSet: async (apply) => { if (moved) throw new MigrationMoved("rolling_back"); await apply(); } });
  assert.equal(r.outcome, "paused");
  assert.deepEqual(weights, [10], "50%는 설정되지 않는다");
  assert.deepEqual(await lb.get("lb"), { source: 0.9, target: 0.1 }, "10%에서 멈춤: 출발 100%는 rollback 작업이 맞춘다");
});
