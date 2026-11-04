// PF RV-20: 같은 LB 주인이 멈춘 이전이면 shift 가 상한 넘게 기다리지 않고 paused(TRAFFIC_LB_BUSY), 운영자 회수 뒤 다시 주인이 될 수 있다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
let core: typeof import("@svc/core");
let shift: typeof import("../src/jobs/shift.js");
let platform: typeof import("../src/platform.js");
let owner: pg.Client;
const T1 = randomUUID(), T2 = randomUUID();
const LB = `lb-pf-${randomUUID().slice(0, 8)}`;
const audit = { actor: "test", action: "t", target: "t", result: "ok" as const };

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "0";
  process.env.TRAFFIC_LB_ID = LB;
  core = await import("@svc/core");
  shift = await import("../src/jobs/shift.js");
  platform = await import("../src/platform.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'rv20-a'), ($2, 'rv20-b')", [T1, T2]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  delete process.env.TRAFFIC_LB_ID;
  await owner.query("DELETE FROM env_locks WHERE tenant_id = ANY($1::uuid[])", [[T1, T2]]);
  await owner.query("DELETE FROM traffic_leases WHERE lb_id = $1", [LB]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function setup(t: string, s: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, t]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`, [id, t, src, dst, s]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, t, id]);
  return id;
}
const take = (t: string, id: string) => core.withTenant(t, (tx) => core.takeTrafficLease(tx, LB, id));

const busyAudit = (t: string, id: string, agoSec: number) => core.withTenant(t, (tx) => core.writeAudit(tx, t, { actor: "worker", action: "shift.retry_scheduled",
  target: id, result: "error", detail: { delaySec: 30, error: "traffic LB busy (other): another migration is shifting on the same load balancer" } }))
  .then(() => owner.query(`UPDATE audit_events SET at = now() - make_interval(secs => $2) WHERE target = $1 AND action = 'shift.retry_scheduled'`, [id, agoSec]))
  .then(() => owner.query(`UPDATE migrations SET updated_at = now() - interval '2 hours' WHERE id = $1`, [id]));

test("PF RV-20 거부: 주인(A paused)이 LB 를 쥔 채 상한(여기 60초) 넘게 기다렸으면 B 는 paused TRAFFIC_LB_BUSY, 가중치 그대로", { skip }, async () => {
  process.env.TRAFFIC_LEASE_MAX_WAIT_SEC = "60";
  const a = await setup(T1, "paused");
  const b = await setup(T2, "shifting");
  await owner.query("DELETE FROM traffic_leases WHERE lb_id = $1", [LB]);
  await owner.query("INSERT INTO traffic_leases (lb_id, migration_id, tenant_id) VALUES ($1,$2,$3)", [LB, a, T1]);
  const sw = platform.trafficSwitcher();
  await sw.set(LB, { source: 0.5, target: 0.5 });
  await busyAudit(T2, b, 120);
  assert.equal(await shift.handleShift({ tenantId: T2, requestId: "rv20", migrationId: b }), "advanced");
  const m = (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [b])).rows[0];
  assert.deepEqual([m.status, m.failure_code], ["paused", "TRAFFIC_LB_BUSY"]);
  assert.deepEqual(await sw.get(LB), { source: 0.5, target: 0.5 });
  delete process.env.TRAFFIC_LEASE_MAX_WAIT_SEC;
});

test("PF RV-20 정상: 상한 안이면 예전처럼 다시 미룸(skipped), 주인을 지우면(운영자 회수) B 가 주인이 된다", { skip }, async () => {
  const a = await setup(T1, "paused");
  const b = await setup(T2, "shifting");
  await owner.query("DELETE FROM traffic_leases WHERE lb_id = $1", [LB]);
  await owner.query("INSERT INTO traffic_leases (lb_id, migration_id, tenant_id) VALUES ($1,$2,$3)", [LB, a, T1]);
  assert.equal(await shift.handleShift({ tenantId: T2, requestId: "rv20b", migrationId: b }), "skipped");
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [b])).rows[0].status, "shifting");
  await owner.query("DELETE FROM traffic_leases WHERE lb_id = $1 AND migration_id = $2", [LB, a]);   // ops:lb-release --yes 와 같은 일
  assert.equal(await take(T2, b), "mine");
});
