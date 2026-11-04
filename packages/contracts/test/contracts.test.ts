import { test } from "node:test";
import assert from "node:assert/strict";
import { VALID, MIGRATION_STATUSES, TERMINAL } from "../src/index.js";

test("상태 22개, 전이 54개, 최종 3개는 나가는 길 없음", () => {
  assert.equal(MIGRATION_STATUSES.length, 22);
  const n = Object.values(VALID).reduce((a, v) => a + v.length, 0);
  assert.equal(n, 53);   // Z61 의 provisioning → paused 는 Z38 REVIEW-4 Z43-1 로 뺌 (재발급 실패도 failed)
  for (const s of TERMINAL) assert.equal(VALID[s].length, 0);
});
test("전이 목적지는 모두 실제 상태", () => {
  for (const to of Object.values(VALID).flat())
    assert.ok(MIGRATION_STATUSES.includes(to));
});
