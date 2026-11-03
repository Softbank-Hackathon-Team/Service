// 검증 묶음 VPA1: replan·reopen 추가 시험. 실제 pg-boss 수명(가져오기→실패/완료)으로 JobNotCreated 가 안 나는지, 동시성, 활성 작업이 남은 경우
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
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-replan-v')", [T]);
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
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

// 시험마다 새 환경·새 이전 (감사 체인·잠금 시험끼리 간섭 방지)
async function seed(status: string, failedAt: string | null = null) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, failed_at_status, failure_code)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, T, src, dst, status, failedAt, failedAt ? "TF_APPLY_FAILED" : null]);
  return { id, src, dst };
}
const status = async (id: string) => (await owner.query(`SELECT status FROM migrations WHERE id=$1`, [id])).rows[0].status as string;
const planJobs = async (id: string) => (await owner.query(
  `SELECT id FROM pgboss.job WHERE name='plan' AND singleton_key=$1 AND state IN ('created','active','retry')`, [`plan:${id}`])).rows;
const audits = async (id: string) => (await owner.query(
  `SELECT action FROM audit_events WHERE target=$1 ORDER BY seq`, [id])).rows.map((r) => r.action as string);
const post = (path: string, tenantHeaders: Record<string, string> = H, key = randomUUID()) =>
  app.inject({ method: "POST", url: `${P}${path}`, payload: {}, headers: { ...tenantHeaders, "idempotency-key": key } });


async function failAgain(id: string) {
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "planning", "failed",
    { failureCode: "PLAN_FAILED", audit: { actor: "worker", action: "migration.failed", target: id, result: "error" } }));
}
const jobStates = async (id: string) => (await owner.query(
  `SELECT state FROM pgboss.job WHERE name='plan' AND singleton_key=$1 ORDER BY created_on`, [`plan:${id}`])).rows.map((r) => r.state as string);
async function fetchPlanJob(id: string) {
  // 이 이전의 plan 작업만 집는다(다른 시험 작업은 건드리지 않음)
  const r = await owner.query(`SELECT id FROM pgboss.job WHERE name='plan' AND singleton_key=$1 AND state='created'`, [`plan:${id}`]);
  const jid = r.rows[0]?.id as string | undefined;
  assert.ok(jid, "created 상태 plan 작업 없음");
  await owner.query(`UPDATE pgboss.job SET state='active', started_on=now() WHERE id=$1`, [jid]);
  return jid;
}

test("실제 수명: replan → 작업 완료 → 다시 failed → replan 은 JobNotCreated 없이 202 (작업 상태 completed,created)", { skip }, async () => {
  const { id } = await seed("failed", "provisioning");
  assert.equal((await post(`/migrations/${id}/replan`)).statusCode, 202);
  const jid = await fetchPlanJob(id);
  await core.boss.complete("plan", jid);
  await failAgain(id);
  const r = await post(`/migrations/${id}/replan`);
  assert.equal(r.statusCode, 202, r.body);
  assert.deepEqual(await jobStates(id), ["completed", "created"]);
});

test("실제 수명: boss.fail 로 실패시킨 뒤(재시도 정책 포함) replan 도 202", { skip }, async () => {
  const { id } = await seed("failed", "provisioning");
  assert.equal((await post(`/migrations/${id}/replan`)).statusCode, 202);
  const jid = await fetchPlanJob(id);
  await core.boss.fail("plan", jid, { message: "x" });
  const states = await jobStates(id);
  await failAgain(id);
  const r = await post(`/migrations/${id}/replan`);
  // 재시도 대기(retry)가 키를 쥐고 있으면 JobNotCreated → 이 시험이 그걸 잡는다
  assert.equal(r.statusCode, 202, `fail 뒤 작업 상태 ${states} / ${r.body}`);
});

test("활성 plan 작업이 남아 있는 채 failed 가 된 이전: stately 큐라 새 작업이 대기로 들어간다(202, active 1 + created 1)", { skip }, async () => {
  const { id } = await seed("failed", "provisioning");
  assert.equal((await post(`/migrations/${id}/replan`)).statusCode, 202);
  await fetchPlanJob(id);          // 작업은 active 로 남음(워커가 죽은 상황)
  await failAgain(id);
  const r = await post(`/migrations/${id}/replan`);
  assert.equal(r.statusCode, 202, r.body);
  assert.deepEqual((await jobStates(id)).sort(), ["active", "created"]);
  // 주의: 옛 active 작업이 뒤늦게 끝나면 새 planId 와 다른 계획을 쓸 수 있음 → 처리기가 planId/상태를 다시 확인해야 함(설계 확인 필요)
});

test("동시성: 서로 다른 키로 동시에 replan 두 번 → 202 한 번, 나머지 4xx, 작업 1개, replanning 감사 1줄", { skip }, async () => {
  const { id } = await seed("failed", "provisioning");
  const rs = await Promise.all([post(`/migrations/${id}/replan`), post(`/migrations/${id}/replan`)]);
  const codes = rs.map((r) => r.statusCode).sort();
  assert.equal(codes[0], 202, JSON.stringify(rs.map((r) => r.body)));
  assert.ok(codes[1]! >= 400 && codes[1]! < 500, String(codes));
  assert.equal((await planJobs(id)).length, 1);
  assert.equal((await audits(id)).filter((a) => a === "migration.replanning").length, 1);
});

test("reopen 뒤 상태 spec_review: replan 은 INVALID_TRANSITION, reopen 두 번째는 거절", { skip }, async () => {
  const { id } = await seed("rejected");
  assert.equal((await post(`/migrations/${id}/spec/reopen`)).statusCode, 202);
  assert.equal(await status(id), "spec_review");
  assert.equal((await post(`/migrations/${id}/replan`)).json().code, "INVALID_TRANSITION");
  assert.equal((await post(`/migrations/${id}/spec/reopen`)).statusCode, 409);
});

test("다른 회사 헤더로 같은 멱등 키: 남의 이전은 404 이고 우리 이전은 안 바뀐다", { skip }, async () => {
  const { id } = await seed("failed", "provisioning");
  const key = randomUUID();
  const other = { "x-dev-tenant": randomUUID() };
  const r = await post(`/migrations/${id}/replan`, other, key);
  assert.equal(r.statusCode, 404);
  assert.equal(await status(id), "failed");
  assert.equal((await planJobs(id)).length, 0);
});
