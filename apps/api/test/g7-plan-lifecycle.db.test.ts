// G7-1·G7-2·G7-3·G7-8: 승인 대기 계획의 만료·거절·다시 계획, 환경이 바뀐 승인, 본인 승인 기록
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
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-g7')", [T]);
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

// 승인 대기 이전 하나 + 계획 하나. expiresInSec 음수 = 이미 만료
async function seed(expiresInSec: number, creator = "user:someone-else") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'awaiting_approval')`, [id, T, src, dst]);
  const planId = randomUUID();
  const plan = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: "tf", helmValuesHash: "helm", planHash: `hash-${planId}`,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString() };
  await core.withTenant(T, async (tx) => {
    await core.savePlan(tx, T, plan as never);
    // 이전을 만든 사람 (draft → importing 감사 줄의 actor)
    await core.writeAudit(tx, T, { actor: creator, action: "migration.importing", target: id, result: "ok" });
  });
  return { id, src, dst, planId, planHash: plan.planHash };
}
const st = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status as string;
const planSt = async (planId: string) => (await owner.query("SELECT status FROM plans WHERE id=$1", [planId])).rows[0].status as string;
const audit = async (id: string, action: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND action=$2 ORDER BY seq DESC LIMIT 1", [id, action])).rows[0]?.detail;
const decide = (planId: string, decision: "approve" | "reject", planHash: string) =>
  app.inject({ method: "POST", url: `${P}/plans/${planId}/approvals`, payload: { decision, planHash, acks: ["cost", "failure_cost_policy"] },
    headers: { ...H, "idempotency-key": randomUUID() } });
const post = (path: string) =>
  app.inject({ method: "POST", url: `${P}${path}`, payload: {}, headers: { ...H, "idempotency-key": randomUUID() } });

test("G7-1 거부: 만료된 계획 승인 → 409 PLAN_EXPIRED, 같은 요청에서 이전은 stale·계획은 stale (막다른 길 아님)", { skip }, async () => {
  const s = await seed(-5);
  const r = await decide(s.planId, "approve", s.planHash);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "PLAN_EXPIRED");
  assert.equal(await st(s.id), "stale");
  assert.equal(await planSt(s.planId), "stale");
  assert.equal((await audit(s.id, "migration.stale")).evidence.staleReason, "expired");
  // 그 뒤 다시 계획: stale → prechecking (G7-2: 점검부터)
  const rp = await post(`/migrations/${s.id}/replan`);
  assert.equal(rp.statusCode, 202, rp.body);
  assert.equal(await st(s.id), "prechecking");
});

test("G7-1 정상: 만료된 계획도 거절은 된다 (거절은 만료와 상관없음) → rejected", { skip }, async () => {
  const s = await seed(-5);
  const r = await decide(s.planId, "reject", s.planHash);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await st(s.id), "rejected");
});

test("G7-2 거부: spec_review·awaiting_approval 에서 replan 은 409 INVALID_TRANSITION (POST /plan 길과 섞지 않음)", { skip }, async () => {
  const s = await seed(3600);
  const r = await post(`/migrations/${s.id}/replan`);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "INVALID_TRANSITION");
  assert.equal(await st(s.id), "awaiting_approval");
});

test("G7-8 정상: 만든 사람이 승인하면 감사 detail.selfApproved=true, 다른 사람이면 false", { skip }, async () => {
  const mine = await seed(3600, "user:dev");
  assert.equal((await decide(mine.planId, "approve", mine.planHash)).statusCode, 200);
  assert.equal((await audit(mine.id, "plan.approved")).selfApproved, true);
  const other = await seed(3600, "user:someone-else");
  assert.equal((await decide(other.planId, "approve", other.planHash)).statusCode, 200);
  assert.equal((await audit(other.id, "plan.approved")).selfApproved, false);
});

test("G7-3 정상: 환경이 다른 계정으로 바뀌면 승인 대기·승인됨 이전이 stale(env_changed), 승인된 이전의 잠금도 풀림", { skip }, async () => {
  const wait = await seed(3600);
  const appr = await seed(3600);
  assert.equal((await decide(appr.planId, "approve", appr.planHash)).statusCode, 200);
  assert.equal(await st(appr.id), "approved");
  // 둘 다 각자 환경이라 한 번씩 부른다
  const moved = await core.withTenant(T, async (tx) => [
    ...(await core.staleMigrationsForEnvChange(tx, T, wait.dst, "user:dev")),
    ...(await core.staleMigrationsForEnvChange(tx, T, appr.src, "user:dev")),
  ]);
  assert.deepEqual(moved.sort(), [wait.id, appr.id].sort());
  assert.equal(await st(wait.id), "stale");
  assert.equal(await st(appr.id), "stale");
  assert.equal((await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [appr.id])).rows[0].n, 0);
  assert.equal((await audit(appr.id, "migration.stale")).evidence.staleReason, "env_changed");
});

test("G7-3 거부: 진행 중(provisioning)·끝난 이전은 환경이 바뀌어도 건드리지 않는다", { skip }, async () => {
  const s = await seed(3600);
  await owner.query("UPDATE migrations SET status='provisioning' WHERE id=$1", [s.id]);
  const moved = await core.withTenant(T, (tx) => core.staleMigrationsForEnvChange(tx, T, s.dst, "user:dev"));
  assert.deepEqual(moved, []);
  assert.equal(await st(s.id), "provisioning");
});
