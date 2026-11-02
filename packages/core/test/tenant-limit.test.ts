import { test } from "node:test";
import assert from "node:assert/strict";
import { tenantMaxActive } from "../src/tenant-limit.js";

test("TENANT_MAX_ACTIVE: 없음·빈 값·0 = 꺼짐(0), 양의 정수만 상한", () => {
  assert.equal(tenantMaxActive({}), 0);
  assert.equal(tenantMaxActive({ TENANT_MAX_ACTIVE: "" }), 0);
  assert.equal(tenantMaxActive({ TENANT_MAX_ACTIVE: "0" }), 0);
  assert.equal(tenantMaxActive({ TENANT_MAX_ACTIVE: "3" }), 3);
});

test("거부: 음수·소수·숫자 아님은 상한으로 안 씀 (꺼짐)", () => {
  for (const v of ["-1", "1.5", "abc"]) assert.equal(tenantMaxActive({ TENANT_MAX_ACTIVE: v }), 0);
});
