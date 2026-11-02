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

// E2E-v7: IMPORT_IR=v2 검토 칸 confirm 본문
import { smokeConfirmBody } from "../../../tools/smoke-env.js";
test("smokeConfirmBody: v2 검토 칸 전부 + v1 칸이 남으면 components.<앱>.resources", () => {
  assert.deepEqual(smokeConfirmBody({ version: 3, needsReview: ["service.cpu"], needsReviewV2: ["components.w.probes"], spec: { app: { name: "shop-api" } } }),
    { baseVersion: 3, confirm: ["components.w.probes", "components.shop-api.resources"] });
  assert.deepEqual(smokeConfirmBody({ version: 1, needsReview: [], needsReviewV2: ["components.shop-api.resources"], spec: { app: { name: "shop-api" } } }),
    { baseVersion: 1, confirm: ["components.shop-api.resources"] });
});
test("거부: 검토 칸이 없거나 v1 판(needsReviewV2 없음)이면 null → PATCH 안 보냄", () => {
  assert.equal(smokeConfirmBody({ version: 1, needsReview: [], needsReviewV2: [] }), null);
  assert.equal(smokeConfirmBody({ version: 1, needsReview: ["service.cpu"], spec: { app: { name: "a" } } }), null);
});
