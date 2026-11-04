// PF07 (운영자 실수): AWS 콘솔에 보이는 "1111-2222-3333" 모양 계정 번호를 그대로 붙여 넣어도 받는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAccountId, checkAccountId } from "../src/index.js";

test("AWS: 대시·빈칸 지운 12자리로 받음", () => {
  for (const raw of ["1234-5678-9012", " 1234 5678 9012 ", "123456789012"]) {
    const n = normalizeAccountId("aws", raw);
    assert.equal(n, "123456789012");
    assert.ok(checkAccountId("aws", n));
  }
});
test("거부: 자리 모자람·글자·GCP 는 대시를 안 지움", () => {
  assert.equal(checkAccountId("aws", normalizeAccountId("aws", "1234-5678-901")), false);
  assert.equal(checkAccountId("aws", normalizeAccountId("aws", "1234-5678-901x")), false);
  assert.equal(normalizeAccountId("gcp", " my-proj-123 "), "my-proj-123");
  assert.ok(checkAccountId("gcp", normalizeAccountId("gcp", " my-proj-123 ")));
});
