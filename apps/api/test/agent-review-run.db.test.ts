// 작업 Z65 DB 시험: 장애 점검 시작 경로 POST /migrations/:id/agent-review/run (app.inject, 포트 안 엶)
// 큐 넣기는 바꿔 끼운다 (진짜 pg-boss 경로는 실워커 확인 로그 parallel/Z65/logs/ 에)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const T = randomUUID(), OTHER = randomUUID(), S = randomUUID(), G = randomUUID();
let app: FastifyInstance;
let pool: { end(): Promise<void> };
let owner: pg.Client;
const sent: Array<{ data: unknown; key: string | undefined }> = [];
let sendReturns: string | null = "job-1";

before(async () => {
  if (skip) return;
  const core = await import("@svc/core");
  pool = core.pool;
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { agentReviewRoutes } = await import("../src/routes/agent-review.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-run'), ($2, 'test-run-other')", [T, OTHER]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(agentReviewRoutes, {
    prefix: "/api/v1",
    llmEnv: { AGENT_LLM_KEY_SET: "1" },   // Z90: 키 "있음" 표시만 (값 없음). 없으면 409 LLM_KEY_MISSING
    send: async (_tx: unknown, data: unknown, key: string | undefined) => { sent.push({ data, key }); return sendReturns; },
  });
  await app.ready();
});
after(async () => { if (!skip) { await app.close(); await pool.end(); await owner.end(); } });

async function migration() {
  const m = randomUUID();
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`, [m, T, S, G]);
  return m;
}
const run = (m: string, o: { tenant?: string; key?: string; body?: object } = {}) => app.inject({
  method: "POST", url: `/api/v1/migrations/${m}/agent-review/run`, payload: o.body ?? {},
  headers: { "x-dev-tenant": o.tenant ?? T, ...(o.key ? { "idempotency-key": o.key } : {}) } });

test("시작: 202 + queued 줄 + 큐 작업 1개 + 감사, 같은 키 재요청은 같은 runId(재생), 진행 중이면 409", { skip }, async () => {
  const m = await migration();
  const k = `key-${randomUUID()}`;
  const n0 = sent.length;
  const a = await run(m, { key: k, body: { task: "web 재시작 원인" } });
  assert.equal(a.statusCode, 202, a.body);
  const body = a.json();
  assert.equal(body.migrationId, m); assert.equal(body.status, "queued"); assert.equal(body.kind, "remediate");
  const row = (await owner.query(`SELECT tenant_id, kind, status, task FROM agent_runs WHERE id=$1`, [body.runId])).rows[0];
  assert.deepEqual(row, { tenant_id: T, kind: "remediate", status: "queued", task: "web 재시작 원인" });
  assert.equal(sent.length - n0, 1);
  const job = sent.at(-1)!;
  assert.equal(job.key, `agent-run:${body.runId}`);
  assert.deepEqual({ ...(job.data as object), requestId: "-" }, { tenantId: T, requestId: "-", agentRunId: body.runId });
  const au = (await owner.query(
    `SELECT actor, result FROM audit_events WHERE tenant_id=$1 AND action='agent.remediate.requested' AND target=$2`, [T, m])).rows;
  assert.deepEqual(au, [{ actor: "user:dev", result: "ok" }]);

  const b = await run(m, { key: k, body: { task: "web 재시작 원인" } });
  assert.equal(b.statusCode, 202);
  assert.equal(b.json().runId, body.runId);
  assert.equal(b.headers["idempotent-replayed"], "true");
  assert.equal(sent.length - n0, 1);                                  // 재생은 큐에 또 넣지 않는다

  const c = await run(m);                                            // 다른 요청(키 없음) → 아직 queued 라 409
  assert.equal(c.statusCode, 409);
  assert.equal(c.json().code, "AGENT_RUN_IN_PROGRESS");

  await owner.query(`UPDATE agent_runs SET status='finished', finished_at=now() WHERE id=$1`, [body.runId]);
  const d = await run(m);                                            // 끝났으면 다시 시작 가능, 기본 문장
  assert.equal(d.statusCode, 202);
  const t2 = (await owner.query(`SELECT task FROM agent_runs WHERE id=$1`, [d.json().runId])).rows[0].task;
  assert.match(t2, /재시작/);
});

test("남의 회사·없는 이전은 404 (줄·큐·감사 안 남음), 본문 모양 틀리면 400, 큐 실패면 통째로 취소", { skip }, async () => {
  const m = await migration();
  const n0 = sent.length;
  const other = await run(m, { tenant: OTHER });
  assert.equal(other.statusCode, 404);
  assert.equal((await run(randomUUID())).statusCode, 404);
  assert.equal(sent.length, n0);
  assert.equal((await run(m, { body: { task: "" } })).statusCode, 400);
  assert.equal((await run(m, { body: { task: "x".repeat(2001) } })).statusCode, 400);
  assert.equal((await run(m, { body: { extra: 1 } })).statusCode, 400);

  sendReturns = null;
  try {
    const r = await run(m);
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "JOB_NOT_CREATED");
  } finally { sendReturns = "job-1"; }
  const rows = (await owner.query(`SELECT count(*)::int AS n FROM agent_runs WHERE migration_id=$1`, [m])).rows[0].n;
  assert.equal(rows, 0);                                              // INSERT 도 같이 취소
  const au = (await owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE target=$1`, [m])).rows[0].n;
  assert.equal(au, 0);
});

// 작업 Z90: 명세 초안 다시 만들기도 같은 경로 (kind=spec_draft). 같은 종류만 진행 중 409
test("Z90: kind=spec_draft 시작 → agent_runs kind spec_draft queued + 큐 작업 1건", { skip }, async () => {
  const m = await migration();
  const r = await app.inject({ method: "POST", url: `/api/v1/migrations/${m}/agent-review/run`,
    headers: { "x-dev-tenant": T, "content-type": "application/json" }, payload: { kind: "spec_draft" } });
  assert.equal(r.statusCode, 202, r.body);
  const body = r.json();
  assert.equal(body.kind, "spec_draft");
  const row = (await owner.query(`SELECT kind, status FROM agent_runs WHERE id=$1`, [body.runId])).rows[0];
  assert.deepEqual(row, { kind: "spec_draft", status: "queued" });
  const again = await app.inject({ method: "POST", url: `/api/v1/migrations/${m}/agent-review/run`,
    headers: { "x-dev-tenant": T, "content-type": "application/json" }, payload: { kind: "spec_draft" } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, "AGENT_RUN_IN_PROGRESS");
});
