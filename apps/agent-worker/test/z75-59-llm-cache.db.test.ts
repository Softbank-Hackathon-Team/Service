// z75-59 DB 시험: 실제 LLM 응답 캐시 저장소 (표 agent_llm_cache, 회사 벽). DATABASE_URL·OWNER_DATABASE_URL 이 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let st: typeof import("../src/pg-llm-cache-store.js");
let agent: typeof import("@svc/agent");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID();
const KEY = "a".repeat(64);
const RESP = { content: [{ type: "text" as const, text: "안녕" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 }, model: "claude-sonnet-5-5" };

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  st = await import("../src/pg-llm-cache-store.js");
  agent = await import("@svc/agent");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-llm-cache'), ($2, 'test-llm-cache-other')", [T, OTHER]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("넣고 꺼내기: 꺼낼 때마다 hits 가 오른다, 다른 회사는 못 본다", { skip }, async () => {
  const s = st.pgLlmCacheStore();
  await s.put(T, KEY, { model: "claude-sonnet-5-5", response: RESP, ttlSec: 3600 });
  assert.deepEqual((await s.get(T, KEY))?.response, RESP);
  assert.deepEqual((await s.get(T, KEY))?.response, RESP);
  assert.equal(await s.get(OTHER, KEY), null);
  const row = await core.withTenant(T, async (tx) => (await tx.query("SELECT hits, model FROM agent_llm_cache WHERE key=$1", [KEY])).rows[0]);
  assert.deepEqual(row, { hits: 2, model: "claude-sonnet-5-5" });
  // 다른 회사 이름으로 남의 회사 줄을 넣을 수 없다 (RLS WITH CHECK)
  await assert.rejects(core.withTenant(OTHER, (tx) => tx.query(
    "INSERT INTO agent_llm_cache (tenant_id, key, model, response, expires_at) VALUES ($1,$2,'m','{}',now() + interval '1 hour')", [T, "b".repeat(64)])));
});

test("기한이 지난 줄은 안 꺼내고, 다음 넣기 때 지운다. 같은 열쇠는 덮어쓴다", { skip }, async () => {
  const s = st.pgLlmCacheStore();
  const k2 = "c".repeat(64);
  await s.put(T, k2, { model: "m", response: RESP, ttlSec: 3600 });
  await core.withTenant(T, (tx) => tx.query("UPDATE agent_llm_cache SET expires_at = now() - interval '1 second' WHERE key=$1", [k2]));
  assert.equal(await s.get(T, k2), null);
  await s.put(T, KEY, { model: "claude-opus-5-5", response: { ...RESP, model: "claude-opus-5-5" }, ttlSec: 3600 });
  const rows = await core.withTenant(T, async (tx) => (await tx.query("SELECT key, model FROM agent_llm_cache ORDER BY key")).rows);
  assert.deepEqual(rows, [{ key: KEY, model: "claude-opus-5-5" }]);
});

test("cachedLlm + Postgres 저장소: 두 번째 실행은 실제 호출 0, 감사 칸 cache_hit", { skip }, async () => {
  let calls = 0;
  const inner = { model: "claude-sonnet-5-5", async create() { calls++; return RESP; } };
  const llm = agent.cachedLlm(inner, { store: st.pgLlmCacheStore(), tenantOf: () => T, salt: "spec_draft:effort=medium" });
  const req = { system: "s", tools: [], messages: [{ role: "user" as const, content: `이전 ${randomUUID()}` }] };
  const d1 = await agent.withLlmCacheTally(async () => { await llm.create(req); return agent.llmCacheAuditDetail(); });
  const d2 = await agent.withLlmCacheTally(async () => { await llm.create({ ...req, messages: [{ role: "user", content: `이전 ${randomUUID()}` }] }); return agent.llmCacheAuditDetail(); });
  assert.equal(calls, 1);
  assert.deepEqual(d1, { cache_hit: false, cache_hits: 0, cache_misses: 1 });
  assert.deepEqual(d2, { cache_hit: true, cache_hits: 1, cache_misses: 0 });
});
