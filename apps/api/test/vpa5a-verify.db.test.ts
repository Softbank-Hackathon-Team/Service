// 검증 PA5a: 재시도 한도 경계 — RETRY_BUDGET 값(0·1·글자·소수), 동시 재시도, 거부 뒤 흔적 0, 이전별 따로 셈
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
  delete process.env.RETRY_BUDGET;   // 기본 3
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  const { controlRoutes } = await import("../src/routes/control.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vpa5a-retry'), ($2,'test-vpa5a-retry-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(planRoutes, { prefix: P });
  await app.register(controlRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'draft')`,
    [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at) VALUES
    ($1,$3,$4,'worker:dead',now() - interval '1 minute'), ($2,$3,$4,'worker:dead',now() - interval '1 minute')`, [src, dst, T, id]);
  return id;
}
// 시험용으로 상태를 바로 놓는다 (표 주인 계정). 앞 단계가 넣은 작업은 지워 작업 키가 비게 한다
async function failAt(id: string) {
  await owner.query("DELETE FROM pgboss.job WHERE singleton_key LIKE $1", [`%:${id}`]);
  await owner.query(`UPDATE migrations SET status='failed', failed_at_status='provisioning', failure_code='APPLY_FAILED' WHERE id=$1`, [id]);
}
async function pauseAt(id: string) {
  await owner.query("DELETE FROM pgboss.job WHERE singleton_key LIKE $1", [`%:${id}`]);
  await owner.query(`UPDATE migrations SET status='paused', paused_from='deploying', failure_code='JOB_FAILED_DEPLOY' WHERE id=$1`, [id]);
}
const post = (id: string, path: "replan" | "resume", body?: object, tenant = T) => app.inject({
  method: "POST", url: `${P}/migrations/${id}/${path}`, ...(body ? { payload: body } : {}),
  headers: { "x-dev-tenant": tenant, "idempotency-key": `pa5a-${randomUUID()}` } });
const retried = async (id: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND action='migration.retried' ORDER BY seq", [id])).rows.map((r) => r.detail);


import { retryBudget } from "@svc/core";

test("retryBudget 값 읽기: 없음·빈 값·글자 → 기본 3, 0 → 끔, 소수는 내림, 음수는 끔", () => {
  assert.equal(retryBudget({}), 3);
  assert.equal(retryBudget({ RETRY_BUDGET: "" }), 3);
  assert.equal(retryBudget({ RETRY_BUDGET: "abc" }), 3, "글자는 기본값 (조용히 한도를 끄지 않는다)");
  assert.equal(retryBudget({ RETRY_BUDGET: "0" }), 0);
  assert.equal(retryBudget({ RETRY_BUDGET: "2.7" }), 2);
  assert.equal(retryBudget({ RETRY_BUDGET: "-4" }), 0);
});

test("RETRY_BUDGET=1: 두 번째부터 409 / =0: 끔(여러 번 통과) / 거부된 시도는 감사·작업·상태를 안 바꾼다", { skip }, async () => {
  const id = await seed();
  process.env.RETRY_BUDGET = "1";
  try {
    await failAt(id); assert.equal((await post(id, "replan")).statusCode, 202);
    await failAt(id);
    const before = (await retried(id)).length;
    const jobsBefore = (await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE singleton_key LIKE $1", [`%:${id}`])).rows[0].n;
    const over = await post(id, "replan");
    assert.equal(over.statusCode, 409, over.body);
    assert.equal(over.json().code, "RETRY_BUDGET_EXHAUSTED");
    assert.equal((await retried(id)).length, before, "감사 안 남음");
    assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "failed");
    assert.equal((await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE singleton_key LIKE $1", [`%:${id}`])).rows[0].n, jobsBefore, "작업 안 생김");
    process.env.RETRY_BUDGET = "0";
    for (let i = 0; i < 4; i++) { await failAt(id); assert.equal((await post(id, "replan")).statusCode, 202, `끔 ${i}`); }
  } finally { delete process.env.RETRY_BUDGET; }
});

test("한도 안에서 acceptCustomerCost:true 를 보내도 고객 부담 표시는 false, 글자 'true' 는 400", { skip }, async () => {
  const id = await seed();
  await failAt(id);
  assert.equal((await post(id, "replan", { acceptCustomerCost: true })).statusCode, 202);
  assert.deepEqual((await retried(id)).map((d) => [d.attempt, d.customerCostAccepted]), [[1, false]]);
  await failAt(id);
  assert.equal((await post(id, "replan", { acceptCustomerCost: "true" })).statusCode, 400);
  assert.equal((await retried(id)).length, 1);
});

test("한도는 이전마다 따로 센다 (다른 이전의 재시도가 안 섞임)", { skip }, async () => {
  const a = await seed(), b = await seed();
  for (let i = 0; i < 3; i++) { await failAt(a); assert.equal((await post(a, "replan")).statusCode, 202); }
  await failAt(a); assert.equal((await post(a, "replan")).statusCode, 409);
  await failAt(b); assert.equal((await post(b, "replan")).statusCode, 202, "b 는 첫 시도");
});

test("동시에 두 번 재시도해도(한도 직전) 한 번만 통과하고 감사는 한 줄 늘어난다", { skip }, async () => {
  const id = await seed();
  for (let i = 0; i < 2; i++) { await failAt(id); assert.equal((await post(id, "replan")).statusCode, 202); }
  await failAt(id);
  const rs = await Promise.all([post(id, "replan"), post(id, "replan")]);
  const codes = rs.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [202, 409], rs.map((r) => r.body).join(" | "));
  assert.equal((await retried(id)).length, 3);
});

test("replan 거부 순서: importing 에서 실패한 이전은 REPLAN_NOT_ALLOWED(한도 계산 전), 재시도 감사 0", { skip }, async () => {
  const id = await seed();
  await owner.query(`UPDATE migrations SET status='failed', failed_at_status='importing', failure_code='IMPORT_FAILED' WHERE id=$1`, [id]);
  const r = await post(id, "replan");
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "REPLAN_NOT_ALLOWED");
  assert.equal((await retried(id)).length, 0);
});
