// PF FM-ORC-19: advance 가 넣는 실패 원인 분석(kind=failure_analysis)을 에이전트 워커가 집어 끝낸다. 오래된 queued 는 busy 가 아니다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DB 없음" : false;
let core: typeof import("@svc/core");
let route: typeof import("../src/route.js");
let st: typeof import("../src/pg-agent-run-store.js");
let owner: pg.Client;
const T = randomUUID(), S = randomUUID(), G = randomUUID();
before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  route = await import("../src/route.js");
  st = await import("../src/pg-agent-run-store.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-orc-19')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

async function failedMigration(): Promise<string> {
  const m = randomUUID();
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, failed_at_status, failure_code) VALUES ($1,$2,$3,$4,'failed','provisioning','TF_APPLY_FAILED')`, [m, T, S, G]);
  return m;
}

test("PF FM-ORC-19 정상: failure_analysis 줄을 저장소가 읽고·집고·닫고, 감사는 agent.failure_analysis. 라우터는 kind 를 그대로", { skip }, async () => {
  const m = await failedMigration(), run = randomUUID();
  await owner.query(`INSERT INTO agent_runs (id, tenant_id, migration_id, kind, task) VALUES ($1,$2,$3,'failure_analysis','실패 원인 분석')`, [run, T, m]);
  const store = st.pgAgentRunStore();
  assert.equal((await store.load(T, run))?.status, "queued");
  assert.equal(await store.claim(T, run), true);
  assert.equal(await store.claim(T, run), false, "두 번 집지 않는다");
  await store.finish(T, run, { state: "finished", reason: "ok", model: "m", usage: {}, finish: null, gate: { ok: true }, proposal: null } as never);
  assert.equal((await owner.query("SELECT status FROM agent_runs WHERE id=$1", [run])).rows[0].status, "finished");
  assert.equal((await owner.query("SELECT 1 FROM audit_events WHERE target=$1 AND action='agent.failure_analysis'", [m])).rowCount, 1);
  // 라우터: 이미 끝난 줄이면 handleAgentRun 이 건너뛰고, kind 는 failure_analysis 로 돌려준다
  const r = await route.routeAgentRun({ tenantId: T, requestId: "r", agentRunId: run }, {
    kindOf: async () => "failure_analysis",
    remediate: { store, llm: { async call() { throw new Error("불리면 안 됨"); } } as never, sandbox: () => { throw new Error("불리면 안 됨"); } } as never,
    specDraft: {} as never,
  });
  assert.equal(r.kind, "failure_analysis");
});

test("PF FM-ORC-19 거부: 워커가 안 떠서 30분 넘게 queued 인 분석은 busy 로 치지 않는다 (running 은 busy)", { skip }, async () => {
  const m = await failedMigration(), old = randomUUID(), run2 = randomUUID();
  await owner.query(`INSERT INTO agent_runs (id, tenant_id, migration_id, kind, task, created_at) VALUES ($1,$2,$3,'failure_analysis','옛 분석', now() - interval '2 hours')`, [old, T, m]);
  const send = async () => "job-1";
  const a = await core.withTenant(T, (tx) => core.queueAgentRun(tx, { tenantId: T, migrationId: m, requestId: "r2", kind: "failure_analysis", task: "다음 실패", send, env: {} }));
  assert.ok("runId" in a, JSON.stringify(a));
  const m2 = await failedMigration();
  await owner.query(`INSERT INTO agent_runs (id, tenant_id, migration_id, kind, task, status, created_at) VALUES ($1,$2,$3,'failure_analysis','도는 중','running', now() - interval '2 hours')`, [run2, T, m2]);
  const b = await core.withTenant(T, (tx) => core.queueAgentRun(tx, { tenantId: T, migrationId: m2, requestId: "r3", kind: "failure_analysis", task: "또", send, env: {} }));
  assert.deepEqual(b, { skipped: "busy", busyRunId: run2 });
});
