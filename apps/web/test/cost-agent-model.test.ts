import { test } from "node:test";
import assert from "node:assert/strict";
import { agentBlock, agentStepEntry, analysisCaption, failureAnalysisOf, spendRows, spendText } from "../src/features/agent/model";
import { costCaveats, costNote, costSummary, envCaption, planCostCaveats, planCostSummary } from "../src/features/cost/model";

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

test("계획서 비용: 차이를 머리줄에, 계산 못 한 칸과 고정값은 단서로, 기준일은 안내 줄에", () => {
  const base = { deltaMonthly: -50.4, unknownFields: [] as string[], stub: false };
  assert.equal(planCostSummary(base), "월 -$50");
  assert.equal(planCostSummary({ ...base, deltaMonthly: 12 }), "월 +$12");
  assert.equal(planCostSummary({ ...base, deltaMonthly: 0.2 }), "월 차이 없음");
  assert.equal(planCostSummary({ ...base, deltaMonthly: null, unknownFields: ["monthlySource"] }), "차이 계산 불가");
  assert.equal(planCostSummary({ ...base, unknownFields: ["*"] }), "계산하지 못함");
  assert.equal(planCostSummary({ ...base, stub: true }), "고정 예시값");
  assert.deepEqual(planCostCaveats({ unknownFields: [], stub: false }), []);
  assert.deepEqual(planCostCaveats({ unknownFields: ["monthlySource"], stub: false }), ["출발 비용을 계산하지 못했습니다."]);
  assert.equal(planCostCaveats({ unknownFields: ["*"], stub: true }).length, 2);
  assert.match(costNote("2026-11-01T00:00:00Z"), /가격 기준일 2026-11-01\./);
  assert.doesNotMatch(costNote(undefined), /기준일/);
});

test("실패 원인 분석: 끝난 분석만 쓰고, 없거나 진행 중이면 아무것도 그리지 않는다", () => {
  const run = { source: "db" as const, runId: "r", status: "finished" as const, model: null, createdAt: null, finishedAt: null, reason: null, usage: { input: 0, output: 0 }, steps: [] };
  const analysis = { cause: "원인", evidence: ["근거"], fix: ["고칠 것"], retryable: true, confidence: 0.72 };
  const review = { migrationId: "m", remediate: null, specDraft: null };
  assert.equal(failureAnalysisOf({ ...review }), null);
  assert.equal(failureAnalysisOf({ ...review, failureAnalysis: { ...run, status: "running", analysis: null } }), null);
  assert.deepEqual(failureAnalysisOf({ ...review, failureAnalysis: { ...run, analysis } }), analysis);
  assert.equal(failureAnalysisOf(null), null);
  assert.equal(analysisCaption(analysis), "AI 추정 · 확신 72% · 고치지 않고 다시 해도 될 것으로 봄");
  assert.equal(analysisCaption({ confidence: 0.5, retryable: false }), "AI 추정 · 확신 50%");
});

test("에이전트 단계: 안정성 확인은 통과·실패가 다르게 보이고, 거부된 호출은 그대로 거부로 보인다 (#179)", () => {
  const bad = agentStepEntry({ seq: 3, tool: "run_check", ok: true, note: "check_bad" });
  const good = agentStepEntry({ seq: 7, tool: "run_check", ok: true, note: "check_ok" });
  assert.deepEqual([bad.kind, bad.detail], ["fail", "점검 실패"]);
  assert.deepEqual([good.kind, good.detail], ["pass", "점검 통과"]);
  assert.equal(bad.title, good.title);
  assert.equal(agentStepEntry({ seq: 1, tool: "repo_edit", ok: false, note: "TOOL-05" }).kind, "denied");
  assert.deepEqual(agentStepEntry({ seq: 2, tool: "repo_read", ok: true, note: "deploy/app.yaml" }), { kind: "tool", title: "배포 파일 읽기", detail: "deploy/app.yaml", time: "2" });
});
