// 작업 Z49: 큐 확인 간격·NOTIFY 설정 (DB 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import { QUEUES } from "@svc/contracts";
import { workOptions, NOTIFY_QUEUES, WORKER_POLL_SEC } from "../src/boss.js";

test("Z49 workOptions: 기본 0.5초, NOTIFY 백업 폴링도 같은 간격 (cleanup 처럼 늦게 시작하는 작업이 안 늦어지게)", () => {
  const o = workOptions();
  assert.equal(o.pollingIntervalSeconds, WORKER_POLL_SEC);
  assert.equal(o.notifyPollingIntervalSeconds, o.pollingIntervalSeconds);
  if (process.env.WORKER_POLL_SEC === undefined) assert.equal(o.pollingIntervalSeconds, 0.5);
  assert.ok(o.pollingIntervalSeconds >= 0.5, "pg-boss 최소값 0.5");
});

test("Z49 NOTIFY 큐: 이전 단계 큐 10개만, workOptions 없이 받는 큐는 빼기", () => {
  assert.equal(NOTIFY_QUEUES.size, 10);
  for (const q of [QUEUES.agentRun, QUEUES.leaseReaper, QUEUES.idempotencyCleanup])
    assert.equal(NOTIFY_QUEUES.has(q), false, q);
  for (const q of [QUEUES.import, QUEUES.cleanup, QUEUES.rollback]) assert.ok(NOTIFY_QUEUES.has(q), q);
});
