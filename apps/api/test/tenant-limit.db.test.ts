// A8: 회사당 동시 진행 이전 상한 (TENANT_MAX_ACTIVE). start 가 넘으면 409 TENANT_BUSY.
// 정상: 꺼짐이면 그대로 202 / 상한 안이면 202. 거부: 상한 1 + 진행 중 1 → 409. 남의 회사 이전은 안 센다.
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
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-limit'), ($2,'test-limit-other')", [T, OTHER]);
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
  delete process.env.TENANT_MAX_ACTIVE;
  await owner.query("DELETE FROM env_locks WHERE tenant_id = ANY($1)", [[T, OTHER]]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed(tenant: string, status: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, tenant]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, tenant, src, dst, status]);
  return { id, src, dst };
}
// 시작 직전: 승인된 계획 + 예약된 환경 잠금
async function approved() {
  const m = await seed(T, "approved");
  const plan = await owner.query(`INSERT INTO plans (tenant_id, migration_id, plan_doc, plan_hash, expires_at)
    VALUES ($1,$2,'{}',$3, now() + interval '2 hours') RETURNING id`, [T, m.id, `h-${m.id}`]);
  await core.withTenant(T, async (tx) => {
    await core.saveApproval(tx, T, m.id, { planId: plan.rows[0].id, planHash: `h-${m.id}`, decision: "approve",
      actor: "test", selfApproved: true });
    await core.reserveEnvLocks(tx, { id: m.id, tenantId: T }, [m.src, m.dst], new Date(Date.now() + 3600_000));
  });
  return m.id;
}
const start = (id: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/start`,
  headers: { ...H, "idempotency-key": randomUUID() } });
const status = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status;

test("꺼짐(기본)이면 진행 중 이전이 많아도 start 는 지금처럼 202", { skip }, async () => {
  delete process.env.TENANT_MAX_ACTIVE;
  await seed(T, "provisioning"); await seed(T, "deploying");
  const id = await approved();
  assert.equal((await start(id)).statusCode, 202);
  assert.equal(await status(id), "provisioning");
});

test("상한 1 + 같은 회사 진행 중 1 → 409 TENANT_BUSY, 상태는 approved 그대로", { skip }, async () => {
  const id = await approved();
  process.env.TENANT_MAX_ACTIVE = "1";
  const r = await start(id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "TENANT_BUSY");
  assert.equal(await status(id), "approved");
});

test("남의 회사 진행 중 이전은 안 센다 / 상한 안이면 통과", { skip }, async () => {
  // 이 회사의 진행 중은 앞 시험들이 남긴 것이 있으니 새 회사로 따로 센다
  const T2 = randomUUID();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-limit-3')", [T2]);
  await seed(OTHER, "provisioning"); await seed(OTHER, "deploying");
  const q = await owner.query("SELECT count(*)::int n FROM migrations WHERE tenant_id=$1 AND status IN ('provisioning','deploying')", [T2]);
  assert.equal(q.rows[0].n, 0);
  process.env.TENANT_MAX_ACTIVE = "1";
  const n = await core.withTenant(T2, async (tx) => { await core.assertTenantCapacity(tx, T2, randomUUID()); return "ok"; });
  assert.equal(n, "ok");   // T2 는 0개 → 남의 회사 진행 중 4개와 무관하게 통과
  await seed(T2, "provisioning");
  await assert.rejects(core.withTenant(T2, (tx) => core.assertTenantCapacity(tx, T2, randomUUID())),
    (e: { code?: string }) => e.code === "TENANT_BUSY");
  await owner.query("DELETE FROM migrations WHERE tenant_id=$1", [T2]);
  await owner.query("DELETE FROM environments WHERE tenant_id=$1", [T2]);
  await owner.query("DELETE FROM tenants WHERE id=$1", [T2]);
});
