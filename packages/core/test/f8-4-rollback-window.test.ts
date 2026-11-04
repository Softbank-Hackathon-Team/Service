// F8-4: 롤백 가능 창 길이 = 환경변수(개발·시험 덮어쓰기) > 승인한 계획서 칸 > 기본 120초
import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanDoc } from "@svc/contracts";
import { PLAN_ROLLBACK_WINDOW_SEC, rollbackWindowSecFor } from "../src/advance.js";

test("계획서 칸이 있으면 그 값, 없으면 기본 120초(예전 3초 아님)", () => {
  assert.deepEqual(rollbackWindowSecFor({ rollbackWindowSec: 86400 }, {}), { sec: 86400, source: "plan" });
  assert.deepEqual(rollbackWindowSecFor(null, {}), { sec: 120, source: "default" });
  assert.deepEqual(rollbackWindowSecFor({}, { ROLLBACK_WINDOW_SEC: "  " }), { sec: 120, source: "default" });
  assert.equal(PLAN_ROLLBACK_WINDOW_SEC, 120);
});

test("환경변수는 덮어쓰기 (시험·데모): 계획서보다 앞선다", () => {
  assert.deepEqual(rollbackWindowSecFor({ rollbackWindowSec: 86400 }, { ROLLBACK_WINDOW_SEC: "3" }), { sec: 3, source: "env" });
});

test("거부: 계획서 칸은 0 이상 7일 이하 정수만", () => {
  const ok = PlanDoc.shape.rollbackWindowSec;
  assert.equal(ok.safeParse(120).success, true);
  assert.equal(ok.safeParse(undefined).success, true);
  for (const bad of [-1, 1.5, 7 * 86400 + 1, "120"]) assert.equal(ok.safeParse(bad).success, false, String(bad));
});
