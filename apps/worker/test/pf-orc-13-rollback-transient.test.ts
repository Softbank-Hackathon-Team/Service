// PF FM-ORC-13: 롤백 중 Cloudflare 429·연결 끊김·5xx 는 "기다리면 풀림"으로 보고 늘어나는 대기로 다시 넣는다 (DB 불필요한 판정 부분)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "@svc/traffic";
import { transientTrafficError, rollbackTransientDelaysSec } from "../src/jobs/_transient.js";

test("FM-ORC-13 정상: 429·연결 끊김·5xx (원인 사슬 안이어도) → 일시 오류", () => {
  assert.equal(transientTrafficError(new ProviderError("cloudflare", 429, "Cloudflare PATCH 실패: rate limited")), "rate_limited");
  assert.equal(transientTrafficError(new ProviderError("cloudflare", 0, "fetch failed")), "network");
  assert.equal(transientTrafficError(new ProviderError("cloudflare", 503, "x")), "http_503");
  assert.equal(transientTrafficError(new Error("wrap", { cause: new ProviderError("cloudflare", 429, "x") })), "rate_limited");
  assert.deepEqual(rollbackTransientDelaysSec({}), [60, 120, 300, 300, 300, 300]);
  assert.ok(rollbackTransientDelaysSec({}).every((n) => n < 600), "반납 잠금 기한(600초)보다 짧아야 리퍼가 안 끼어듦");
});

test("FM-ORC-13 거부: 토큰·권한(403)·없는 LB(404)·DB 오류는 일시 오류가 아님 → 예전처럼 횟수에 셈", () => {
  assert.equal(transientTrafficError(new ProviderError("cloudflare", 403, "forbidden", { retryable: false })), null);
  assert.equal(transientTrafficError(new ProviderError("cloudflare", 404, "no lb", { retryable: false })), null);
  assert.equal(transientTrafficError(new Error("db rollback failed: 429 rows")), null);
  assert.deepEqual(rollbackTransientDelaysSec({ ROLLBACK_TRANSIENT_RETRY_SEC: "" }), []);
  assert.deepEqual(rollbackTransientDelaysSec({ ROLLBACK_TRANSIENT_RETRY_SEC: "5, 9999, x" }), [5, 540]);
});
