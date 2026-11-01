// DB 시험(작업 Z32, 맥 int5-4 kill 실측): 청소가 paused(JOB_NOT_PICKED, shifting)로 보낸 뒤 늦게 집힌 shift 작업은 job.rejected 로 끝난다.
// 그 다음 사람이 재개하면 shift 부터 다시 간다: 202 shifting, shift 작업 1개, 잠금 reserved 10분
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
  const { controlRoutes } = await import("../src/routes/control.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z32-resume-shift')", [T]);
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

test("Z32: paused(shifting, JOB_NOT_PICKED) + 늦은 shift 작업 job.rejected → 사람 재개 → 202 shifting, shift 작업 1개, reserved 10분", { skip }, async () => {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, paused_from, failure_code)
    VALUES ($1,$2,$3,$4,'paused','shifting','JOB_NOT_PICKED')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '5 minutes'), ($2,$3,$4,'reserved', now() + interval '5 minutes')`, [src, dst, T, id]);
  await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "job.rejected", target: id, result: "ok",
    detail: { job: "shift", reason: "status_mismatch", expected: "shifting", actual: "paused" } }));
  const r = await app.inject({ method: "POST", url: `${P}/migrations/${id}/resume`,
    payload: { reason: "queue drained" }, headers: { "x-dev-tenant": T } });
  assert.equal(r.statusCode, 202, r.body);
  assert.deepEqual(r.json(), { id, from: "paused", status: "shifting", queue: "shift", jobQueued: true });
  const m = (await owner.query("SELECT status, paused_from, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
  assert.deepEqual(m, { status: "shifting", paused_from: null, failure_code: null });
  const j = (await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE name='shift' AND data->>'migrationId'=$1", [id])).rows[0].n;
  assert.equal(j, 1);
  const l = (await owner.query("SELECT holder, extract(epoch from lease_expires_at - now())::int s FROM env_locks WHERE migration_id=$1", [id])).rows;
  assert.ok(l.length === 2 && l.every((x) => x.holder === "reserved" && x.s > 500), JSON.stringify(l));
});
