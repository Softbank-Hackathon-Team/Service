// PF FM-ORC-15: 도착 자원을 만든 뒤 멈춘 이전(paused·자원 만든 뒤 failed)이 상한을 넘으면 사람 알림(감사 migration.stuck_alert) + 할 일 제안.
//   자동으로 지우지는 않는다 (Jeong 11/4 01:53Z). 같은 이전은 주기마다 한 번
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DB 없음" : false;
let core: typeof import("@svc/core");
let stuck: typeof import("../src/lease/stuck.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  stuck = await import("../src/lease/stuck.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-orc-15')", [T]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

async function seed(status: string, o: { failedAt?: string; pausedFrom?: string; ageSec: number }) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, failed_at_status, paused_from, failure_code, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'X_FAILED', now() - make_interval(secs => $8))`, [id, T, src, dst, status, o.failedAt ?? null, o.pausedFrom ?? null, o.ageSec]);
  return id;
}
const alerts = async (id: string) => (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='migration.stuck_alert'`, [id])).rows;
const ENV = { STUCK_ALERT_SEC: "3600", STUCK_ALERT_EVERY_SEC: "3600" };

test("FM-ORC-15 정상: 5시간 멈춘 paused·provisioning 실패 → 알림 1줄씩 + 제안, 다시 돌려도 주기 안이면 안 늘어남, 상태 그대로", { skip }, async () => {
  const p = await seed("paused", { pausedFrom: "syncing", ageSec: 5 * 3600 });
  const f = await seed("failed", { failedAt: "provisioning", ageSec: 5 * 3600 });
  await stuck.alertStuckOnce(ENV);
  assert.equal((await alerts(p)).length, 1);
  assert.match((await alerts(p))[0].detail.suggestion, /resume|rollback/);
  assert.match((await alerts(f))[0].detail.suggestion, /failure-decision/);
  assert.ok((await alerts(f))[0].detail.stuckSec >= 5 * 3600 - 5);
  await stuck.alertStuckOnce(ENV);
  assert.equal((await alerts(p)).length, 1, "주기 안 두 번째는 안 씀");
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [f])).rows[0].status, "failed", "자동 정리 없음");
});

test("FM-ORC-15 거부: 짧게 멈춤·자원 만들기 전 실패(planning)·끝난 이전·깃발 0 은 알림 없음", { skip }, async () => {
  const young = await seed("paused", { pausedFrom: "deploying", ageSec: 60 });
  const early = await seed("failed", { failedAt: "planning", ageSec: 9 * 3600 });
  const done = await seed("rolled_back", { ageSec: 9 * 3600 });
  await stuck.alertStuckOnce(ENV);
  for (const id of [young, early, done]) assert.equal((await alerts(id)).length, 0);
  const old = await seed("paused", { pausedFrom: "deploying", ageSec: 9 * 3600 });
  assert.equal(await stuck.alertStuckOnce({ STUCK_ALERT_SEC: "0" }), 0);
  assert.equal((await alerts(old)).length, 0);
});
