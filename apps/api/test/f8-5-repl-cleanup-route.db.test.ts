// F8-5: POST /migrations/:id/replication-cleanup — 끝난 이전에만 다시 걷기 작업을 넣는다 (상태 안 바꿈)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { controlRoutes } = await import("../src/routes/control.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-f8-5-route'), ($2,'test-f8-5-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(controlRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed(status: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, T, src, dst, status]);
  return id;
}
const post = (id: string, tenant = T, key = randomUUID()) => app.inject({ method: "POST", url: `${P}/migrations/${id}/replication-cleanup`,
  payload: { reason: "slot left" }, headers: { "x-dev-tenant": tenant, "idempotency-key": key } });
const jobs = async (id: string) => (await owner.query(
  `SELECT count(*)::int n FROM pgboss.job WHERE name='repl-cleanup' AND data->>'migrationId'=$1 AND state IN ('created','retry')`, [id])).rows[0].n;
const status = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status;

test("F8-5 정상: rolled_back → 202, repl-cleanup 작업 1개, 상태 그대로, 감사 replication.cleanup_requested", { skip }, async () => {
  const id = await seed("rolled_back");
  const r = await post(id);
  assert.equal(r.statusCode, 202, r.body);
  assert.deepEqual(r.json(), { id, status: "rolled_back", jobQueued: true });
  assert.equal(await jobs(id), 1);
  assert.equal(await status(id), "rolled_back");
  // 키 없이 또 눌러도(다른 키) 같은 작업 키가 대기 중이라 작업은 1개
  const again = await post(id);
  assert.equal(again.statusCode, 202);
  assert.equal(again.json().jobQueued, false);
  assert.equal(await jobs(id), 1);
  const a = (await owner.query(`SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='replication.cleanup_requested'`, [id])).rows[0].n;
  assert.equal(a, 2);
});

test("F8-5 거부: 진행 중·failed 이전은 409 NOT_FINISHED, 작업 0 / 남의 회사 이전은 404", { skip }, async () => {
  for (const s of ["syncing", "failed", "rolling_back"]) {
    const id = await seed(s);
    const r = await post(id);
    assert.equal(r.statusCode, 409, `${s}: ${r.body}`);
    assert.equal(r.json().code, "NOT_FINISHED");
    assert.equal(await jobs(id), 0);
  }
  const mine = await seed("rolled_back");
  assert.equal((await post(mine, OTHER)).statusCode, 404);
  assert.equal(await jobs(mine), 0);
});
