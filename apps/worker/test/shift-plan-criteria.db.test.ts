// DB 시험: shift 는 사람이 승인한 계획의 롤백 기준(rollbackCriteria)으로 판정한다.
// 고치기 전: 계획에 5xx 20% 를 승인해도 판정은 RULE_DEFAULTS(1%) 만 봐서 도착 5xx 10% 에 되돌렸다. DATABASE_URL·OWNER_DATABASE_URL 이 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let lease: typeof import("../src/lease/index.js");
let shift: typeof import("../src/jobs/shift.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  process.env.MOCK_TRAFFIC = "1";
  process.env.TRAFFIC_STUB_SCENARIO = "err";   // 도착 5xx 10%
  process.env.PROM_URL = "";
  process.env.STUB_DELAY_MS = "0";
  process.env.TRAFFIC_TICK_MS = "1";
  process.env.TRAFFIC_OBSERVE_SEC = "0.05";
  core = await import("@svc/core");
  lease = await import("../src/lease/index.js");
  shift = await import("../src/jobs/shift.js");
  await core.startBoss();
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-shift-plan-criteria')", [T]);
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false });
  await lease.closeHeartbeatPool(); await core.pool.end(); await owner.end();
});

async function shiftingWithPlan(errorRatePct: number) {
  const id = randomUUID(), s = randomUUID(), g = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, g, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'shifting')`, [id, T, s, g]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [s, g, T, id]);
  const planId = randomUUID(), exp = new Date(Date.now() + 2 * 3600_000).toISOString();
  const doc = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct, p95Multiplier: 2, windowSec: 30 }, tfPlanHash: "tf", helmValuesHash: "hv", planHash: "hp", expiresAt: exp };
  await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
    VALUES ($1,$2,$3,$4,'hp',$5)`, [planId, T, id, JSON.stringify(doc), exp]);
  return id;
}
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];

test("승인 계획 5xx 기준 20% 면 도착 5xx 10% 에도 cutover, 1% 면 rolling_back(TRAFFIC_ERROR_RATE)", { skip }, async () => {
  const loose = await shiftingWithPlan(20);
  assert.equal(await shift.handleShift({ tenantId: T, requestId: "spc-1", migrationId: loose }), "advanced");
  assert.deepEqual(await row(loose), { status: "cutover", failure_code: null });

  const strict = await shiftingWithPlan(1);
  assert.equal(await shift.handleShift({ tenantId: T, requestId: "spc-2", migrationId: strict }), "advanced");
  assert.deepEqual(await row(strict), { status: "rolling_back", failure_code: "TRAFFIC_ERROR_RATE" });
});
