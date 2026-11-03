// G7-3 입력층: POST /environments/:id/verify 에서 계정 번호가 바뀌면 그 환경을 쓰는 승인 대기·승인됨 이전 → stale(env_changed). 같은 계정이면 그대로
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
  const { environmentRoutes } = await import("../src/routes/environments.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-g73v')", [T]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(environmentRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

// 실패한 연결(다시 verify 할 수 있음) + 그 환경을 도착으로 쓰는 승인된 이전 하나
async function seed(account: string) {
  const src = randomUUID(), dst = randomUUID(), mig = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$2,'gcp',$3,'connected')`, [src, T, `s-${src.slice(0, 8)}`]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id) VALUES ($1,$2,'aws',$3,'failed',$4,$5)`, [dst, T, `d-${dst.slice(0, 8)}`, account, `ext-${dst}`]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'approved')`, [mig, T, src, dst]);
  return { dst, mig };
}
const status = async (mig: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [mig])).rows[0].status as string;
const verify = (env: string, accountId: string) =>
  app.inject({ method: "POST", url: `${P}/environments/${env}/verify`, headers: { "x-dev-tenant": T }, payload: { accountId } });

test("계정이 바뀌면: 승인된 이전 → stale, 감사 detail 에 env_changed", { skip }, async () => {
  const { dst, mig } = await seed("111122223333");
  const r = await verify(dst, "444455556666");
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(await status(mig), "stale");
  const a = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.stale'", [mig])).rows;
  assert.equal(a.length, 1);
  assert.equal(a[0].detail.staleReason, "env_changed");
});

test("거부: 같은 계정으로 다시 확인하면 이전은 그대로 approved", { skip }, async () => {
  const { dst, mig } = await seed("111122223333");
  const r = await verify(dst, "111122223333");
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(await status(mig), "approved");
});
