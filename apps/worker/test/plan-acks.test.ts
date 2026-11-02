// PA4 (계획 26 · A4): 계획서 비용 요약 + 확인 항목
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, PlanDoc, type PlanCostSummary } from "@svc/contracts";
import { adapterFor } from "@svc/adapters";
import { buildAcknowledgements, buildPlanDoc, estimatePlanCost } from "../src/jobs/plan.js";

const spec = AppSpec.parse(adapterFor("aws").normalize({ provider: "aws", items: [], coverage: {} }).spec);
const now = new Date("2026-11-07T00:00:00Z");
const base = {
  planId: "7f000000-0000-4000-8000-0000000000a4",
  migrationId: "4a8c0000-0000-4000-8000-0000000000a4",
  spec, target: { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp" as const, region: "default" },
  precheck: [], now, source: { provider: "aws" as const }, specVersion: 3,
};
const cost = (target: number): PlanCostSummary =>
  ({ currency: "USD", monthlyTarget: target, monthlySource: 100, deltaMonthly: target - 100, unknownFields: [] });

test("정상: 비용 요약이 있으면 계획서에 costSummary·확인 항목 2개(cost·failure_cost_policy)가 실린다", () => {
  const p = buildPlanDoc({ ...base, costSummary: cost(80) }, {});
  assert.equal(PlanDoc.safeParse(p).success, true);
  assert.equal(p.specVersion, 3);
  assert.equal(p.costSummary?.monthlyTarget, 80);
  assert.deepEqual(p.acknowledgements?.map((a) => a.id), ["cost", "failure_cost_policy"]);
  assert.match(p.acknowledgements![0]!.text, /\$80/);
});

test("비용이 1달러만 달라도 지문이 다르다 (본 비용 = 승인한 비용)", () => {
  const a = buildPlanDoc({ ...base, costSummary: cost(80) }, {});
  const b = buildPlanDoc({ ...base, costSummary: cost(81) }, {});
  assert.notEqual(a.planHash, b.planHash);
  assert.equal(a.tfPlanHash, b.tfPlanHash);
  assert.equal(buildPlanDoc({ ...base, costSummary: cost(80), now: new Date() }, {}).planHash, a.planHash);
});

test("비용 요약이 없으면 예전 계획서 모양·지문 그대로 (옛 호출부·옛 계획서)", () => {
  const { source: _s, specVersion: _v, ...old } = base;
  const a = buildPlanDoc(old, {});
  const b = buildPlanDoc({ ...old, source: { provider: "aws" } }, {});
  assert.equal(a.costSummary, undefined);
  assert.equal(a.acknowledgements, undefined);
  assert.equal(a.planHash, b.planHash);
  // 옛 계획서(새 칸 없음)도 계약을 통과
  assert.equal(PlanDoc.safeParse(a).success, true);
});

test("사전 점검 warn·IR v2 승인 행은 항목 하나씩, 같은 id 는 합친다 (block·info 는 항목 아님)", () => {
  const acks = buildAcknowledgements({ cost: cost(80), from: "aws", to: "gcp",
    precheck: [{ id: "PC-01", level: "warn", message: "쿼터 낮음", fix: "증설" },
               { id: "PC-02", level: "info", message: "참고" }, { id: "PC-03", level: "block", message: "막힘" }],
    v2Approvals: [{ kind: "runtime_change", subject: "api", from: "lambda", to: "k8s" },
                  { kind: "build", subject: "web", detail: "이미지 빌드 필요" },
                  { kind: "build", subject: "web", detail: "두 번째" }] });
  assert.deepEqual(acks.map((a) => a.id),
    ["cost", "failure_cost_policy", "precheck_warn:PC-01", "runtime_change:api", "build:web"]);
  assert.equal(acks.find((a) => a.id === "runtime_change:api")?.ref, "api");
  assert.match(acks.find((a) => a.id === "build:web")!.text, /이미지 빌드 필요 \/ 두 번째/);
});

test("진짜 가격표로 출발·도착 월 비용을 계산하고, 같은 입력이면 같은 값", () => {
  const a = estimatePlanCost(spec, "aws", "gcp");
  assert.equal(a.currency, "USD");
  assert.equal(typeof a.monthlySource, "number");
  assert.equal(typeof a.monthlyTarget, "number");
  assert.deepEqual(a.unknownFields, []);
  assert.deepEqual(estimatePlanCost(spec, "aws", "gcp"), a);
});

test("거부: 비용 계산이 실패해도 던지지 않고 unknownFields=['*'] 로 남긴다 (계획을 막지 않음)", () => {
  const broken = { ...spec, service: { ...spec.service, cpu: "not-a-cpu" } } as unknown as AppSpec;
  const c = estimatePlanCost(broken, "aws", "gcp");
  assert.deepEqual(c.unknownFields, ["*"]);
  assert.equal(c.monthlyTarget, null);
  const p = buildPlanDoc({ ...base, costSummary: c }, {});
  assert.match(p.acknowledgements![0]!.text, /계산 못 함/);
});
