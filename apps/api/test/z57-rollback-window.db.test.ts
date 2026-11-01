// Z57: 10/31 보드 기본값 "롤백 가능 시간이 지나면 서버가 거부(P-4)" 확인 시험. 코드는 int5 에 이미 있다
// (packages/core/src/guards.ts "rollback_window>rolling_back"). 이 시험은 HTTP 경로에서 409 가 나는지만 고정한다.
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z57-window')", [T]);
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

// rollback_window 상태 이전 하나. endsIn 초 뒤 창이 닫힌다(음수 = 이미 닫힘)
async function seed(endsInSec: number) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, rollback_window_ends_at)
    VALUES ($1,$2,$3,$4,'rollback_window', now() + make_interval(secs => $5))`, [id, T, src, dst, endsInSec]);
  return id;
}
const st = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status;
const rollback = (id: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/rollback`, payload: {}, headers: H });

test("P-4: 롤백 가능 창이 지난 뒤 POST rollback → 409 GUARD_FAILED, 상태 그대로", { skip }, async () => {
  const id = await seed(-1);
  const r = await rollback(id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "GUARD_FAILED");
  assert.match(r.json().message, /rollback window is over/);
  assert.equal(await st(id), "rollback_window");
  const jobs = (await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE name='rollback' AND data->>'migrationId'=$1", [id])).rows[0].n;
  assert.equal(jobs, 0, "거부되면 롤백 작업도 안 들어간다");
});

test("P-4: 창 안이면 POST rollback → 202 rolling_back", { skip }, async () => {
  const id = await seed(60);
  const r = await rollback(id);
  assert.equal(r.statusCode, 202);
  assert.equal(await st(id), "rolling_back");
});
