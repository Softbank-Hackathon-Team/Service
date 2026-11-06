// DB 시험: 진짜 판(MOCK_IAC·MOCK_TRAFFIC 꺼짐)에서 PROM_URL·TRAFFIC_PROVIDER 가 없으면 shift 는 가짜로 돌지 않고
// 가중치·LB 주인 자리를 건드리기 전에 paused(TRAFFIC_NOT_CONFIGURED) 로 멈춘다. MOCK_TRAFFIC=1 이면 예전처럼 흉내로 돈다.
// 고치기 전: 가짜 정상 지표 + mock 전환기로 cutover 까지 갔다. DATABASE_URL·OWNER_DATABASE_URL 이 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { MockCall } from "@svc/traffic";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let lease: typeof import("../src/lease/index.js");
let shift: typeof import("../src/jobs/shift.js");
let platform: typeof import("../src/platform.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  for (const k of ["MOCK_IAC", "MOCK_TRAFFIC", "TRAFFIC_PROVIDER", "TRAFFIC_LB_ID", "TRAFFIC_STUB_SCENARIO"]) delete process.env[k];
  process.env.PROM_URL = "";
  process.env.STUB_DELAY_MS = "0";
  process.env.TRAFFIC_TICK_MS = "1";
  process.env.TRAFFIC_OBSERVE_SEC = "0.05";
  core = await import("@svc/core");
  lease = await import("../src/lease/index.js");
  shift = await import("../src/jobs/shift.js");
  platform = await import("../src/platform.js");
  await core.startBoss();
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-traffic-not-configured')", [T]);
});
after(async () => {
  if (skip) return;
  delete process.env.MOCK_TRAFFIC;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false });
  await lease.closeHeartbeatPool(); await core.pool.end(); await owner.end();
});

async function shifting() {
  const id = randomUUID(), s = randomUUID(), g = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, g, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'shifting')`, [id, T, s, g]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [s, g, T, id]);
  return id;
}
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const weightSets = (lbId: string) => (platform.trafficSwitcher() as unknown as { calls: MockCall[] }).calls
  .filter((c) => c.op === "set" && c.lbId === lbId).length;

test("진짜 판: PROM_URL·TRAFFIC_PROVIDER 가 없으면 가중치를 안 건드리고 paused(TRAFFIC_NOT_CONFIGURED), 빠진 이름을 남긴다", { skip }, async () => {
  const id = await shifting();
  assert.equal(await shift.handleShift({ tenantId: T, requestId: "tnc-1", migrationId: id }), "advanced");
  assert.deepEqual(await row(id), { status: "paused", failure_code: "TRAFFIC_NOT_CONFIGURED" });
  const a = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='shift.paused'`, [id])).rows[0].detail;
  assert.deepEqual(a.shift.missing, ["PROM_URL", "TRAFFIC_PROVIDER"]);
  assert.equal(weightSets(id), 0, "LB 가중치 PATCH 없음");
  assert.equal((await owner.query("SELECT count(*)::int n FROM traffic_leases WHERE migration_id=$1", [id])).rows[0].n, 0, "LB 주인 자리를 안 잡음");
});

test("MOCK_TRAFFIC=1 이면 흉내 지표·mock 전환기로 예전처럼 cutover 까지 간다 (시험·로컬)", { skip }, async () => {
  process.env.MOCK_TRAFFIC = "1";
  try {
    const id = await shifting();
    assert.equal(await shift.handleShift({ tenantId: T, requestId: "tnc-2", migrationId: id }), "advanced");
    assert.deepEqual(await row(id), { status: "cutover", failure_code: null });
    assert.ok(weightSets(id) > 0);
  } finally { delete process.env.MOCK_TRAFFIC; }
});
