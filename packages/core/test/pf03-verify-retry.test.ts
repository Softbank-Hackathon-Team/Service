// PF03 FM-NET: 연결 확인 작업은 재시도 간격이 있어야 한다 (대기 0 이면 몇 초 끊김에 4번을 다 쓰고 PLATFORM_ERROR)
import { test } from "node:test";
import assert from "node:assert/strict";
import { QUEUES } from "@svc/contracts";
import { POLICY } from "../src/boss.js";

test("verify-connection: 재시도 3번, 5초부터 늘어나는 간격", () => {
  const p = POLICY[QUEUES.verifyConnection]!;
  assert.equal(p.retryLimit, 3); assert.equal(p.retryDelay, 5); assert.equal(p.retryBackoff, true);
});

test("거부: 주기 훑기(verify-sweep)는 재시도 없음 그대로 (다음 일정이 다시 봄)", () => {
  assert.equal(POLICY[QUEUES.verifySweep]!.retryLimit, 0);
});
