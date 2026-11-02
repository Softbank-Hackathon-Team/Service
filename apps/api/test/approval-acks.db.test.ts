// PA4 (계획 26 · A4) DB 시험: 승인 확인 항목(acks) 게이트 + /start 지문 재확인 (깃발 PLAN_ACKS)
import { test, before, after, afterEach } from "node:test";
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
const prevFlag = process.env.PLAN_ACKS;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-acks'), ($2,'test-acks-other')", [T, OTHER]);
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
afterEach(() => { if (prevFlag === undefined) delete process.env.PLAN_ACKS; else process.env.PLAN_ACKS = prevFlag; });
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

const ACKS = [
  { id: "cost", kind: "cost", text: "예상 월 비용" },
  { id: "failure_cost_policy", kind: "failure_cost_policy", text: "실패 비용 정책" },
  { id: "runtime_change:api", kind: "runtime_change", text: "lambda → k8s", ref: "api" },
];

// 시험마다 새 환경·새 이전 + awaiting_approval 계획 하나 (워커가 하는 일 흉내)
async function seed(withAcks = true) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID(), planId = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'planning')`, [id, T, src, dst]);
  const plan = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: "tf", helmValuesHash: "helm", planHash: `hash-${planId}`,
    ...(withAcks ? { specVersion: 1, acknowledgements: ACKS,
      costSummary: { currency: "USD", monthlyTarget: 80, monthlySource: 100, deltaMonthly: -20, unknownFields: [] } } : {}),
    expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  await core.withTenant(T, async (tx) => {
    await core.savePlan(tx, T, plan as never);
    await core.advance(tx, { id, tenantId: T }, "planning", "awaiting_approval",
      { audit: { actor: "worker", action: "plan.proposed", target: id, result: "ok" } });
  });
  return { id, planId, planHash: plan.planHash };
}
const status = async (id: string) => (await owner.query(`SELECT status FROM migrations WHERE id=$1`, [id])).rows[0].status as string;
const locks = async (id: string) => (await owner.query(`SELECT 1 FROM env_locks WHERE migration_id=$1`, [id])).rowCount;
const applyJobs = async (id: string) => (await owner.query(
  `SELECT 1 FROM pgboss.job WHERE name='apply' AND data->>'migrationId'=$1`, [id])).rowCount;
const approve = (planId: string, body: Record<string, unknown>, headers: Record<string, string> = H) =>
  app.inject({ method: "POST", url: `${P}/plans/${planId}/approvals`, payload: body,
    headers: { ...headers, "idempotency-key": randomUUID() } });
const start = (id: string, body?: Record<string, unknown>, headers: Record<string, string> = H) =>
  app.inject({ method: "POST", url: `${P}/migrations/${id}/start`, ...(body ? { payload: body } : {}),
    headers: { ...headers, "idempotency-key": randomUUID() } });

test("깃발 on + acks 전부 → approved, acks 는 감사 detail 에 남는다", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  const r = await approve(m.planId, { decision: "approve", planHash: m.planHash, acks: ACKS.map((a) => a.id) });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await status(m.id), "approved");
  const a = await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='plan.approved'`, [m.id]);
  assert.deepEqual(a.rows[0].detail.acks, ACKS.map((x) => x.id));
});

test("깃발 off + acks 없음 → approved (지금 동작 그대로), /start 본문 없이 → provisioning", { skip }, async () => {
  delete process.env.PLAN_ACKS;
  const m = await seed();
  assert.equal((await approve(m.planId, { decision: "approve", planHash: m.planHash })).statusCode, 200);
  assert.equal(await status(m.id), "approved");
  const s = await start(m.id);
  assert.equal(s.statusCode, 202, s.body);
  assert.equal(await status(m.id), "provisioning");
});

test("거부: 깃발 on + acks 하나 빠짐 → 409 ACKS_MISSING(빠진 id), 상태 그대로, 잠금 예약 0", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  const r = await approve(m.planId, { decision: "approve", planHash: m.planHash, acks: ["cost", "failure_cost_policy"] });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "ACKS_MISSING");
  assert.match(r.json().message, /runtime_change:api/);
  assert.equal(await status(m.id), "awaiting_approval");
  assert.equal(await locks(m.id), 0);
});

test("깃발 on: reject 는 acks 를 안 본다 / 확인 항목 없는 옛 계획서는 acks 없이 승인", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const a = await seed();
  assert.equal((await approve(a.planId, { decision: "reject", planHash: a.planHash })).statusCode, 200);
  assert.equal(await status(a.id), "rejected");
  const b = await seed(false);
  assert.equal((await approve(b.planId, { decision: "approve", planHash: b.planHash })).statusCode, 200);
  assert.equal(await status(b.id), "approved");
});

