// pf-d FM-TRF-13: 컷오버가 끝나면 LB fallback 을 도착으로 (전환기 mock = TRAFFIC_PROVIDER 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackToTarget } from "../src/jobs/cutover.js";
import { trafficSwitcher } from "../src/platform.js";

test("FM-TRF-13: fallbackToTarget 은 fallback 을 도착으로 바꾸고 결과를 돌려준다", async () => {
  delete process.env.TRAFFIC_PROVIDER;
  assert.deepEqual(await fallbackToTarget({ lbId: "lb-1", switcher: trafficSwitcher() }), { to: "target", ok: true });
  assert.equal(await trafficSwitcher().getFallback!("lb-1"), "target");
});

test("FM-TRF-13 거부: 바꾸기가 실패해도 던지지 않고 ok:false + 이유 (컷오버는 되돌리지 않음)", async () => {
  const sw = trafficSwitcher();
  const orig = sw.setFallback;
  (sw as { setFallback?: unknown }).setFallback = async () => { throw new Error("cloudflare 503"); };
  try { assert.deepEqual(await fallbackToTarget({ lbId: "lb-2", switcher: sw }), { to: "target", ok: false, error: "cloudflare 503" }); }
  finally { (sw as { setFallback?: unknown }).setFallback = orig; }
});
