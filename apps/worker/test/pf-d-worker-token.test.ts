// pf-d FM-TRF-18: 워커는 가중치만 바꾸는 토큰을 따로 받는다 (cf-check 의 풀·모니터 권한 토큰과 나눔)
import { test } from "node:test";
import assert from "node:assert/strict";
import { workerCfToken } from "../src/platform.js";

test("FM-TRF-18: CLOUDFLARE_WORKER_API_TOKEN 이 있으면 그것, 없으면 예전 토큰", () => {
  assert.equal(workerCfToken({ CLOUDFLARE_WORKER_API_TOKEN: "w", CLOUDFLARE_API_TOKEN: "all" }), "w");
  assert.equal(workerCfToken({ CLOUDFLARE_API_TOKEN: "all" }), "all");
  assert.equal(workerCfToken({ CF_API_TOKEN: "old" }), "old");
});

test("FM-TRF-18 거부: 토큰이 하나도 없으면 이름을 알려 주며 던진다 (빈 값 = 없음)", () => {
  assert.throws(() => workerCfToken({ CLOUDFLARE_WORKER_API_TOKEN: "" }), /CLOUDFLARE_WORKER_API_TOKEN/);
});
