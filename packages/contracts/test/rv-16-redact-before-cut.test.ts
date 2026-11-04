// RV-16: 자른 뒤 가리면 자른 끝이 ARN 계정·URL 비밀번호 가운데일 때 규칙이 안 맞는다 → 워커는 가린 뒤 자른다
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText } from "../src/index.js";

test("RV-16 자르고 가리면 새고(재현), 가리고 자르면 안 샌다", () => {
  const msg = `${"x".repeat(170)} User: arn:aws:iam::123456789012:role/svc-operate is not authorized`;
  const cut = msg.indexOf("123456789012") + 12;
  assert.match(redactText(msg.slice(0, cut)), /123456789012/);          // 예전 순서: 계정 번호 남음
  assert.doesNotMatch(redactText(msg).slice(0, cut), /123456789012/);   // 고친 순서
  const url = "fetch failed: postgres://app:supersecretpw@db.internal:5432/x";
  const ucut = url.indexOf("@");
  assert.match(redactText(url.slice(0, ucut)), /supersecretpw/);
  assert.doesNotMatch(redactText(url).slice(0, ucut), /supersecretpw/);
});
