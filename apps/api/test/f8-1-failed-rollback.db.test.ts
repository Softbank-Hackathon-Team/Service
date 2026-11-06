// F8-1: 컷오버·롤백 도중 failed 가 된 이전은 POST rollback 으로 다시 롤백 (failed → rolling_back). 그 전 단계 실패는 거부
// 자기 회사·환경을 따로 만들고, 큐 작업이 처리되는지에 기대지 않는다
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-f8-1')", [T]);
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

async function seed(failedAt: string, o: { locks?: boolean } = {}) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, failed_at_status, failure_code)
    VALUES ($1,$2,$3,$4,'failed',$5,'WORKER_LOST')`, [id, T, src, dst, failedAt]);
  // 데이터가 움직인 뒤의 실패는 잠금을 남긴다. provisioning 실패는 잠금을 푼다 (advance RELEASES_LOCK) → locks:false
  if (o.locks !== false)
    await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
      VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, id]);
  return id;
}
const st = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const jobs = async (id: string) => (await owner.query(`SELECT 1 FROM pgboss.job WHERE name='rollback' AND data->>'migrationId'=$1`, [id])).rows.length;
const locks = async (id: string) => (await owner.query("SELECT holder FROM env_locks WHERE migration_id=$1 ORDER BY env_id", [id])).rows.map((r) => r.holder);
const rollback = (id: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/rollback`, payload: { reason: "컷오버 중 실패, 다시 롤백" }, headers: H });

test("정상: 컷오버·롤백 중 실패한 이전 → 202 rolling_back + 롤백 작업 1개", { skip }, async () => {
  for (const at of ["cutover", "rolling_back"]) {
    const id = await seed(at);
    const r = await rollback(id);
    assert.equal(r.statusCode, 202, r.body);
    assert.deepEqual(r.json(), { id, from: "failed", status: "rolling_back" });
    assert.equal((await st(id)).status, "rolling_back");
    assert.equal(await jobs(id), 1);
  }
});

// Jeong 11/4 01:53Z: provisioning 실패도 거절 = 롤백이라 롤백 길이 열렸다. 만들기 전(planning) 실패만 막는다
test("거부: 자원을 만들기 전(planning)에 실패한 이전은 409 GUARD_FAILED, 상태·작업 그대로", { skip }, async () => {
  const id = await seed("planning");
  const r = await rollback(id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "GUARD_FAILED");
  assert.equal((await st(id)).status, "failed");
  assert.equal(await jobs(id), 0);
});

// provisioning 실패는 잠금을 풀어 둔다. 롤백 작업(rolling_back)은 잠금을 인수해야 일하므로, failure-decision 거절 길처럼 여기서도 다시 예약한다
test("정상: 잠금이 풀린 provisioning 실패 → POST rollback 이 두 환경 잠금을 다시 예약 (롤백 작업이 인수할 수 있게)", { skip }, async () => {
  const id = await seed("provisioning", { locks: false });
  const r = await rollback(id);
  assert.equal(r.statusCode, 202, r.body);
  assert.equal((await st(id)).status, "rolling_back");
  assert.equal(await jobs(id), 1);
  assert.deepEqual(await locks(id), ["reserved", "reserved"]);
});

test("거부: 잠금이 풀린 사이 다른 이전이 도착 환경을 잡았으면 409 ENV_BUSY, 상태·작업·잠금 그대로", { skip }, async () => {
  const id = await seed("provisioning", { locks: false });
  const dst = (await owner.query("SELECT target_env_id AS t FROM migrations WHERE id=$1", [id])).rows[0].t;
  const other = randomUUID();
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    SELECT $1, tenant_id, source_env_id, target_env_id, 'provisioning' FROM migrations WHERE id=$2`, [other, id]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$2,$3,'reserved', now() + interval '10 minutes')`, [dst, T, other]);
  const r = await rollback(id);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "ENV_BUSY");
  assert.equal((await st(id)).status, "failed");
  assert.equal(await jobs(id), 0);
  assert.deepEqual(await locks(id), []);
});
