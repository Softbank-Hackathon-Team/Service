// 계획 확인 항목 substitute: 도착 Builder substitutionsV2 승인 행 → 계획서 acknowledgements
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, type ApprovalRowV2, type PlanCostSummary } from "@svc/contracts";
import { targetBuilderFor } from "@svc/adapters";
import { ONE } from "./demo-one.js";
import { buildPlanDoc } from "../src/jobs/plan.js";

const cost: PlanCostSummary = { currency: "USD", monthlyTarget: 80, monthlySource: 100, deltaMonthly: -20, unknownFields: [] };
const base = {
  planId: "7f000000-0000-4000-8000-0000000000c1", migrationId: "4a8c0000-0000-4000-8000-0000000000c1", spec: ONE,
  target: { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp" as const, region: "default" },
  precheck: [], now: new Date("2026-11-07T00:00:00Z"), source: { provider: "aws" as const }, costSummary: cost,
};
const row: ApprovalRowV2 = { kind: "substitute", subject: "shop-cache", from: "ElastiCache (redis)", to: "Memorystore (redis)",
  lost: ["포트", "데이터"], appChange: true };

test("substitute 승인 행은 확인 항목 substitute:<자원 id> 가 되고 from·to·lost·appChange 를 그대로 싣는다", () => {
  const p = buildPlanDoc({ ...base, v2Approvals: [row] }, {});
  assert.deepEqual(p.acknowledgements?.find((a) => a.kind === "substitute"), {
    id: "substitute:shop-cache", kind: "substitute", ref: "shop-cache",
    text: "ElastiCache (redis) → Memorystore (redis) · 옮기지 못하는 것: 포트, 데이터 · 앱 코드 변경 필요",
    from: "ElastiCache (redis)", to: "Memorystore (redis)", lost: ["포트", "데이터"], appChange: true });
});

test("다른 종류 승인 행은 구조 칸 없이 예전 모양 (지문 그대로)", () => {
  const p = buildPlanDoc({ ...base, v2Approvals: [{ kind: "runtime_change", subject: "shop-api", from: "lambda", to: "k8s" }] }, {});
  assert.deepEqual(p.acknowledgements?.find((a) => a.id === "runtime_change:shop-api"),
    { id: "runtime_change:shop-api", kind: "runtime_change", text: "lambda → k8s", ref: "shop-api" });
});

test("substitutionsV2 가 없는 도착 Builder 는 0줄 (어느 출발이든)", () => {
  const spec = AppSpecV2.parse({ ...ONE, components: [...ONE.components,
    { id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 1024, tls: true, auth: true } }] });
  for (const source of ["aws", "gcp", "onprem"] as const)
    assert.deepEqual(targetBuilderFor("azure_mock").substitutionsV2?.(spec, source), [], source);
});
