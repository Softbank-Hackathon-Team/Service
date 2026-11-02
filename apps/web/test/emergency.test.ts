import { test } from "node:test";
import assert from "node:assert/strict";
import { emergencyState } from "../legacy/src/emergency";
import { MIGRATION_STATUSES, VALID, TERMINAL } from "../legacy/src/types";

// 화면 비상 버튼(롤백·취소)이 상태 머신 표와 똑같이 켜지는지. 서버(control.ts)도 같은 표로 409를 낸다

test("롤백 버튼은 VALID[s]에 rolling_back이 있는 상태에서만 켜진다", () => {
  for (const s of MIGRATION_STATUSES) {
    const st = emergencyState({ status: s, rollbackWindowEndsAt: null });
    assert.equal(st.rollback.allowed, VALID[s].includes("rolling_back"), s);
    assert.equal(st.rollback.allowed ? st.rollback.why : typeof st.rollback.why, st.rollback.allowed ? null : "string", s);
  }
});

test("취소 버튼은 VALID[s]에 cancelled가 있는 상태에서만 켜진다", () => {
  for (const s of MIGRATION_STATUSES) {
    const st = emergencyState({ status: s, rollbackWindowEndsAt: null });
    assert.equal(st.cancel.allowed, VALID[s].includes("cancelled"), s);
  }
});

test("켜지는 상태 목록 (눈으로 보는 표)", () => {
  const on = (k: "rollback" | "cancel") =>
    MIGRATION_STATUSES.filter((s) => emergencyState({ status: s, rollbackWindowEndsAt: null })[k].allowed);
  assert.deepEqual(on("rollback"), ["deploying", "syncing", "shifting", "rollback_window", "paused"]);
  assert.deepEqual(on("cancel"),
    ["draft", "importing", "spec_review", "prechecking", "planning", "awaiting_approval", "approved", "failed", "rejected", "stale"]);
});

test("끝난 상태에서는 비상 버튼 자체를 숨긴다", () => {
  for (const s of TERMINAL) assert.equal(emergencyState({ status: s, rollbackWindowEndsAt: null }).show, false);
  assert.equal(emergencyState({ status: "rolling_back", rollbackWindowEndsAt: null }).show, true);
});

test("failed에서 취소는 정리 확인(manualCleanupConfirmed)을 같이 보낸다", () => {
  assert.equal(emergencyState({ status: "failed", rollbackWindowEndsAt: null }).cancel.needsCleanupConfirm, true);
  assert.equal(emergencyState({ status: "spec_review", rollbackWindowEndsAt: null }).cancel.needsCleanupConfirm, false);
});

test("DRAFT(ai): 롤백 가능 창이 끝나면 화면에서 롤백을 끈다", () => {
  const now = Date.parse("2026-11-07T10:00:00Z");
  const open = emergencyState({ status: "rollback_window", rollbackWindowEndsAt: "2026-11-07T10:00:05Z" }, now);
  const over = emergencyState({ status: "rollback_window", rollbackWindowEndsAt: "2026-11-07T09:59:59Z" }, now);
  assert.equal(open.rollback.allowed, true);
  assert.equal(over.rollback.allowed, false);
  assert.match(over.rollback.why ?? "", /창이 끝났/);
});

test("Z38 REVIEW-4 W-1: 정리 중 멈춤(paused, pausedFrom=cleanup)이면 롤백 버튼 꺼짐, 다른 단계에서 멈춤이면 켜짐", () => {
  const off = emergencyState({ status: "paused", pausedFrom: "cleanup", rollbackWindowEndsAt: null });
  assert.equal(off.rollback.allowed, false);
  assert.match(off.rollback.why ?? "", /재개/);
  for (const from of ["deploying", "syncing", "shifting"] as const)
    assert.equal(emergencyState({ status: "paused", pausedFrom: from, rollbackWindowEndsAt: null }).rollback.allowed, true);
});
