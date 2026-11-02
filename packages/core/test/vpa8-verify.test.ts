// 검증 PA8: 상한 값 읽기 경계 (순수)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tenantMaxActive } from "../src/tenant-limit.js";
import { configProblems } from "@svc/contracts";

test("값 경계: 공백 포함 숫자·큰 수·지수·16진은 어떻게 읽나", () => {
  assert.equal(tenantMaxActive({ TENANT_MAX_ACTIVE: " 3 " }), 3);
  assert.equal(tenantMaxActive({ TENANT_MAX_ACTIVE: "1000000" }), 1000000);
  assert.equal(tenantMaxActive({ TENANT_MAX_ACTIVE: "1e2" }), 100);
  assert.equal(tenantMaxActive({ TENANT_MAX_ACTIVE: "Infinity" }), 0, "무한대는 정수가 아님 → 꺼짐");
  assert.equal(tenantMaxActive({ TENANT_MAX_ACTIVE: "-0" }), 0);
});

test("설정 검사: 음수·소수·글자는 시작 때 걸러지고 0·양의 정수는 통과", () => {
  const p = (v: string) => configProblems("api", { DATABASE_URL: "postgres://x/y", TENANT_MAX_ACTIVE: v }).filter((x) => x.startsWith("TENANT_MAX_ACTIVE"));
  for (const ok of ["0", "1", "50"]) assert.deepEqual(p(ok), [], ok);
  for (const no of ["-1", "1.5", "abc"]) assert.equal(p(no).length, 1, no);
});
