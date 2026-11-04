// DB 시험: 다시 계획하기(POST /migrations/:id/replan)·명세 다시 열기(POST /migrations/:id/spec/reopen)
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-replan')", [T]);
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
  `SELECT id FROM pgboss.job WHERE name='precheck' AND singleton_key=$1 AND state IN ('created','active','retry')`, [`precheck:${id}`])).rows;
const audits = async (id: string) => (await owner.query(
  `SELECT action FROM audit_events WHERE target=$1 ORDER BY seq`, [id])).rows.map((r) => r.action as string);
const post = (path: string, tenantHeaders: Record<string, string> = H, key = randomUUID()) =>
  app.inject({ method: "POST", url: `${P}${path}`, payload: {}, headers: { ...tenantHeaders, "idempotency-key": key } });

function planDoc(migrationId: string) {
  const planId = randomUUID();
  return { planId, migrationId, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: "tf", helmValuesHash: "helm", planHash: `hash-${planId}`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString() };
}

// Jeong 11/4 01:53Z (ADR-066 개정): failed 에서 다시 계획은 없앴다 → 재시도·롤백은 POST .../failure-decision
test("failed(provisioning) → replan 은 409 INVALID_TRANSITION (실패는 failure-decision 으로), 상태·작업·감사 그대로", { skip }, async () => {
  const { id } = await seed("failed", "provisioning");
  const r = await post(`/migrations/${id}/replan`);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "INVALID_TRANSITION");
  assert.equal(await status(id), "failed");
  assert.equal((await planJobs(id)).length, 0);
  assert.deepEqual(await audits(id), []);
});

test("stale → replan: prechecking + precheck 작업 1개 (실패 재시도가 아니라 retried 는 안 남는다)", { skip }, async () => {
  const { id } = await seed("stale");
  assert.equal((await post(`/migrations/${id}/replan`)).statusCode, 202);
  assert.equal(await status(id), "prechecking");
  assert.equal((await planJobs(id)).length, 1);
  assert.deepEqual(await audits(id), ["migration.replanning"]);
});

test("rejected → replan: prechecking / rejected → spec/reopen: spec_review", { skip }, async () => {
  const a = await seed("rejected");
  assert.equal((await post(`/migrations/${a.id}/replan`)).statusCode, 202);
  assert.equal(await status(a.id), "prechecking");
  const b = await seed("rejected");
  const r = await post(`/migrations/${b.id}/spec/reopen`);
  assert.equal(r.statusCode, 202);
  assert.equal(await status(b.id), "spec_review");
  assert.equal((await planJobs(b.id)).length, 0);
  assert.deepEqual(await audits(b.id), ["migration.spec_reopened"]);
});

test("replan → 새 계획 → 승인 → 환경 잠금 2줄을 다시 예약한다", { skip }, async () => {
  const { id, src, dst } = await seed("stale");
  assert.equal((await post(`/migrations/${id}/replan`)).statusCode, 202);
  // 워커가 하는 일을 흉내: 점검 통과(prechecking → planning) + 새 계획 저장 + planning → awaiting_approval
  const plan = planDoc(id);
  await core.withTenant(T, async (tx) => {
    await core.advance(tx, { id, tenantId: T }, "prechecking", "planning",
      { evidence: { precheckBlockers: 0 }, audit: { actor: "worker", action: "precheck.planning", target: id, result: "ok" } });
    await core.savePlan(tx, T, plan);
    await core.advance(tx, { id, tenantId: T }, "planning", "awaiting_approval",
      { audit: { actor: "worker", action: "plan.proposed", target: id, result: "ok" } });
  });
  const ok = await app.inject({ method: "POST", url: `${P}/plans/${plan.planId}/approvals`,
    payload: { decision: "approve", planHash: plan.planHash }, headers: { ...H, "idempotency-key": randomUUID() } });
  assert.equal(ok.statusCode, 200);
  assert.equal(await status(id), "approved");
  const locks = await owner.query(`SELECT env_id FROM env_locks WHERE migration_id=$1 ORDER BY env_id`, [id]);
  assert.deepEqual(locks.rows.map((x) => x.env_id).sort(), [src, dst].sort());
});

test("replan 뒤 점검이 실패하면 다시 replan 은 409 (실패는 failure-decision), 다시 낡음이면 replan 202", { skip }, async () => {
  const { id } = await seed("stale");
  assert.equal((await post(`/migrations/${id}/replan`)).statusCode, 202);
  // 사전 점검 작업이 실패해 다시 failed(prechecking)가 된 상황 (G7-2: 다시 계획은 점검부터)
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "prechecking", "failed",
    { failureCode: "PLAN_FAILED", audit: { actor: "worker", action: "migration.failed", target: id, result: "error" } }));
  await owner.query(`UPDATE pgboss.job SET state='failed' WHERE name='precheck' AND singleton_key=$1`, [`precheck:${id}`]);
  const r = await post(`/migrations/${id}/replan`);
  assert.equal(r.statusCode, 409);
  assert.equal(await status(id), "failed");
  assert.equal((await planJobs(id)).length, 0);
  const s2 = await seed("stale");
  assert.equal((await post(`/migrations/${s2.id}/replan`)).statusCode, 202);
  assert.equal((await planJobs(s2.id)).length, 1);
});

test("failed_at_status=importing → 409 INVALID_TRANSITION, 상태 그대로, 작업 없음", { skip }, async () => {
  const { id } = await seed("failed", "importing");
  const r = await post(`/migrations/${id}/replan`);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "INVALID_TRANSITION");
  assert.equal(await status(id), "failed");
  assert.equal((await planJobs(id)).length, 0);
});

test("failed_at_status=cutover → 409 INVALID_TRANSITION, 상태 그대로", { skip }, async () => {
  const { id } = await seed("failed", "cutover");
  const r = await post(`/migrations/${id}/replan`);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "INVALID_TRANSITION");
  assert.equal(await status(id), "failed");
  assert.equal((await planJobs(id)).length, 0);
});

test("replan 못 하는 상태(awaiting_approval) → 409 INVALID_TRANSITION / reopen 도 rejected 만", { skip }, async () => {
  const { id } = await seed("awaiting_approval");
  const r = await post(`/migrations/${id}/replan`);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "INVALID_TRANSITION");
  const s = await seed("stale");
  const o = await post(`/migrations/${s.id}/spec/reopen`);
  assert.equal(o.statusCode, 409);
  assert.equal(o.json().code, "INVALID_TRANSITION");
  assert.equal(await status(s.id), "stale");
});

test("같은 멱등 키로 두 번 → 같은 응답, plan 작업 1개, 감사 한 벌", { skip }, async () => {
  const { id } = await seed("stale");
  const key = randomUUID();
  const a = await post(`/migrations/${id}/replan`, H, key), b = await post(`/migrations/${id}/replan`, H, key);
  assert.equal(a.statusCode, 202);
  assert.equal(b.statusCode, 202);
  assert.deepEqual(b.json(), a.json());
  assert.equal((await planJobs(id)).length, 1);
  assert.deepEqual(await audits(id), ["migration.replanning"]);
});

test("다른 회사의 이전은 replan·reopen 모두 404", { skip }, async () => {
  const { id } = await seed("failed", "provisioning");
  const other = { "x-dev-tenant": randomUUID() };
  assert.equal((await post(`/migrations/${id}/replan`, other)).statusCode, 404);
  assert.equal((await post(`/migrations/${id}/spec/reopen`, other)).statusCode, 404);
  assert.equal(await status(id), "failed");
});
