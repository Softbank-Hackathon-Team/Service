import { test } from "node:test";
import assert from "node:assert/strict";
import { liveHeadline, REASON_TEXT, type LiveTrafficView } from "../src/liveTraffic";

// 작업 Z35: 가동 중 앱 칸 맨 위 한 줄
const base: LiveTrafficView = { migrationId: "x", available: true, source: "proxy", fetchedAt: "", total: 12345, ok: 12345, fail: 0, c4xx: 0,
  p50Ms: 6, p95Ms: 11.8, held: 0, maxHoldMs: 0, mode: "hold", switchedAt: null, since: null, byState: [] };

test("실패 0 이면 초록, 숫자는 천 단위 쉼표", () => {
  assert.deepEqual(liveHeadline(base), { text: "요청 12,345건 · 실패 0 (0.00%) · p95 11.8 ms", tone: "ok" });
});
test("실패가 있으면 빨강 + 비율", () => {
  const h = liveHeadline({ ...base, total: 200, ok: 198, fail: 2, p95Ms: null });
  assert.equal(h.tone, "bad"); assert.equal(h.text, "요청 200건 · 실패 2 (1.00%) · p95 —");
});
test("숫자 없음 이유는 전부 문장이 있다", () => {
  assert.equal(liveHeadline({ ...base, available: false, reason: "unreachable" }).tone, "muted");
  for (const k of ["not_configured", "unreachable", "bad_shape", "other_migration", "no_counters"] as const) assert.ok(REASON_TEXT[k].length > 10);
});
