// z75-59: 실제 LLM 응답 캐시. 실제 API 대신 "부른 횟수를 세는" 제공자를 넣어, 캐시가 언제 부르고 언제 안 부르는지만 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cachedLlm, memoryLlmCacheStore, llmCacheKey, withLlmCacheTally, currentLlmCacheTally, llmCacheAuditDetail, llmCacheConfigFromEnv,
  LLM_CACHE_TTL_SEC, type LlmProvider, type LlmResponse, type LlmMessage, type LlmCacheStore,
} from "../src/index.js";

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222";
const MIG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", MIG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// 진짜 API 자리: 부를 때마다 센다. 응답에 요청 마지막 글의 이전 번호를 그대로 넣는다 (자리표 되돌리기 확인용)
function countingLlm(o: { stop?: LlmResponse["stop_reason"]; fail?: boolean } = {}): LlmProvider & { calls: number } {
  const p = {
    model: "claude-sonnet-5-5", calls: 0,
    async create(req: { system: string; tools: unknown[]; messages: LlmMessage[] }): Promise<LlmResponse> {
      p.calls++;
      if (o.fail) throw new Error("HTTP 529");
      const last = JSON.stringify(req.messages.at(-1)?.content ?? "");
      const mig = last.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}/)?.[0] ?? "none";
      const turn = req.messages.filter((m) => m.role === "assistant").length;
      return {
        content: [{ type: "tool_use", id: `toolu_${turn}`, name: "propose_spec", input: { migrationId: mig, at: "2026-11-07T01:00:00.000Z" } }],
        raw: [{ type: "thinking", thinking: `이전 ${mig} 를 본다`, signature: "sig-abc" },
              { type: "tool_use", id: `toolu_${turn}`, name: "propose_spec", input: { migrationId: mig, at: "2026-11-07T01:00:00.000Z" } }],
        stop_reason: o.stop ?? "tool_use", usage: { input_tokens: 1000, output_tokens: 50 }, model: "claude-sonnet-5-5",
      };
    },
  };
  return p;
}
const req = (mig: string, at = "2026-11-07T00:00:00Z") => ({
  system: "명세 초안", tools: [{ name: "propose_spec" }],
  messages: [{ role: "user" as const, content: [{ type: "text", text: `migrationId=${mig} requestedAt=${at}` }] }],
});

test("첫 호출은 실제, 같은 회사·같은 요청 두 번째는 캐시 (실제 1번)", async () => {
  const inner = countingLlm(); const store = memoryLlmCacheStore();
  const llm = cachedLlm(inner, { store, tenantOf: () => T1 });
  const a = await llm.create(req(MIG_A));
  const b = await llm.create(req(MIG_A));
  assert.equal(inner.calls, 1);
  assert.equal(a.cacheHit, false); assert.equal(b.cacheHit, true);
  assert.deepEqual(b.content, a.content);
  assert.equal(store.size(), 1);
});

test("다른 회사는 같은 요청이어도 안 맞는다 (회사 범위). 회사를 모르면 캐시를 안 쓴다", async () => {
  const inner = countingLlm(); const store = memoryLlmCacheStore();
  let tenant: string | undefined = T1;
  const llm = cachedLlm(inner, { store, tenantOf: () => tenant });
  await llm.create(req(MIG_A));
  tenant = T2; await llm.create(req(MIG_A));
  assert.equal(inner.calls, 2);
  tenant = undefined; const r = await llm.create(req(MIG_A));
  assert.equal(inner.calls, 3); assert.equal(r.cacheHit, undefined);
  assert.equal(store.size(), 2);
});

test("기한(기본 24시간)이 지나면 다시 실제 호출", async () => {
  let now = 0; const inner = countingLlm(); const store = memoryLlmCacheStore(() => now);
  const llm = cachedLlm(inner, { store, tenantOf: () => T1 });
  await llm.create(req(MIG_A));
  now = (LLM_CACHE_TTL_SEC - 1) * 1000; await llm.create(req(MIG_A));
  assert.equal(inner.calls, 1);
  now = LLM_CACHE_TTL_SEC * 1000; await llm.create(req(MIG_A));
  assert.equal(inner.calls, 2);
});

test("끝까지 안 간 응답(max_tokens·refusal)과 오류는 저장 안 함", async () => {
  for (const stop of ["max_tokens", "refusal"] as const) {
    const inner = countingLlm({ stop }); const store = memoryLlmCacheStore();
    const llm = cachedLlm(inner, { store, tenantOf: () => T1 });
    await llm.create(req(MIG_A)); await llm.create(req(MIG_A));
    assert.equal(inner.calls, 2, stop); assert.equal(store.size(), 0);
  }
  const bad = countingLlm({ fail: true }); const store = memoryLlmCacheStore();
  const llm = cachedLlm(bad, { store, tenantOf: () => T1 });
  await assert.rejects(llm.create(req(MIG_A)), /529/);
  assert.equal(store.size(), 0);
});

