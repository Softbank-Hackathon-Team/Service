// Z43: 상태 묶음(core states.ts)이 전이 표(VALID)와 맞물리는지, 예전 각 파일의 값과 같은지 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { VALID, TERMINAL, MIGRATION_STATUSES } from "@svc/contracts";
import { failureEdge, INACTIVE_STATES, LOCKED_STAGES, REPLANNABLE_FAILURES, canMove } from "../src/states.js";

test("failureEdge: failed 길 우선, 없으면 paused, 둘 다 없으면 null (리퍼·죽은 작업 처리 공통 규칙)", () => {
  for (const s of MIGRATION_STATUSES) {
    const want = VALID[s].includes("failed") ? "failed" : VALID[s].includes("paused") ? "paused" : null;
    assert.equal(failureEdge(s), want, s);
  }
  assert.equal(failureEdge("syncing"), "paused");
  assert.equal(failureEdge("cutover"), "failed");
  assert.equal(failureEdge("rollback_window"), null);
});

test("예전 값 그대로: 리퍼 DONE, 워커 LOCKED_STAGES, guards REPLANNABLE_FAILURES", () => {
  assert.deepEqual([...INACTIVE_STATES].sort(), ["cancelled", "completed", "rejected", "rolled_back", "stale"]);
  for (const s of TERMINAL) assert.ok(INACTIVE_STATES.includes(s));
  assert.deepEqual([...LOCKED_STAGES], ["provisioning", "deploying", "syncing", "shifting", "cutover",
    "rollback_window", "cleanup", "rolling_back", "paused"]);
  assert.deepEqual([...REPLANNABLE_FAILURES], ["importing", "prechecking", "planning", "provisioning"]);
  for (const s of REPLANNABLE_FAILURES) assert.ok(canMove(s, "failed"), `${s} → failed 길이 있어야 다시 계획할 수 있다`);
});

test("canMove는 VALID 그대로", () => {
  for (const a of MIGRATION_STATUSES) for (const b of MIGRATION_STATUSES)
    assert.equal(canMove(a, b), VALID[a].includes(b), `${a}>${b}`);
});
