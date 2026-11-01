// z75-64: 실제 LLM 지출 상한. 실제 API 대신 "토큰을 쓴 척" 하는 제공자로, 상한·누적·캐시 0원만 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { LLM_BUDGET_EXCEEDED, llmBudgetFromEnv, llmSpendView } from "@svc/contracts";
import {
  budgetedLlm, cachedLlm, memoryLlmSpendStore, memoryLlmCacheStore, responseUsd, LlmBudgetExceededError, llmErrorCode,
  withLlmCacheTally, llmCacheAuditDetail, type LlmProvider, type LlmResponse, type LlmSpendStore,
} from "../src/index.js";

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222";
const ROUND = "2026-11-07";
// 호출 한 번 = sonnet 입력 5000·출력 1000 토큰 = 5000×2/1e6 + 1000×10/1e6 = $0.02
function spendingLlm(model = "claude-sonnet-5-5"): LlmProvider & { calls: number } {
  const p = {
    model, calls: 0,
    async create(): Promise<LlmResponse> {
      p.calls++;
      return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5000, output_tokens: 1000 }, model };
    },
  };
  return p;
}
const req = (n = 0) => ({ system: "s", tools: [], messages: [{ role: "user" as const, content: `질문 ${n}` }] });

test("상한 안이면 부르고 쓴 달러를 더한다 (회사·회차별)", async () => {
  const inner = spendingLlm(); const store = memoryLlmSpendStore();
  const llm = budgetedLlm(inner, { store, tenantOf: () => T1, budgetUsd: 2, round: ROUND });
  await llm.create(req(1)); const r = await llm.create(req(2));
  assert.equal(r.usd, 0.02);
  assert.deepEqual(await store.get(T1, ROUND), { usd: 0.04, calls: 2 });
  assert.deepEqual(await store.get(T2, ROUND), { usd: 0, calls: 0 });
  assert.deepEqual(await store.get(T1, "2026-11-08"), { usd: 0, calls: 0 });
});

test("예산 0.01 주입: 첫 호출(0원 상태)은 가고, 넘은 뒤 새 호출은 실제 API 를 안 부르고 LLM_BUDGET_EXCEEDED", async () => {
  const inner = spendingLlm(); const store = memoryLlmSpendStore();
  const llm = budgetedLlm(inner, { store, tenantOf: () => T1, budgetUsd: 0.01, round: ROUND });
  await llm.create(req(1));
  const err = await llm.create(req(2)).then(() => null, (e) => e);
  assert.ok(err instanceof LlmBudgetExceededError);
  assert.equal(err.code, LLM_BUDGET_EXCEEDED);
  assert.equal(llmErrorCode(err), LLM_BUDGET_EXCEEDED);
  assert.equal(inner.calls, 1);
  assert.match(err.message, /\$0\.0200 \/ 상한 \$0\.01/);
  // 다른 회사는 따로
  const other = budgetedLlm(inner, { store, tenantOf: () => T2, budgetUsd: 0.01, round: ROUND });
  await other.create(req(3));
  assert.equal(inner.calls, 2);
});

test("예산 0 이면 실제 호출 전부 막힘", async () => {
  const inner = spendingLlm();
  const llm = budgetedLlm(inner, { store: memoryLlmSpendStore(), tenantOf: () => T1, budgetUsd: 0, round: ROUND });
  await assert.rejects(llm.create(req()), LlmBudgetExceededError);
  assert.equal(inner.calls, 0);
});

test("캐시에서 꺼낸 응답은 0원: 상한을 넘은 뒤에도 같은 요청은 캐시로 답한다", async () => {
  const inner = spendingLlm(); const spend = memoryLlmSpendStore();
  const llm = cachedLlm(budgetedLlm(inner, { store: spend, tenantOf: () => T1, budgetUsd: 0.01, round: ROUND }),
    { store: memoryLlmCacheStore(), tenantOf: () => T1 });
  const d1 = await withLlmCacheTally(async () => { await llm.create(req(1)); return llmCacheAuditDetail(); });
  assert.deepEqual(d1, { cache_hit: false, cache_hits: 0, cache_misses: 1, llm_usd: 0.02, llm_round_usd: 0.02, llm_budget_usd: 0.01, llm_round: ROUND });
  const d2 = await withLlmCacheTally(async () => { const r = await llm.create(req(1)); assert.equal(r.cacheHit, true); return llmCacheAuditDetail(); });
  assert.deepEqual(d2, { cache_hit: true, cache_hits: 1, cache_misses: 0 });
  assert.deepEqual(await spend.get(T1, ROUND), { usd: 0.02, calls: 1 });
  await assert.rejects(llm.create(req(2)), LlmBudgetExceededError);   // 새 요청은 막힘
  assert.equal(inner.calls, 1);
});

