// 작업 Z65 DB 시험: 장애 점검(remediate) 저장소(Postgres). DATABASE_URL·OWNER_DATABASE_URL이 없으면 건너뛴다.
// 필요한 표: db/migrations/0006_agent_runs.sql. API 읽기 경로(agent-review)가 source:"db" 로 읽는지까지 본다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let h: typeof import("../src/handle-agent-run.js");
let st: typeof import("../src/pg-agent-run-store.js");
let rv: typeof import("../../api/src/routes/agent-review.js");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID(), S = randomUUID(), G = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  h = await import("../src/handle-agent-run.js");
  st = await import("../src/pg-agent-run-store.js");
  rv = await import("../../api/src/routes/agent-review.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-remediate'), ($2, 'test-other2')", [T, OTHER]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

async function setup() {
  const m = randomUUID(), run = randomUUID();
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`, [m, T, S, G]);
  await owner.query(`INSERT INTO agent_runs (id, tenant_id, migration_id, kind, task) VALUES ($1,$2,$3,'remediate','web 재시작 원인')`, [run, T, m]);
  return { m, run };
}

test("Postgres: remediate 결과가 agent_runs·agent_steps·감사에 남고, API 가 source:db 로 읽는다", { skip }, async () => {
  const { m, run } = await setup();
  const store = st.pgAgentRunStore();
  assert.equal(await store.load(OTHER, run), null);                       // 회사 벽: 남의 실행은 안 보인다
  const job = { tenantId: T, requestId: "req-z65", agentRunId: run };
  const r = await h.handleAgentRun(job, h.stubDeps(store));
  assert.deepEqual(r, { skipped: false, state: "finished", outcome: "proposed", gateOk: true });

  const ar = (await owner.query(
    `SELECT status, model, reason, usage, result->'finish'->>'outcome' AS outcome, (result->'gate'->>'ok')::bool AS gate_ok,
            finished_at IS NOT NULL AS done FROM agent_runs WHERE id=$1`, [run])).rows[0];
  assert.deepEqual(ar, { status: "finished", model: "stub-scripted", reason: "finish 호출",
    usage: { input: 9600, output: 640 }, outcome: "proposed", gate_ok: true, done: true });
  const steps = (await owner.query(`SELECT seq, tool FROM agent_steps WHERE run_id=$1 ORDER BY seq`, [run])).rows;
  assert.deepEqual(steps.map((s) => s.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  const au = (await owner.query(
    `SELECT actor, result, detail->>'outcome' AS outcome FROM audit_events WHERE tenant_id=$1 AND action='agent.remediate' AND target=$2`, [T, m])).rows;
  assert.deepEqual(au, [{ actor: "ai_agent", result: "ok", outcome: "proposed" }]);

  // API 읽기 경로: 같은 회사 벽 안에서 읽으면 STUB 이 아니라 DB 기록. 본문은 STUB 대본과 같아야 한다 (같은 대본이므로)
  const input = await core.withTenant(T, (tx) => rv.loadAgentReviewDb(tx, m));
  const view = rv.AgentReview.parse(rv.buildAgentReview(m, input.runs));
  assert.equal(view.remediate?.source, "db");
  assert.equal(view.remediate?.runId, run);
  const { source: _a, runId: _b, createdAt: _c, finishedAt: _d, ...dbBody } = view.remediate!;
  const { source: _e, runId: _f, createdAt: _g, finishedAt: _h, ...stubBody } = rv.STUB_REMEDIATE;
  assert.deepEqual(dbBody, stubBody);
  // 남의 회사 벽 안에서는 이 이전 자체가 안 보인다
  const other = await core.withTenant(OTHER, (tx) => rv.loadAgentReviewDb(tx, m));
  assert.equal(other.migrationExists, false);

  // 두 번 온 작업은 아무것도 안 한다 (단계·감사가 늘지 않음)
  assert.deepEqual(await h.handleAgentRun(job, h.stubDeps(store)), { skipped: true });
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM agent_steps WHERE run_id=$1`, [run])).rows[0].n, 8);
});

test("Postgres: 동시에 두 번 와도 claim 은 하나만, LLM 오류는 failed + 감사 error, 닫힌 실행은 덮어쓰지 않음", { skip }, async () => {
  const { m, run } = await setup();
  const store = st.pgAgentRunStore();
  const job = { tenantId: T, requestId: "dup", agentRunId: run };
  const [a, b] = await Promise.all([h.handleAgentRun(job, h.stubDeps(store)), h.handleAgentRun(job, h.stubDeps(store))]);
  assert.equal([a, b].filter((x) => x.skipped).length, 1);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM agent_steps WHERE run_id=$1`, [run])).rows[0].n, 8);

  const run2 = randomUUID();
  await owner.query(`INSERT INTO agent_runs (id, tenant_id, migration_id, kind) VALUES ($1,$2,$3,'remediate')`, [run2, T, m]);
  const boom = { model: "m-x", create: async () => { throw new Error("down"); } };
  const r = await h.handleAgentRun({ tenantId: T, requestId: "e", agentRunId: run2 }, { ...h.stubDeps(store), llm: boom });
  assert.equal(r.skipped === false && r.state, "failed");
  const f = (await owner.query(`SELECT status, reason, model FROM agent_runs WHERE id=$1`, [run2])).rows[0];
  assert.deepEqual({ ...f, reason: String(f.reason).startsWith("LLM_") }, { status: "failed", reason: true, model: "m-x" });
  const au = (await owner.query(
    `SELECT result FROM audit_events WHERE tenant_id=$1 AND action='agent.remediate' AND detail->>'agentRunId'=$2`, [T, run2])).rows;
  assert.deepEqual(au, [{ result: "error" }]);
  // 이미 닫힌 실행에 finish 가 또 와도 바뀌지 않는다
  await store.finish(T, run2, { state: "finished", reason: "late", model: "z", finish: null, gate: { ok: true, violations: [] }, usage: { input: 1, output: 1 } });
  assert.equal((await owner.query(`SELECT status FROM agent_runs WHERE id=$1`, [run2])).rows[0].status, "failed");
  // spec_draft 실행 번호로는 remediate 저장소가 아무것도 못 한다 (kind 조건)
  const sd = randomUUID();
  await owner.query(`INSERT INTO agent_runs (id, tenant_id, migration_id, kind) VALUES ($1,$2,$3,'spec_draft')`, [sd, T, m]);
  assert.equal(await store.load(T, sd), null);
  assert.equal(await store.claim(T, sd), false);
});
