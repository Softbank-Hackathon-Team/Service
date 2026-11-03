// 검증 묶음 VPA5a: 재시도 한도 경계 — 한도 값, 동시 요청, 멱등, 거부 시 아무것도 안 바뀜
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
const savedBudget = process.env.RETRY_BUDGET;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vpa5a-retry')", [T]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin); await app.register(authPlugin); await app.register(idempotencyPlugin);
  await app.register(planRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (savedBudget === undefined) delete process.env.RETRY_BUDGET; else process.env.RETRY_BUDGET = savedBudget;
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed(failedAt = "provisioning") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, failed_at_status, failure_code) VALUES ($1,$2,$3,$4,'failed',$5,'APPLY_FAILED')`, [id, T, src, dst, failedAt]);
  return id;
}
const refail = async (id: string) => {
  await owner.query("DELETE FROM pgboss.job WHERE singleton_key LIKE $1", [`%:${id}`]);
  await owner.query(`UPDATE migrations SET status='failed', failed_at_status='provisioning', failure_code='APPLY_FAILED' WHERE id=$1`, [id]);
};
const replan = (id: string, body?: object, key = `v-${randomUUID()}`) => app.inject({ method: "POST", url: `${P}/migrations/${id}/replan`,
  ...(body ? { payload: body } : {}), headers: { "x-dev-tenant": T, "idempotency-key": key } });
const retried = async (id: string) => (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.retried' ORDER BY seq", [id])).rows.map((r) => r.detail);
const st = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status as string;
const jobs = async (id: string) => (await owner.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name='precheck' AND singleton_key=$1 AND state IN ('created','active','retry')", [`precheck:${id}`])).rows[0].n as number;

test("retryBudget(): 빈 값·글자·음수·소수 처리 (기본 3, 음수→0, 소수는 내림)", async () => {
  const { retryBudget } = await import("@svc/core");
  assert.equal(retryBudget({}), 3);
  assert.equal(retryBudget({ RETRY_BUDGET: "abc" }), 3);
  assert.equal(retryBudget({ RETRY_BUDGET: "-2" }), 0);
  assert.equal(retryBudget({ RETRY_BUDGET: "2.7" }), 2);
  assert.equal(retryBudget({ RETRY_BUDGET: "0" }), 0);
});

test("한도 1: 첫 재시도 통과, 두 번째는 409 — 거부되면 상태·작업·감사 그대로, 허용 후 다음에도 다시 허용이 필요", { skip }, async () => {
  process.env.RETRY_BUDGET = "1";
  const id = await seed();
  assert.equal((await replan(id)).statusCode, 202);
  await refail(id);
  const before = { retried: (await retried(id)).length, jobs: await jobs(id) };
  const r = await replan(id);
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, "RETRY_BUDGET_EXHAUSTED");
  assert.equal(await st(id), "failed");
  assert.deepEqual({ retried: (await retried(id)).length, jobs: await jobs(id) }, before);
  assert.equal((await replan(id, { acceptCustomerCost: false })).statusCode, 409);   // false 는 허용 아님
  assert.equal((await replan(id, { acceptCustomerCost: true })).statusCode, 202);
  assert.deepEqual((await retried(id)).map((d) => [d.attempt, d.customerCostAccepted]), [[1, false], [2, true]]);
  await refail(id);
  assert.equal((await replan(id)).statusCode, 409);   // 한 번 허용했다고 다음이 자동 허용은 아님
});

test("한도 0 = 끔: 5번 넘게 재시도해도 막지 않는다", { skip }, async () => {
  process.env.RETRY_BUDGET = "0";
  const id = await seed();
  for (let i = 0; i < 6; i++) { assert.equal((await replan(id)).statusCode, 202, `#${i + 1}`); await refail(id); }
  assert.equal((await retried(id)).length, 6);
  assert.ok((await retried(id)).every((d) => d.customerCostAccepted === false));
});

test("한도 안이면 acceptCustomerCost:true 를 보내도 customerCostAccepted 는 false (고객 부담 아님)", { skip }, async () => {
  process.env.RETRY_BUDGET = "3";
  const id = await seed();
  assert.equal((await replan(id, { acceptCustomerCost: true })).statusCode, 202);
  assert.equal((await retried(id))[0].customerCostAccepted, false);
});

test("본문 거부: acceptCustomerCost 가 글자 'true'·모르는 칸 → 400, 아무것도 안 바뀜", { skip }, async () => {
  process.env.RETRY_BUDGET = "3";
  const id = await seed();
  assert.equal((await replan(id, { acceptCustomerCost: "true" })).statusCode, 400);
  assert.equal((await replan(id, { surprise: 1 })).statusCode, 400);
  assert.equal(await st(id), "failed"); assert.equal((await retried(id)).length, 0);
});

test("동시 요청(다른 멱등 키 2개): 경계(한도-1번째)에서도 하나만 통과, 세는 줄은 +1 뿐", { skip }, async () => {
  process.env.RETRY_BUDGET = "2";
  const id = await seed();
  assert.equal((await replan(id)).statusCode, 202); await refail(id);          // n=1
  const [a, b] = await Promise.all([replan(id), replan(id)]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [202, 409], `${a.body} / ${b.body}`);
  assert.equal((await retried(id)).length, 2);
  assert.equal(await jobs(id), 1);
});

test("같은 멱등 키로 다시 보내면 같은 응답이고 세는 횟수는 늘지 않는다 (한도 직전)", { skip }, async () => {
  process.env.RETRY_BUDGET = "2";
  const id = await seed();
  assert.equal((await replan(id)).statusCode, 202); await refail(id);
  const key = `idem-${randomUUID()}`;
  const a = await replan(id, undefined, key), b = await replan(id, undefined, key);
  assert.equal(a.statusCode, 202); assert.equal(b.statusCode, 202);
  assert.equal((await retried(id)).length, 2);
});

test("importing 실패는 REPLAN_NOT_ALLOWED 가 먼저 — 한도를 먹지 않는다", { skip }, async () => {
  process.env.RETRY_BUDGET = "1";
  const id = await seed("importing");
  const r = await replan(id);
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, "REPLAN_NOT_ALLOWED");
  assert.equal((await retried(id)).length, 0);
});

test("stale 다시 계획은 몇 번을 해도 한도에 안 걸린다 (실패 재시도가 아님)", { skip }, async () => {
  process.env.RETRY_BUDGET = "1";
  const id = await seed();
  for (let i = 0; i < 3; i++) {
    await owner.query("DELETE FROM pgboss.job WHERE singleton_key LIKE $1", [`%:${id}`]);
    await owner.query("UPDATE migrations SET status='stale', failed_at_status=NULL, failure_code=NULL WHERE id=$1", [id]);
    assert.equal((await replan(id)).statusCode, 202, `#${i + 1}`);
  }
  assert.equal((await retried(id)).length, 0);
});
