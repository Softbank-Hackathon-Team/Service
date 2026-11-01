// z75-38: 단계 전환 조건 = 판정 수 + 최소 관찰 시간 + 실측 도착 몫이 목표 ±10%p. 못 미치면 재관찰 2번 뒤 paused
import { test } from "node:test";
import assert from "node:assert/strict";
import { runShift, observedTargetPct, SHARE_TOL_PCT, mockLb, stubMetrics, type MetricsSource, type ShiftProgress } from "../src/index.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function clock() {
  let ms = Date.parse("2026-11-07T01:00:00Z");
  return { now: () => new Date(ms), sleep: async (d: number) => { ms += d; } };
}
// 지표 창이 가중치를 늦게 따라온다: 단계가 바뀐 뒤 처음 lagCalls 번은 옛 몫으로 센다 (엣지 전파·30초 창 흉내)
function laggingMetrics(lagCalls: number, stuckAt?: number): MetricsSource {
  const clean = stubMetrics("clean");
  let cur = 0, prev = 0, calls = 0;
  return {
    async window(id, pct) {
      if (pct !== cur) { prev = cur; cur = pct; calls = 0; }
      calls++;
      const seen = stuckAt !== undefined ? stuckAt : calls <= lagCalls ? prev : pct;
      const w = await clean.window(id, seen);
      return w;
    },
  };
}

test("observedTargetPct: 도착 / 전체, 표본 0 이면 null", () => {
  assert.equal(observedTargetPct({ target: { n: 47 }, source: { n: 53 } }), 47);
  assert.equal(observedTargetPct({ target: { n: 0 }, source: { n: 0 } }), null);
});

test("실측 몫 확인을 안 켜면 예전 그대로 (stepShares 없음)", async () => {
  const c = clock();
  const r = await runShift({ migrationId: ID, lbId: "lb", switcher: mockLb(), metrics: stubMetrics("clean"), ...c, observeSec: 1 });
  assert.equal(r.outcome, "reached_100");
  assert.equal(r.stepShares, undefined);
});

test("지표가 바로 따라오면 단계마다 0초에 도달, 최소 관찰 시간은 채운다", async () => {
  const c = clock();
  const t0 = c.now().getTime();
  const seen: ShiftProgress[] = [];
  const r = await runShift({ migrationId: ID, lbId: "lb", switcher: mockLb(), metrics: stubMetrics("clean"), ...c,
    observeSec: 5, shareTolPct: SHARE_TOL_PCT, stepObserveSec: 5, onProgress: (p) => { seen.push(p); } });
  assert.equal(r.outcome, "reached_100");
  assert.deepEqual(r.stepShares!.map((s) => [s.stepPct, s.observedPct, s.reobserve]), [[10, 10, 0], [50, 50, 0], [100, 100, 0]]);
  assert.ok(r.stepShares!.every((s) => s.reachedAfterSec !== null && s.reachedAfterSec <= 1.1));
  // 10%·50% 각 5초 이상 + 100% 30번 판정(30초)
  assert.ok((c.now().getTime() - t0) / 1000 >= 5 + 5 + 30);
  assert.ok(seen.length > 0 && seen.every((p) => p.reached === true));
});

test("지표가 늦게 따라오면 기다렸다가 넘어간다 (재관찰 안에서 도달)", async () => {
  const c = clock();
  // 단계마다 처음 5번(=5초)은 옛 몫. 판정 3번(3초) 만으로는 못 넘어가고 재관찰 1번 안에 도달
  const r = await runShift({ migrationId: ID, lbId: "lb", switcher: mockLb(), metrics: laggingMetrics(5), ...c,
    observeSec: 1, shareTolPct: SHARE_TOL_PCT, stepObserveSec: 0 });
  assert.equal(r.outcome, "reached_100");
  const s10 = r.stepShares!.find((s) => s.stepPct === 10)!;
  // 0% → 10% 는 차이가 10%p 라 옛 몫(0)도 폭 안 → 바로 통과. 10 → 50 은 늦게 도달
  assert.equal(s10.reobserve, 0);
  const s50 = r.stepShares!.find((s) => s.stepPct === 50)!;
  assert.ok(s50.reobserve >= 1 && s50.reobserve <= 2, `reobserve ${s50.reobserve}`);
  assert.equal(s50.observedPct, 50);
  assert.ok(s50.reachedAfterSec !== null && s50.reachedAfterSec >= 5);
});

test("재관찰 2번 뒤에도 몫이 안 맞으면 paused (TRAFFIC_SHARE_NOT_REACHED), 가중치는 그대로", async () => {
  const c = clock();
  const lb = mockLb();
  const r = await runShift({ migrationId: ID, lbId: "lb", switcher: lb, metrics: laggingMetrics(0, 30), ...c,
    observeSec: 1, shareTolPct: SHARE_TOL_PCT, stepObserveSec: 2 });
  // 10% 단계: 실측 30% → 폭 밖. 50% 단계로 안 간다
  assert.equal(r.outcome, "paused");
  assert.equal(r.failureCode, "TRAFFIC_SHARE_NOT_REACHED");
  assert.equal(r.reachedPct, 10);
  assert.deepEqual(r.finalWeights, { source: 0.9, target: 0.1 });
  assert.deepEqual(r.stepShares, [{ stepPct: 10, observedPct: 30, reachedAfterSec: null, reobserve: 2 }]);
  assert.match(r.rollbackReason ?? "", /재관찰 2번/);
});