test("데모 초기화 뒤(다른 이전 번호·시각)도 맞고, 응답에는 지금 이전 번호가 들어간다 (옛 번호 안 섞임)", async () => {
  const inner = countingLlm(); const store = memoryLlmCacheStore();
  const llm = cachedLlm(inner, { store, tenantOf: () => T1 });
  const a = await llm.create(req(MIG_A, "2026-11-07T00:00:00Z"));
  const b = await llm.create(req(MIG_B, "2026-11-07T00:09:00Z"));
  assert.equal(inner.calls, 1);
  assert.equal(b.cacheHit, true);
  assert.deepEqual((a.content[0] as { input: unknown }).input, { migrationId: MIG_A, at: "2026-11-07T01:00:00.000Z" });
  assert.deepEqual((b.content[0] as { input: unknown }).input, { migrationId: MIG_B, at: "2026-11-07T01:00:00.000Z" });
  assert.ok(!JSON.stringify(b.content).includes(MIG_A));
  // 생각 블록은 서명이 내용에 묶여 있어 그대로 (옛 번호가 남아도 실행 결과에는 안 쓰인다)
  assert.deepEqual(b.raw?.[0], { type: "thinking", thinking: `이전 ${MIG_A} 를 본다`, signature: "sig-abc" });
  assert.deepEqual((b.raw?.[1] as { input: unknown }).input, { migrationId: MIG_B, at: "2026-11-07T01:00:00.000Z" });
});

test("여러 턴 대화도 두 번째 실행은 전부 캐시 (생각 블록은 열쇠에서 빠진다)", async () => {
  const inner = countingLlm(); const store = memoryLlmCacheStore();
  const llm = cachedLlm(inner, { store, tenantOf: () => T1 });
  async function run(mig: string) {
    const messages: LlmMessage[] = [...req(mig).messages];
    for (let i = 0; i < 3; i++) {
      const r = await llm.create({ ...req(mig), messages });
      messages.push({ role: "assistant", content: r.raw ?? r.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: `ok ${mig}` }] });
    }
  }
  await withLlmCacheTally(async () => { await run(MIG_A); assert.deepEqual(currentLlmCacheTally(), { hits: 0, misses: 3 }); });
  await withLlmCacheTally(async () => {
    await run(MIG_B);
    assert.deepEqual(currentLlmCacheTally(), { hits: 3, misses: 0 });
    assert.deepEqual(llmCacheAuditDetail(), { cache_hit: true, cache_hits: 3, cache_misses: 0 });
  });
  assert.equal(inner.calls, 3);
});

test("모델·호출 설정(salt)이 다르면 다른 열쇠, 키 순서는 상관없음", () => {
  const r = req(MIG_A);
  const k = (o: { model: string; salt?: string }, x = r) => llmCacheKey(x, o).key;
  assert.notEqual(k({ model: "claude-sonnet-5-5" }), k({ model: "claude-opus-5-5" }));
  assert.notEqual(k({ model: "m", salt: "spec_draft:effort=medium" }), k({ model: "m", salt: "spec_draft:effort=high" }));
  const swapped = { tools: r.tools, messages: r.messages, system: r.system };
  assert.equal(k({ model: "m" }), k({ model: "m" }, swapped));
  assert.match(k({ model: "m" }), /^[0-9a-f]{64}$/);
});

test("저장소 오류는 '없음'으로 보고 실제 호출 (실행이 안 깨진다)", async () => {
  const inner = countingLlm(); const errs: string[] = [];
  const broken: LlmCacheStore = { async get() { throw new Error("db down"); }, async put() { throw new Error("db down"); } };
  const llm = cachedLlm(inner, { store: broken, tenantOf: () => T1, onError: (w) => errs.push(w) });
  const r = await llm.create(req(MIG_A));
  assert.equal(r.cacheHit, false); assert.equal(inner.calls, 1); assert.deepEqual(errs, ["get", "put"]);
});

test("감사 칸: 캐시를 안 거쳤으면 빈 객체 (가짜·키 없음이면 예전 detail 그대로), 설정 읽기", () => {
  assert.deepEqual(llmCacheAuditDetail(undefined), {});
  assert.deepEqual(llmCacheAuditDetail({ hits: 0, misses: 0 }), {});
  assert.deepEqual(llmCacheAuditDetail({ hits: 2, misses: 1 }), { cache_hit: false, cache_hits: 2, cache_misses: 1 });
  assert.deepEqual(llmCacheConfigFromEnv({}), { enabled: true, ttlSec: 86400 });
  assert.deepEqual(llmCacheConfigFromEnv({ AGENT_LLM_CACHE: "0", AGENT_LLM_CACHE_TTL_SEC: "600" }), { enabled: false, ttlSec: 600 });
  assert.throws(() => llmCacheConfigFromEnv({ AGENT_LLM_CACHE_TTL_SEC: "5" }), /60~604800/);
});
