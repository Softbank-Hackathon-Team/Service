// 검증 PA4: 확인 항목·비용 요약의 경계 (순수)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE } from "./demo-one.js";
import { PlanDoc, type PlanCostSummary, type PrecheckItem } from "@svc/contracts";
import { adapterFor } from "@svc/adapters";
import { buildAcknowledgements, buildPlanDoc, estimatePlanCost } from "../src/jobs/plan.js";

const spec = ONE;
const base = {
  planId: "7f000000-0000-4000-8000-0000000000b4", migrationId: "4a8c0000-0000-4000-8000-0000000000b4",
  spec, target: { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp" as const, region: "default" },
  precheck: [] as PrecheckItem[], now: new Date("2026-11-07T00:00:00Z"), source: { provider: "aws" as const }, specVersion: 3,
};
const cost = (t: number | null, s: number | null = 100): PlanCostSummary =>
  ({ currency: "USD", monthlyTarget: t, monthlySource: s, deltaMonthly: t !== null && s !== null ? t - s : null, unknownFields: [] });
const warn = (id: string, extra: Partial<PrecheckItem> = {}): PrecheckItem => ({ id, level: "warn", message: `경고 ${id}`, ...extra } as PrecheckItem);

test("비용 0달러는 '계산 못 함'이 아니라 $0, null 은 계산 못 함", () => {
  const a = buildAcknowledgements({ cost: cost(0, 0), from: "aws", to: "gcp", precheck: [] });
  assert.match(a[0]!.text, /도착 gcp \$0 \/ 출발 aws \$0 \/ 차이 \$0/);
  const b = buildAcknowledgements({ cost: cost(null, null), from: "aws", to: "gcp", precheck: [] });
  assert.match(b[0]!.text, /계산 못 함/);
});

test("항목 순서·개수: cost, failure_cost_policy, precheck warn(입력 순서), v2 승인 행 순서로 고정, block·info 는 제외, 같은 id 3번은 글을 합침", () => {
  const pre = [warn("a"), { id: "b", level: "block", message: "막힘" } as PrecheckItem, { id: "c", level: "info", message: "정보" } as PrecheckItem, warn("a"), warn("d", { fix: "고치기" })];
  const out = buildAcknowledgements({ cost: cost(80), from: "aws", to: "gcp", precheck: pre });
  assert.deepEqual(out.map((x) => x.id), ["cost", "failure_cost_policy", "precheck_warn:a", "precheck_warn:d"]);
  assert.match(out[2]!.text, /경고 a \/ 경고 a/);
  assert.match(out[3]!.text, /\(조치: 고치기\)/);
  assert.equal(new Set(out.map((x) => x.id)).size, out.length, "id 중복 없음 — acks 는 id 로만 덮는다");
});

test("고지 문구의 재시도 횟수 = 실제 한도(RETRY_BUDGET) — PA4fix", () => {
  const t = (env: NodeJS.ProcessEnv) => buildAcknowledgements({ cost: cost(80), from: "aws", to: "gcp", precheck: [], env })[1]!.text;
  assert.match(t({}), /재시도 3번/, "기본");
  assert.match(t({ RETRY_BUDGET: "5" }), /재시도 5번/);
  assert.match(t({ RETRY_BUDGET: "abc" }), /재시도 3번/, "글자는 기본 3 (retryBudget 과 같은 규칙)");
  assert.match(t({ RETRY_BUDGET: "0" }), /횟수 제한 없이/, "0 = 한도 꺼짐");
  assert.doesNotMatch(t({ RETRY_BUDGET: "0" }), /재시도 0번/);
});

test("PA4fix 지문: 같은 RETRY_BUDGET 이면 같은 지문, 값이 다르면 지문이 다르다 (본 문구 = 승인 지문)", () => {
  const mk = (env: NodeJS.ProcessEnv) => buildPlanDoc({ ...base, costSummary: cost(80) }, env).planHash;
  assert.equal(mk({}), mk({ RETRY_BUDGET: "3" }));
  assert.notEqual(mk({}), mk({ RETRY_BUDGET: "5" }));
});

test("지문: 확인 항목 글 하나(사전 점검 warn 추가)만 달라도 planHash 가 다르다, 같은 입력은 같은 지문", () => {
  const c = cost(80);
  const p1 = buildPlanDoc({ ...base, costSummary: c, precheck: [] });
  const p2 = buildPlanDoc({ ...base, costSummary: c, precheck: [warn("x")] });
  const p3 = buildPlanDoc({ ...base, costSummary: c, precheck: [] });
  assert.notEqual(p1.planHash, p2.planHash);
  assert.equal(p1.planHash, p3.planHash);
  assert.ok(PlanDoc.safeParse(p1).success);
  assert.ok(p2.acknowledgements!.some((x) => x.id === "precheck_warn:x"));
});

test("비용 계산: deltaMonthly = 도착 - 출발(소수 첫째 자리), 같은 입력 3번 같은 값, 출발=도착이면 차이 0", () => {
  const r = [0, 1, 2].map(() => JSON.stringify(estimatePlanCost(spec, "aws", "gcp")));
  assert.equal(new Set(r).size, 1);
  const c = JSON.parse(r[0]!) as PlanCostSummary;
  if (c.monthlyTarget !== null && c.monthlySource !== null) {
    assert.equal(c.deltaMonthly, Math.round((c.monthlyTarget - c.monthlySource) * 10) / 10);
    assert.ok(Number.isInteger(c.deltaMonthly! * 10), "소수 첫째 자리까지");
  }
  const same = estimatePlanCost(spec, "aws", "aws");
  if (same.deltaMonthly !== null) assert.equal(same.deltaMonthly, 0);
});
