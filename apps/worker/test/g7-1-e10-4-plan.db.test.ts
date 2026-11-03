// G7-1: 계획 만료 깨우기 작업(plan-expiry) / E10-4: 계획 작업 재확인 실패가 조용히 사라지지 않음
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let expiry: typeof import("../src/jobs/plan-expiry.js");
let plan: typeof import("../src/jobs/plan.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  expiry = await import("../src/jobs/plan-expiry.js");
  plan = await import("../src/jobs/plan.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-g7-1-e10-4')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(status: string, targetConn = "connected") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g',$4)`, [src, dst, T, targetConn]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, T, src, dst, status]);
  return id;
}
async function addPlan(id: string, expiresInSec: number) {
  const planId = randomUUID();
  await core.withTenant(T, (tx) => core.savePlan(tx, T, { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 }, tfPlanHash: "tf", helmValuesHash: "helm",
    planHash: `hash-${planId}`, expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString() } as never));
  return planId;
}
const job = (id: string, planId: string) => ({ tenantId: T, requestId: `r-${id.slice(0, 8)}`, migrationId: id, planId });
const mig = async (id: string) => (await owner.query(`SELECT status, failure_code FROM migrations WHERE id=$1`, [id])).rows[0] as
  { status: string; failure_code: string | null };
const queued = async (name: string, id: string) => (await owner.query(
  `SELECT count(*)::int n FROM pgboss.job WHERE name=$1 AND data->>'migrationId'=$2 AND state IN ('created','retry')`, [name, id])).rows[0].n as number;

test("G7-1 정상: 만료된 최신 계획 → awaiting_approval → stale(expired), 계획도 stale", { skip }, async () => {
  const id = await seed("awaiting_approval");
  const planId = await addPlan(id, -1);
  assert.equal(await expiry.handlePlanExpiry(job(id, planId)), "advanced");
  assert.equal((await mig(id)).status, "stale");
  assert.equal((await owner.query("SELECT status FROM plans WHERE id=$1", [planId])).rows[0].status, "stale");
});

test("G7-1 거부: 아직 만료 전이면 상태 그대로 + 남은 시간 뒤 다시 깨어남 / 다시 계획해 최신이 아니면 아무것도 안 함", { skip }, async () => {
  const id = await seed("awaiting_approval");
  const planId = await addPlan(id, 600);
  assert.equal(await expiry.handlePlanExpiry(job(id, planId)), "skipped");
  assert.equal((await mig(id)).status, "awaiting_approval");
  assert.equal(await queued("plan-expiry", id), 1);
  const old = planId;
  await addPlan(id, -1);   // 새 계획이 최신 (옛 계획 작업이 늦게 깨어남)
  assert.equal(await expiry.handlePlanExpiry(job(id, old)), "skipped");
  assert.equal((await mig(id)).status, "awaiting_approval");
});

test("E10-4 거부: 받아들인 명세가 없으면 job.rejected 로 사라지지 않고 failed(PLAN_RECHECK_FAILED)", { skip }, async () => {
  const id = await seed("planning");
  assert.equal(await plan.handlePlan(job(id, randomUUID())), "advanced");
  assert.deepEqual(await mig(id), { status: "failed", failure_code: "PLAN_RECHECK_FAILED" });
});

test("E10-4 정상: 도착이 잠깐 unstable 이면 상태 그대로 + 30초 뒤 다시 (횟수 다 쓰면 failed)", { skip }, async () => {
  const id = await seed("planning", "unstable");
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}'::jsonb,'{}'::jsonb,$3)`,
    [T, id, { spec: { schemaVersion: "2", app: { name: "x" }, components: [], links: [] }, fieldMeta: {}, unmapped: [] }]);
  const pid = randomUUID();
  assert.equal(await plan.handlePlan(job(id, pid)), "skipped");
  assert.equal((await mig(id)).status, "planning");
  assert.equal(await queued("plan", id), 1);
  for (let i = 1; i < plan.PLAN_RECHECK_MAX - 1; i++) assert.equal(await plan.handlePlan(job(id, pid)), "skipped");
  assert.equal(await plan.handlePlan(job(id, pid)), "advanced");
  assert.deepEqual(await mig(id), { status: "failed", failure_code: "PLAN_RECHECK_FAILED" });
});
