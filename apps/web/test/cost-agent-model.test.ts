import { test } from "node:test";
import assert from "node:assert/strict";
import { agentBlock, spendRows, spendText } from "../src/features/agent/model";
import { costCaveats, costSummary, envCaption } from "../src/features/cost/model";

const estimate = (priceStale: boolean) => ({
  priceAsOf: "2026-11-01T00:00:00Z", priceStale, peakRps: 10, requiredVcpu: 1, profile: "startup" as const,
  envs: [], cheapest: null, savings: null,
});

test("비용 근거: 예시 앱으로 계산했거나 가격이 오래됐으면 숫자 옆에 그 이유를 둔다", () => {
  assert.equal(costSummary({ origin: "preview", specFrom: "demo", estimate: estimate(true) }), "예시 앱 기준");
  assert.equal(costSummary({ origin: "stored", specFrom: "stored", estimate: estimate(true) }), "오래된 가격");
  assert.equal(costSummary({ origin: "stored", specFrom: "stored", estimate: estimate(false) }), "승인 때 추정");
  assert.equal(costSummary({ origin: "preview", specFrom: "spec_versions", estimate: estimate(false) }), "미리보기");
  assert.equal(costCaveats({ specFrom: "demo", estimate: estimate(true) }).length, 2);
  assert.match(costCaveats({ specFrom: "spec_versions", estimate: estimate(true) })[0]!, /2026-11-01/);
  assert.deepEqual(costCaveats({ specFrom: "stored", estimate: estimate(false) }), []);
});

test("환경 줄 단서: 계산할 수 없는 이유와 합계에서 뺀 항목", () => {
  assert.equal(envCaption({ feasible: false, reason: "ONPREM_CAPACITY_EXCEEDED", unknown: [] }), "온프레 용량을 넘습니다");
  assert.equal(envCaption({ feasible: false, reason: "NEW_REASON", unknown: [] }), "계산할 수 없습니다");
  assert.equal(envCaption({ feasible: true, unknown: ["db", "storage"] }), "DB·스토리지 가격이 없어 합계에서 뺐습니다");
  assert.equal(envCaption({ feasible: true, unknown: [] }), null);
});

test("AI 점검 막힘: 키가 없거나 지출 상한에 닿으면 버튼이 그 이유를 말한다", () => {
  const spend = { round: "r1", usd: 0.42, budgetUsd: 5, calls: 12, exceeded: false };
  assert.equal(agentBlock(undefined), null);
  assert.equal(agentBlock({ state: "ready", model: "m", why: "", spend }), null);
  assert.equal(agentBlock({ state: "key_missing", model: "m", why: "" })?.button, "AI 키가 없습니다");
  assert.equal(agentBlock({ state: "ready", model: "m", why: "", spend: { ...spend, exceeded: true } })?.button, "AI 지출 상한에 닿았습니다");
  assert.equal(agentBlock({ state: "fake", model: "m", why: "" }), null);
});

test("AI 지출 표시: 이 회사 지출과 상한, 모든 회사 합은 서버가 줄 때만", () => {
  const spend = { round: "r1", usd: 0.4199, budgetUsd: 5, calls: 1200, exceeded: false };
  assert.equal(spendText(spend), "$0.42 / $5");
  assert.equal(spendRows(spend).length, 3);
  assert.equal(spendRows(spend)[1]!.value, "1,200번");
  assert.equal(spendRows({ ...spend, totalUsd: 12.5, globalUsd: 50 })[3]!.value, "$12.5 / $50");
});
