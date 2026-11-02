// 리소스 회수: 롤백 대기를 일찍 끝낸다. 상태는 그대로이고, 기다리던 cleanup 작업의 시작 시각만 당겨진다.
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
const H = { "x-dev-tenant": T };

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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-reclaim')", [T]);
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
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed(status: string, endsInSec: number | null, withJob: boolean) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, rollback_window_ends_at)
    VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(secs => $6::int) END)`,
    [id, T, src, dst, status, endsInSec]);
  if (withJob) await core.boss.send("cleanup", { tenantId: T, requestId: randomUUID(), migrationId: id },
    { singletonKey: `cleanup:${id}`, startAfter: 900 });
  return id;
}
const row = async (id: string) => (await owner.query(
  `SELECT status, rollback_window_ends_at <= now() AS over FROM migrations WHERE id=$1`, [id])).rows[0];
const jobs = async (id: string) => (await owner.query(
  `SELECT start_after <= now() AS due FROM pgboss.job WHERE name='cleanup' AND singleton_key=$1 AND state='created'`, [`cleanup:${id}`])).rows;
const reclaim = (id: string, key = randomUUID()) => app.inject({ method: "POST", url: `${P}/migrations/${id}/reclaim`,
  payload: {}, headers: { ...H, "idempotency-key": key } });

test("창 안이면 202. 상태는 그대로, 창은 닫히고, 기다리던 cleanup 작업이 바로 깨어난다", { skip }, async () => {
  const id = await seed("rollback_window", 900, true);
  assert.deepEqual((await jobs(id)).map((j) => j.due), [false]);
  const r = await reclaim(id);
  assert.equal(r.statusCode, 202);
  assert.equal(r.json().status, "rollback_window");
  assert.deepEqual(await row(id), { status: "rollback_window", over: true });
  assert.deepEqual((await jobs(id)).map((j) => j.due), [true]);
  const audit = await owner.query(
    `SELECT result FROM audit_events WHERE target=$1 AND action='migration.reclaim_requested'`, [id]);
  assert.equal(audit.rows.length, 1);
});

test("회수한 뒤에는 롤백을 가드가 막는다", { skip }, async () => {
  const id = await seed("rollback_window", 900, true);
  assert.equal((await reclaim(id)).statusCode, 202);
  const r = await app.inject({ method: "POST", url: `${P}/migrations/${id}/rollback`, payload: {}, headers: H });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "GUARD_FAILED");
});

test("기다리는 작업이 없으면 새로 넣는다", { skip }, async () => {
  const id = await seed("rollback_window", 900, false);
  assert.equal((await reclaim(id)).statusCode, 202);
  assert.deepEqual((await jobs(id)).map((j) => j.due), [true]);
});

test("같은 멱등 키로 다시 보내면 첫 응답을 돌려준다", { skip }, async () => {
  const id = await seed("rollback_window", 900, true);
  const key = randomUUID();
  const a = await reclaim(id, key), b = await reclaim(id, key);
  assert.equal(a.statusCode, 202);
  assert.equal(b.statusCode, 202);
  assert.deepEqual(b.json(), a.json());
  assert.equal((await jobs(id)).length, 1);
});

test("다른 상태면 409 INVALID_TRANSITION, 아무것도 바뀌지 않는다", { skip }, async () => {
  const id = await seed("shifting", null, false);
  const r = await reclaim(id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "INVALID_TRANSITION");
  assert.equal((await row(id)).status, "shifting");
  assert.equal((await jobs(id)).length, 0);
});

test("다른 회사의 이전은 404", { skip }, async () => {
  const id = await seed("rollback_window", 900, false);
  const r = await app.inject({ method: "POST", url: `${P}/migrations/${id}/reclaim`, payload: {},
    headers: { "x-dev-tenant": randomUUID(), "idempotency-key": randomUUID() } });
  assert.equal(r.statusCode, 404);
});
