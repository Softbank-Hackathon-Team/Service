// z75-64 DB 시험: 실제 LLM 지출 표 (llm_spend). 동시에 더해도 안 잃고, 회사 벽, 예산 0.01 주입으로 두 번째 호출 막힘
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let st: typeof import("../src/pg-llm-spend-store.js");
let agent: typeof import("@svc/agent");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  st = await import("../src/pg-llm-spend-store.js");
  agent = await import("@svc/agent");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-llm-spend'), ($2, 'test-llm-spend-other')", [T, OTHER]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("동시에 10번 더해도 합·호출 수가 맞다, 다른 회사·다른 회차는 0", { skip }, async () => {
  const s = st.pgLlmSpendStore();
  await Promise.all(Array.from({ length: 10 }, () => s.add(T, "r1", 0.012345)));
  assert.deepEqual(await s.get(T, "r1"), { usd: 0.12345, calls: 10 });
  assert.deepEqual(await s.get(OTHER, "r1"), { usd: 0, calls: 0 });
  assert.deepEqual(await s.get(T, "r2"), { usd: 0, calls: 0 });
  // 남의 회사 이름으로 넣을 수 없다 (RLS WITH CHECK)
  await assert.rejects(core.withTenant(OTHER, (tx) => tx.query("INSERT INTO llm_spend (tenant_id, round, usd) VALUES ($1, 'r9', 1)", [T])));
});

test("예산 0.01 주입: Postgres 지출 표로 두 번째 실제 호출은 안 부르고 LLM_BUDGET_EXCEEDED", { skip }, async () => {
  let calls = 0;
  const inner = { model: "claude-sonnet-5-5", async create() { calls++;
    return { content: [{ type: "text" as const, text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5000, output_tokens: 1000 } }; } };
  const llm = agent.budgetedLlm(inner, { store: st.pgLlmSpendStore(), tenantOf: () => T, budgetUsd: 0.01, round: "r-budget" });
  await llm.create({ system: "s", tools: [], messages: [{ role: "user", content: "1" }] });
  await assert.rejects(llm.create({ system: "s", tools: [], messages: [{ role: "user", content: "2" }] }), (e: { code?: string }) => e.code === "LLM_BUDGET_EXCEEDED");
  assert.equal(calls, 1);
  const row = await core.withTenant(T, async (tx) => (await tx.query("SELECT usd::float8 AS usd, calls FROM llm_spend WHERE round='r-budget'")).rows[0]);
  assert.deepEqual(row, { usd: 0.02, calls: 1 });
});

test("전체 합 (Z38 R8-48): 트리거가 회사 합을 쌓고, app_user 는 숫자 하나만 읽는다. 전체 상한 넘으면 다른 회사도 막힘", { skip }, async () => {
  const s = st.pgLlmSpendStore(); const round = `r-global-${randomUUID().slice(0, 8)}`;
  await s.add(T, round, 0.5); await s.add(OTHER, round, 0.25); await s.add(T, round, 0.25);
  assert.equal(await s.total!(round), 1);
  assert.equal(await s.total!("r-none"), 0);
  // 합 표는 app_user 가 직접 못 본다 (함수로만)
  await assert.rejects(core.withTenant(T, (tx) => tx.query("SELECT * FROM llm_spend_global")), /permission denied/);
  let calls = 0;
  const inner = { model: "claude-sonnet-5-5", async create() { calls++;
    return { content: [{ type: "text" as const, text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }; } };
  const llm = agent.budgetedLlm(inner, { store: s, tenantOf: () => OTHER, budgetUsd: 2, round, globalUsd: 1 });
  await assert.rejects(llm.create({ system: "s", tools: [], messages: [{ role: "user", content: "1" }] }),
    (e: { code?: string; scope?: string }) => e.code === "LLM_BUDGET_EXCEEDED" && e.scope === "global");
  assert.equal(calls, 0);
});
