// 묶음 FLAGSALL: smoke 가 PLAN_ACKS=1 서버에서도 한 바퀴 도는 본문을 만든다
import { test } from "node:test";
import assert from "node:assert/strict";
import { smokePlanBodies } from "../../../tools/smoke-env.js";

const plan = { planHash: "h".repeat(64), acknowledgements: [{ id: "cost" }, { id: "failure_cost_policy" }] };

test("PLAN_ACKS=1: 승인에 acks, 시작에 planHash", () => {
  const b = smokePlanBodies(plan, { PLAN_ACKS: "1" });
  assert.deepEqual(b.approve, { decision: "approve", planHash: plan.planHash, acks: ["cost", "failure_cost_policy"] });
  assert.deepEqual(b.start, { planHash: plan.planHash });
});

test("깃발 꺼짐(없음·빈칸·0): 예전 본문 그대로 (acks 없음, 시작 본문 비어 있음)", () => {
  for (const v of [undefined, "", "0", "true"]) {
    const b = smokePlanBodies(plan, { PLAN_ACKS: v });
    assert.deepEqual(b.approve, { decision: "approve", planHash: plan.planHash });
    assert.deepEqual(b.start, {});
  }
});

test("깃발 켜짐이어도 확인 항목이 없으면 acks 키를 안 보낸다", () => {
  const b = smokePlanBodies({ planHash: "x" }, { PLAN_ACKS: "1" });
  assert.deepEqual(b.approve, { decision: "approve", planHash: "x" });
});