test("깃발 on: /start 지문이 승인 지문과 같으면 202, 다르거나 없으면 409 PLAN_HASH_MISMATCH(상태 그대로, apply 작업 0)", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  assert.equal((await approve(m.planId, { decision: "approve", planHash: m.planHash, acks: ACKS.map((a) => a.id) })).statusCode, 200);
  for (const body of [{ planHash: "other" }, undefined]) {
    const bad = await start(m.id, body);
    assert.equal(bad.statusCode, 409, bad.body);
    assert.equal(bad.json().code, "PLAN_HASH_MISMATCH");
    assert.equal(await status(m.id), "approved");
    assert.equal(await applyJobs(m.id), 0);
  }
  const ok = await start(m.id, { planHash: m.planHash });
  assert.equal(ok.statusCode, 202, ok.body);
  assert.equal(await status(m.id), "provisioning");
  assert.equal(await applyJobs(m.id), 1);
});

test("거부: 남의 회사 계획 승인·시작 → 404", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  const other = { "x-dev-tenant": OTHER };
  assert.equal((await approve(m.planId, { decision: "approve", planHash: m.planHash, acks: ACKS.map((a) => a.id) }, other)).statusCode, 404);
  assert.equal((await start(m.id, { planHash: m.planHash }, other)).statusCode, 404);
  assert.equal(await status(m.id), "awaiting_approval");
});

// SMOKEFIX: smoke·화면은 본문 없는 POST 에 "{}" 를 싣는다. 깃발 off 면 202, on 이면 409 (400 아님)
test("SMOKEFIX: 깃발 off + 본문 {} → 202 provisioning (smoke 와 같은 모양)", { skip }, async () => {
  delete process.env.PLAN_ACKS;
  const m = await seed();
  assert.equal((await approve(m.planId, { decision: "approve", planHash: m.planHash })).statusCode, 200);
  const s = await start(m.id, {});
  assert.equal(s.statusCode, 202, s.body);
  assert.equal(await status(m.id), "provisioning");
});

test("SMOKEFIX 거부: 깃발 on + 본문 {} → 409 PLAN_HASH_MISMATCH(planHash required), 상태 그대로 / 모르는 칸은 400", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  assert.equal((await approve(m.planId, { decision: "approve", planHash: m.planHash, acks: ACKS.map((a) => a.id) })).statusCode, 200);
  const bad = await start(m.id, {});
  assert.equal(bad.statusCode, 409, bad.body);
  assert.equal(bad.json().code, "PLAN_HASH_MISMATCH");
  assert.match(bad.json().message, /planHash required/);
  assert.equal(await status(m.id), "approved");
  assert.equal((await start(m.id, { planHash: m.planHash, extra: 1 })).statusCode, 400);
  delete process.env.PLAN_ACKS;
});

// DEMOFLAGS: smoke 본문(smokePlanBodies)이 서버 깃발 on·off 둘 다에서 끝까지 통과하고, acks 가 빠지면 on 에서만 409
test("DEMOFLAGS: smoke 본문 → 깃발 on 에서 approved → provisioning, off 에서도 똑같이 통과", { skip }, async () => {
  const { smokePlanBodies } = await import("../../../tools/smoke-env.js");
  for (const flag of ["1", undefined] as const) {
    if (flag) process.env.PLAN_ACKS = flag; else delete process.env.PLAN_ACKS;
    const m = await seed();
    const b = smokePlanBodies({ planHash: m.planHash, acknowledgements: ACKS });
    assert.equal((await approve(m.planId, b.approve)).statusCode, 200, `flag=${flag}`);
    const s = await start(m.id, b.start);
    assert.equal(s.statusCode, 202, `flag=${flag} ${s.body}`);
    assert.equal(await status(m.id), "provisioning");
  }
});

test("DEMOFLAGS 거부: 깃발 on 에서 smoke 본문의 acks 를 떼면 409 ACKS_MISSING (제어 사례: 그대로면 200)", { skip }, async () => {
  const { smokePlanBodies } = await import("../../../tools/smoke-env.js");
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  const b = smokePlanBodies({ planHash: m.planHash, acknowledgements: ACKS });
  const { acks: _drop, ...noAcks } = b.approve as Record<string, unknown>;
  const r = await approve(m.planId, noAcks);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "ACKS_MISSING");
  assert.equal((await approve(m.planId, b.approve)).statusCode, 200);
});
