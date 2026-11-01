// DB 시험: 명세 초안 저장소(Postgres). DATABASE_URL·OWNER_DATABASE_URL이 없으면 건너뛴다.
// 필요한 표: db/migrations/0006_agent_runs.sql (작업 K 제안)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { adapterFor, DEMO_INVENTORY } from "@svc/adapters";
import { mockDraftLlm } from "@svc/agent";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let h: typeof import("../src/handle-spec-draft.js");
let st: typeof import("../src/pg-spec-draft-store.js");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID(), S = randomUUID(), G = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  h = await import("../src/handle-spec-draft.js");
  st = await import("../src/pg-spec-draft-store.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-agent'), ($2, 'test-other')", [T, OTHER]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

// 가져오기가 끝난 이전 하나(spec v1)와 queued 실행 한 건을 만든다 (시험 준비는 표 주인 계정)
async function setup() {
  const m = randomUUID(), run = randomUUID();
  const { spec, fieldMeta } = adapterFor("aws").normalize(DEMO_INVENTORY.aws);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`, [m, T, S, G]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta) VALUES ($1,$2,1,$3,$4)`, [T, m, spec, fieldMeta]);
  await owner.query(`INSERT INTO agent_runs (id, tenant_id, migration_id, kind) VALUES ($1,$2,$3,'spec_draft')`, [run, T, m]);
  return { m, run };
}

test("Postgres: 초안이 spec_versions v2(_draft 표시)로 저장, 실행·단계·감사 기록, 남의 회사는 못 봄", { skip }, async () => {
  const { m, run } = await setup();
  const store = st.pgSpecDraftStore();
  assert.equal(await store.load(OTHER, run), null);                         // 회사 벽: 남의 실행은 안 보인다
  const job = { tenantId: T, requestId: "req-db", agentRunId: run };
  const r = await h.handleSpecDraft(job, { store, llm: mockDraftLlm() });
  assert.equal(r.skipped, false);
  if (r.skipped || r.state !== "finished") throw new Error(JSON.stringify(r));
  assert.equal(r.version, 2);
  const v = (await owner.query(`SELECT version, field_meta ? '_draft' AS draft FROM spec_versions WHERE migration_id=$1 ORDER BY version`, [m])).rows;
  assert.deepEqual(v, [{ version: 1, draft: false }, { version: 2, draft: true }]);
  const ar = (await owner.query(`SELECT status, model, jsonb_array_length(result->'risks') AS risks FROM agent_runs WHERE id=$1`, [run])).rows[0];
  assert.equal(ar.status, "finished"); assert.equal(ar.model, "mock-draft"); assert.ok(ar.risks >= 4);
  const steps = (await owner.query(`SELECT count(*)::int AS n FROM agent_steps WHERE run_id=$1`, [run])).rows[0].n;
  assert.equal(steps, 7);
  const au = (await owner.query(`SELECT actor, result FROM audit_events WHERE tenant_id=$1 AND action='agent.spec_draft' AND target=$2`, [T, m])).rows;
  assert.deepEqual(au, [{ actor: "ai_agent", result: "ok" }]);
  // 두 번 온 작업은 아무것도 안 한다
  assert.deepEqual(await h.handleSpecDraft(job, { store, llm: mockDraftLlm() }), { skipped: true });
});

test("Postgres: 다음 초안은 AI 판이 아니라 규칙 판(v1)을 기준으로 v3 에 저장, 실패는 failed + 감사 error", { skip }, async () => {
  const { m, run } = await setup();
  const store = st.pgSpecDraftStore();
  await h.handleSpecDraft({ tenantId: T, requestId: "a", agentRunId: run }, { store, llm: mockDraftLlm() });
  const run2 = randomUUID(), run3 = randomUUID();
  await owner.query(`INSERT INTO agent_runs (id, tenant_id, migration_id, kind) VALUES ($1,$3,$4,'spec_draft'), ($2,$3,$4,'spec_draft')`, [run2, run3, T, m]);
  const loaded = await store.load(T, run2);
  assert.equal(loaded?.input.baseline.version, 1);
  const r2 = await h.handleSpecDraft({ tenantId: T, requestId: "b", agentRunId: run2 }, { store, llm: mockDraftLlm() });
  assert.equal(r2.skipped === false && r2.state === "finished" ? r2.version : -1, 3);
  const boom = { model: "x", create: async () => { throw new Error("down"); } };
  await h.handleSpecDraft({ tenantId: T, requestId: "c", agentRunId: run3 }, { store, llm: boom });
  const f = (await owner.query(`SELECT status, reason FROM agent_runs WHERE id=$1`, [run3])).rows[0];
  assert.deepEqual(f, { status: "failed", reason: "LLM 호출 실패: LLM_UNKNOWN" });
});
