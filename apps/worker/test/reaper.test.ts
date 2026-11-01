import { test } from "node:test";
import assert from "node:assert/strict";
import { decideReap } from "../src/lease/reaper.js";

test("청소: 승인됐는데 시작 못 한 예약 → 낡음", () => {
  assert.deepEqual(decideReap({ holder: "reserved", status: "approved" }), { kind: "stale" });
});
test("청소: 워커가 쥔 채 기한 지남 → 실패(WORKER_LOST), 실패 길이 없으면 일시정지", () => {
  assert.deepEqual(decideReap({ holder: "worker:w1", status: "provisioning" }),
    { kind: "fail", to: "failed", code: "WORKER_LOST" });
  assert.deepEqual(decideReap({ holder: "worker:w1", status: "syncing" }),
    { kind: "fail", to: "paused", code: "WORKER_LOST" });
  assert.deepEqual(decideReap({ holder: "reserved", status: "deploying" }),
    { kind: "fail", to: "paused", code: "JOB_NOT_PICKED" });
});
test("청소: 끝난 이전의 잠금은 지우기만", () => {
  assert.deepEqual(decideReap({ holder: "reserved", status: "completed" }), { kind: "release" });
});
