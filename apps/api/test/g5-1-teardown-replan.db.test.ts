// G5-1 (ADR-066): provisioning → failed 가 같은 트랜잭션에 target-destroy 작업을 넣고, 지우기가 끝나기 전 다시 계획은 409
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID();

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-g5-1-replan')", [T]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(planRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function failAtProvisioning() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'provisioning')`,
    [id, T, src, dst]);
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "provisioning", "failed", {
    failureCode: "APPLY_FAILED", analyze: false,
    audit: { actor: "worker", action: "apply.failed", target: id, result: "error", detail: { requestId: "r-g5" } } }));
  return id;
}
const destroyJobs = async (id: string) => (await owner.query(
  `SELECT id, state, data FROM pgboss.job WHERE name='target-destroy' AND data->>'migrationId'=$1`, [id])).rows;
const replan = (id: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/replan`, payload: {},
  headers: { "x-dev-tenant": T, "idempotency-key": randomUUID() } });

test("G5-1 정상: provisioning → failed 가 target-destroy 작업 1개를 넣고 감사 requested(queued:true, auto)", { skip }, async () => {
  const id = await failAtProvisioning();
  const jobs = await destroyJobs(id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].data.requestId, "r-g5");
  const a = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='target_teardown.requested'`, [id])).rows;
  assert.equal(a.length, 1);
  assert.equal(a[0].detail.queued, true);
  assert.equal(a[0].detail.mode, "auto");
});

test("G5-1 거부: 지우기 작업이 남아 있으면 다시 계획 409 TEARDOWN_PENDING, 끝나면 다시 계획 202", { skip }, async () => {
  const id = await failAtProvisioning();
  const r = await replan(id);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "TEARDOWN_PENDING");
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "failed");
  await owner.query(`UPDATE pgboss.job SET state='completed', completed_on=now() WHERE name='target-destroy' AND data->>'migrationId'=$1`, [id]);
  const ok = await replan(id);
  assert.equal(ok.statusCode, 202, ok.body);
});
