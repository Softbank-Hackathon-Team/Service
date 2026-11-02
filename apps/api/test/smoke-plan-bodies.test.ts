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

test("DEMOFLAGS: 깃발 꺼짐(없음·빈칸·0)이어도 acks·planHash 를 보낸다 (서버 깃발과 smoke 깃발이 따로 놀아 409 나던 것)", () => {
  for (const v of [undefined, "", "0", "true"]) {
    const b = smokePlanBodies(plan, { PLAN_ACKS: v });
    assert.deepEqual(b.approve, { decision: "approve", planHash: plan.planHash, acks: ["cost", "failure_cost_policy"] });
    assert.deepEqual(b.start, { planHash: plan.planHash });
  }
});

test("확인 항목이 없으면 acks 키를 안 보낸다 (시작엔 planHash)", () => {
  const b = smokePlanBodies({ planHash: "x" }, { PLAN_ACKS: "1" });
  assert.deepEqual(b.approve, { decision: "approve", planHash: "x" });
  assert.deepEqual(b.start, { planHash: "x" });
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

// DEMOFLAGS: demo-day 의 api 깃발은 DEMO_DAY_PLAN_ACKS=1 일 때만 (dry-run 줄로 확인, 클라우드 호출 없음)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const DD = new URL("../../../tools/demo-day.sh", import.meta.url).pathname;
function ddProgress(env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dd-"));
  spawnSync("bash", [DD, "up", "--dry-run", "--fg"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: dir, DEMO_DAY_LOG_DIR: dir, ...env } });
  return readFileSync(join(dir, "progress.log"), "utf8");
}
test("demo-day: 기본은 api 깃발 PLAN_ACKS 를 안 건다 (발표 화면 승인이 409 가 되지 않게)", () => {
  assert.match(ddProgress({}), /dev:api & \(PLAN_ACKS=기본\)/);
});
test("demo-day: DEMO_DAY_PLAN_ACKS=1 이면 api 를 PLAN_ACKS=1 로 띄운다", () => {
  assert.match(ddProgress({ DEMO_DAY_PLAN_ACKS: "1" }), /dev:api & \(PLAN_ACKS=1\)/);
  assert.match(ddProgress({ DEMO_DAY_PLAN_ACKS: "0" }), /PLAN_ACKS=기본/);
});