test("값 세기: 제공자가 준 usd(캐시 토큰 포함) 우선, 가격표에 없는 모델은 가장 비싼 값", () => {
  const base: LlmResponse = { content: [], stop_reason: "end_turn", usage: { input_tokens: 1_000_000, output_tokens: 0 } };
  assert.equal(responseUsd("claude-sonnet-5-5", { ...base, usd: 0.5 }), 0.5);
  assert.equal(responseUsd("claude-sonnet-5-5", base), 2);
  assert.equal(responseUsd("claude-unknown-9", base), 4);
});

test("회사를 모르거나 지출 표를 못 읽으면 부르지 않는다 (상한을 지킬 수 없으면 안 씀)", async () => {
  const inner = spendingLlm();
  await assert.rejects(budgetedLlm(inner, { store: memoryLlmSpendStore(), tenantOf: () => undefined, budgetUsd: 2, round: ROUND }).create(req()), LlmBudgetExceededError);
  const errs: string[] = [];
  const broken: LlmSpendStore = { async get() { throw new Error("db down"); }, async add() { throw new Error("db down"); } };
  await assert.rejects(budgetedLlm(inner, { store: broken, tenantOf: () => T1, budgetUsd: 2, round: ROUND, onError: (w) => errs.push(w) }).create(req()), LlmBudgetExceededError);
  assert.equal(inner.calls, 0); assert.deepEqual(errs, ["get"]);
});

test("설정: 기본 $2·오늘 날짜(UTC) 회차, 틀린 값은 오류, 화면 모양", () => {
  assert.deepEqual(llmBudgetFromEnv({}, new Date("2026-11-07T23:59:00Z")), { budgetUsd: 2, round: "2026-11-07", globalUsd: 10 });
  assert.deepEqual(llmBudgetFromEnv({ LLM_BUDGET_USD: "0.01", LLM_BUDGET_ROUND: "rehearsal-3" }), { budgetUsd: 0.01, round: "rehearsal-3", globalUsd: 10 });
  assert.equal(llmBudgetFromEnv({ LLM_BUDGET_GLOBAL_USD: "3" }).globalUsd, 3);
  assert.throws(() => llmBudgetFromEnv({ LLM_BUDGET_GLOBAL_USD: "-1" }), /LLM_BUDGET_GLOBAL_USD/);
  assert.throws(() => llmBudgetFromEnv({ LLM_BUDGET_USD: "-1" }), /0~1000/);
  assert.throws(() => llmBudgetFromEnv({ LLM_BUDGET_USD: "abc" }), /0~1000/);
  assert.throws(() => llmBudgetFromEnv({ LLM_BUDGET_ROUND: "a b" }), /LLM_BUDGET_ROUND/);
  assert.deepEqual(llmSpendView({ budgetUsd: 2, round: "r", globalUsd: 10 }, { usd: 1.23456789, calls: 3 }), { round: "r", usd: 1.234568, budgetUsd: 2, calls: 3, exceeded: false });
  assert.equal(llmSpendView({ budgetUsd: 2, round: "r", globalUsd: 10 }, { usd: 2, calls: 9 }).exceeded, true);
  assert.deepEqual(llmSpendView({ budgetUsd: 2, round: "r", globalUsd: 3 }, { usd: 1, calls: 1, totalUsd: 3 }),
    { round: "r", usd: 1, budgetUsd: 2, calls: 1, exceeded: true, totalUsd: 3, globalUsd: 3 });
});

test("전체 상한 (Z38 R8-48): 회사마다 상한 안이어도 모든 회사 합이 넘으면 새 호출 막힘", async () => {
  const inner = spendingLlm(); const store = memoryLlmSpendStore();
  let tenant = T1;
  const llm = budgetedLlm(inner, { store, tenantOf: () => tenant, budgetUsd: 2, round: ROUND, globalUsd: 0.03 });
  await llm.create(req(1));
  tenant = T2; await llm.create(req(2));
  const err = await llm.create(req(3)).then(() => null, (e) => e);
  assert.ok(err instanceof LlmBudgetExceededError);
  assert.equal(err.scope, "global"); assert.equal(err.code, LLM_BUDGET_EXCEEDED);
  assert.match(err.message, /전체 합/);
  assert.equal(inner.calls, 2);
  assert.equal(await store.total(ROUND), 0.04);
  // 합을 못 읽으면 안 부른다, total 이 없는 저장소는 전체 상한을 안 본다
  const broken: LlmSpendStore = { get: store.get, add: store.add, async total() { throw new Error("db down"); } };
  await assert.rejects(budgetedLlm(inner, { store: broken, tenantOf: () => T1, budgetUsd: 2, round: "x", globalUsd: 1 }).create(req()), LlmBudgetExceededError);
  const noTotal: LlmSpendStore = { get: store.get, add: store.add };
  await budgetedLlm(inner, { store: noTotal, tenantOf: () => T1, budgetUsd: 2, round: "y", globalUsd: 0 }).create(req());
  assert.equal(inner.calls, 3);
});
