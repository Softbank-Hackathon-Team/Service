// PF-A4 (3회차 비용·네트워크): 가져오기 재시도는 대기를 두고 늘린다 (대기 0초면 짧은 끊김에도 몇 초 안에 시도를 다 써서 failed)
import { test } from "node:test";
import assert from "node:assert/strict";
import { POLICY } from "@svc/core";
import { QUEUES } from "@svc/contracts";
import { IMPORT_MAX_ATTEMPTS } from "../src/jobs/import.js";

test("PF-A4: import 큐 재시도 = 3번, 10초부터 늘림 → 처리기 상한(IMPORT_MAX_ATTEMPTS)과 맞음", () => {
  const p = POLICY[QUEUES.import]!;
  assert.equal(p.retryLimit, 3);
  assert.equal(p.retryDelay, 10);
  assert.equal(p.retryBackoff, true);
  assert.equal(IMPORT_MAX_ATTEMPTS, p.retryLimit + 1, "첫 시도 + 재시도 3번 = 처리기가 failed 로 보내는 시도 수");
});
