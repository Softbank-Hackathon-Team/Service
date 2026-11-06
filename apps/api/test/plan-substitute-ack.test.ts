// 승인은 substitute 확인 항목까지 덮어야 한다 (PLAN_ACKS 게이트 missingAcks)
import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanDoc } from "@svc/contracts";
import { missingAcks } from "../src/routes/plans.js";

const plan = PlanDoc.parse({
  planId: "7f000000-0000-4000-8000-0000000000c2", migrationId: "4a8c0000-0000-4000-8000-0000000000c2", adapterVersion: "gcp-v2",
  steps: [], precheck: [], rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 }, tfPlanHash: "t", helmValuesHash: "h",
  acknowledgements: [
    { id: "cost", kind: "cost", text: "비용" },
    { id: "substitute:shop-cache", kind: "substitute", text: "ElastiCache → Memorystore", ref: "shop-cache",
      from: "ElastiCache (redis)", to: "Memorystore (redis)", lost: ["포트"], appChange: false },
  ],
  planHash: "p", expiresAt: "2026-11-07T02:00:00.000Z",
});

test("substitute 항목을 덮지 않은 승인은 그 id 가 빠졌다고 나온다", () => {
  assert.deepEqual(missingAcks(plan, ["cost"]), ["substitute:shop-cache"]);
  assert.deepEqual(missingAcks(plan, ["cost", "substitute:shop-cache"]), []);
});

test("구조 칸이 없는 옛 확인 항목도 계약을 통과한다", () => {
  assert.equal(PlanDoc.safeParse({ ...plan, acknowledgements: [{ id: "cost", kind: "cost", text: "비용" }] }).success, true);
  assert.equal(PlanDoc.safeParse({ ...plan, acknowledgements: [{ id: "x", kind: "substitute", text: "t", lost: "포트" }] }).success, false);
});
