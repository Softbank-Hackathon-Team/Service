// Z20 (리뷰 Z10 M7·M9)
import { test } from "node:test";
import assert from "node:assert/strict";
import { runShift, shiftTransition, mockLb, stubMetrics, switcherFromEnv } from "../src/index.js";

const M = "44444444-4444-4444-8444-444444444444";
// 가짜 시계: sleep(ms) 가 시계를 민다. 워커처럼 판정 간격을 tickMs 로 준다
function clock(tickMs: number) {
  let t = Date.parse("2026-11-07T01:00:00Z");
  return { now: () => new Date(t), sleep: async (ms: number) => { t += ms === 1000 ? tickMs : ms; } };
}

test("M7: 판정 간격 20ms(가짜 지표)여도 관찰 30초를 시계로 채운다. observedSec 는 실제 경과 초", async () => {
  const c = clock(20);
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: mockLb(), metrics: stubMetrics("clean"), ...c });
  assert.equal(r.outcome, "reached_100");
  assert.ok(r.observedSecAt100 >= 30 && r.observedSecAt100 < 30.1, `${r.observedSecAt100}`);
  assert.equal(r.observeRequiredSec, 30);
  // 예전 계산(판정 수 × 1초)이면 0.6초 관찰에 30이 찍혔다. 지금은 판정이 1500번 쌓인다
  assert.ok(r.judgements.filter((j) => j.stepPct === 100).length >= 1400);
});

test("M7: 압축 데모(observeSec 0.5) → observedSec 는 0.6 근처, T22 기본 문턱(30초)은 통과 못 함", async () => {
  const c = clock(20);
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: mockLb(), metrics: stubMetrics("clean"), ...c, observeSec: 0.5 });
  assert.equal(r.outcome, "reached_100");
  assert.ok(r.observedSecAt100 >= 0.5 && r.observedSecAt100 < 1, `${r.observedSecAt100}`);
  const t = shiftTransition(r, { targetLogsSeen: true });
  assert.ok((t.evidence.observedSec ?? 0) < 30, "압축 관찰을 30초로 부풀리지 않는다");
});

test("M7: 판정이 다 찼고 시계만 기다리는 동안은 '판정 부족' 롤백으로 세지 않는다", async () => {
  const c = clock(20);
  const r = await runShift({ migrationId: M, lbId: "lb", switcher: mockLb(), metrics: stubMetrics("clean"), ...c, maxTicksPerStep: 100 });
  assert.equal(r.outcome, "reached_100");
});

test("M9: CLOUDFLARE_* 이름으로 켜진다, 옛 CF_* 도 받는다, 비면 두 이름을 다 알려준다", () => {
  const tokens = () => async () => "t";
  const base = { TRAFFIC_PROVIDER: "cloudflare", CLOUDFLARE_SOURCE_POOL_ID: "a", CLOUDFLARE_TARGET_POOL_ID: "b", TRAFFIC_LB_ID: "lb" };
  assert.equal(switcherFromEnv({ ...base, CLOUDFLARE_ZONE_ID: "z" }, { tokens }).provider, "cloudflare");
  assert.equal(switcherFromEnv({ ...base, CLOUDFLARE_ZONE_NAME: "softbank-team-iron.com" }, { tokens }).provider, "cloudflare");
  assert.equal(switcherFromEnv({ TRAFFIC_PROVIDER: "cloudflare", CF_ZONE_ID: "z", CF_SOURCE_POOL_ID: "a", CF_TARGET_POOL_ID: "b", TRAFFIC_LB_ID: "lb" }, { tokens }).provider, "cloudflare");
  assert.throws(() => switcherFromEnv({ TRAFFIC_PROVIDER: "cloudflare", CLOUDFLARE_ZONE_NAME: "x", TRAFFIC_LB_ID: "lb" }, { tokens }), /CLOUDFLARE_SOURCE_POOL_ID \(옛 이름 CF_SOURCE_POOL_ID\)/);
  assert.throws(() => switcherFromEnv(base, { tokens }), /CLOUDFLARE_ZONE_ID.*CLOUDFLARE_ZONE_NAME/);
});
// zone 이름 → ID 조회는 Z14 가 넣었고 providers.test.ts 가 본다
