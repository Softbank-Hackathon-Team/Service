// PF RV-09: apply·target-destroy 큐 기한이 terraform 예산 합에서 나온다 (단계 상한 합보다 큼)
import { test } from "node:test";
import assert from "node:assert/strict";
import { QUEUES, tfBudget } from "@svc/contracts";
import { POLICY } from "../src/boss.js";

test("PF RV-09 정상: 큐 기한 = tfBudget (apply 7200초, 지우기 3600초 이상)", () => {
  assert.equal(POLICY[QUEUES.apply]?.expireInSeconds, tfBudget().applyExpireSec);
  assert.equal(POLICY[QUEUES.targetDestroy]?.expireInSeconds, tfBudget().destroyExpireSec);
});
test("PF RV-09 거부: 기한이 init·plan·apply 단계 상한 합보다 작지 않다 (예전 3600 < 3×2700)", () => {
  const b = tfBudget();
  assert.ok((POLICY[QUEUES.apply]?.expireInSeconds ?? 0) > b.jobSec + b.graceSec + b.destroySec);
});
