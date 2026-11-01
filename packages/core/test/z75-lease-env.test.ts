import { test } from "node:test";
import assert from "node:assert/strict";
import { leaseFromEnv, LEASE, SAME_JOB_TAKEOVER_LEFT_SEC, FENCE_SLACK_SEC } from "../src/envlock.js";

test("z75-20: env가 없으면 잠금 시간은 예전 그대로 90·30·60·600", () => {
  assert.deepEqual({ ...leaseFromEnv({}) }, { workerSec: 90, heartbeatSec: 30, selfFenceSec: 60, handBackSec: 600 });
  assert.equal(LEASE.workerSec - LEASE.selfFenceSec - FENCE_SLACK_SEC, SAME_JOB_TAKEOVER_LEFT_SEC);
});

test("z75-20: 기한만 45로 주면 연장 15·스스로 멈춤 30으로 따라간다", () => {
  assert.deepEqual({ ...leaseFromEnv({ ENVLOCK_WORKER_SEC: "45" }) }, { workerSec: 45, heartbeatSec: 15, selfFenceSec: 30, handBackSec: 600 });
  assert.equal(leaseFromEnv({ ENVLOCK_WORKER_SEC: "45", ENVLOCK_SELF_FENCE_SEC: "35" }).selfFenceSec, 35);
});

test("z75-20: 순서가 어긋나거나 숫자가 아니면 시작할 때 멈춘다", () => {
  assert.throws(() => leaseFromEnv({ ENVLOCK_WORKER_SEC: "45", ENVLOCK_SELF_FENCE_SEC: "60" }), /heartbeat < selfFence < worker/);
  assert.throws(() => leaseFromEnv({ ENVLOCK_SELF_FENCE_SEC: "20" }), /heartbeat < selfFence < worker/);
  assert.throws(() => leaseFromEnv({ ENVLOCK_WORKER_SEC: "abc" }), /positive integer/);
  assert.throws(() => leaseFromEnv({ ENVLOCK_WORKER_SEC: "0" }), /positive integer/);
});

test("Z38 R8-4: 스스로 멈춤 + 감시 간격(5초)이 기한보다 짧아야 한다", () => {
  assert.throws(() => leaseFromEnv({ ENVLOCK_WORKER_SEC: "45", ENVLOCK_SELF_FENCE_SEC: "41" }), /selfFence \+ 5 < worker/);
  assert.equal(leaseFromEnv({ ENVLOCK_WORKER_SEC: "45", ENVLOCK_SELF_FENCE_SEC: "39" }).selfFenceSec, 39);
  assert.throws(() => leaseFromEnv({ ENVLOCK_WORKER_SEC: "6" }), /selfFence \+ 5 < worker/);
});
