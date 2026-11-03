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

async function seed(failedAt: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, failed_at_status, failure_code)
    VALUES ($1,$2,$3,$4,'failed',$5,'WORKER_LOST')`, [id, T, src, dst, failedAt]);
  // 데이터가 움직인 뒤의 실패는 잠금을 남긴다 (advance RELEASES_LOCK)
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, id]);
  return id;
}
const st = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const jobs = async (id: string) => (await owner.query(`SELECT 1 FROM pgboss.job WHERE name='rollback' AND data->>'migrationId'=$1`, [id])).rows.length;
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

test("거부: 자원 만들기 이하에서 실패한 이전은 409 GUARD_FAILED (다시 계획으로), 상태·작업 그대로", { skip }, async () => {
  const id = await seed("provisioning");
  const r = await rollback(id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "GUARD_FAILED");
  assert.equal((await st(id)).status, "failed");
  assert.equal(await jobs(id), 0);
});
