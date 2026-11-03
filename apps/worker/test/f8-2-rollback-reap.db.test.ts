// F8-2: 롤백 중 워커가 죽으면(잠금 기한 지남) 바로 failed 가 아니라 롤백 작업을 한 번 더 넣는다. 횟수는 ROLLBACK_MAX_ATTEMPTS 로 같이 센다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
let core: typeof import("@svc/core");
let reaper: typeof import("../src/lease/reaper.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  reaper = await import("../src/lease/reaper.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-f8-2')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM pgboss.job WHERE data->>'tenantId' = $1", [T]);
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

/** 롤백하던 워커가 잠금을 쥔 채 죽은 모습 (기한 1초 지남) */
async function seed(priorFailures = 0) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, updated_at) VALUES ($1,$2,$3,$4,'rolling_back', now() - interval '1 minute')`,
    [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'worker:dead', now() - interval '1 second'), ($2,$3,$4,'worker:dead', now() - interval '1 second')`, [src, dst, T, id]);
  for (let i = 0; i < priorFailures; i++)
    await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "rollback.attempt_failed", target: id, result: "error", detail: { attempts: i + 1 } }));
  return id;
}
const expired = async (id: string) => (await owner.query(
  `SELECT l.tenant_id AS "tenantId", l.env_id AS "envId", l.migration_id AS "migrationId", l.holder,
          l.job_id::text AS "jobId", l.job_queue AS "jobQueue", m.status
     FROM env_locks l JOIN migrations m ON m.id=l.migration_id WHERE l.migration_id=$1 LIMIT 1`, [id])).rows[0];
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const jobs = async (id: string) => (await owner.query(`SELECT state FROM pgboss.job WHERE name='rollback' AND data->>'migrationId'=$1`, [id])).rows;
const audits = async (id: string, a: string) => (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action=$2`, [id, a])).rows;

test("정상: 첫 워커 사망 → 상태 rolling_back 그대로, 시도 1번 셈, 롤백 작업 1개, 잠금은 예약으로(새 작업이 인수)", { skip }, async () => {
  const id = await seed();
  const r = await reaper.reapLock(await expired(id));
  assert.deepEqual(r.action, { kind: "retry", code: "WORKER_LOST", attempt: 1, max: 2 });
  assert.equal(r.applied, true);
  assert.deepEqual(await row(id), { status: "rolling_back", failure_code: null });
  assert.equal((await jobs(id)).length, 1);
  assert.equal((await audits(id, "rollback.attempt_failed")).length, 1);
  assert.equal((await audits(id, "rollback.requeued"))[0].detail.jobQueued, true);
  const l = await owner.query(`SELECT holder, lease_expires_at > now() AS live FROM env_locks WHERE migration_id=$1`, [id]);
  assert.ok(l.rows.length === 2 && l.rows.every((x) => x.holder === "reserved" && x.live));
});

test("거부: 이미 한 번 실패한 롤백이면(횟수 다 씀) 예전 그대로 failed(WORKER_LOST), 작업 안 넣음", { skip }, async () => {
  const id = await seed(1);
  const r = await reaper.reapLock(await expired(id));
  assert.deepEqual(r.action, { kind: "fail", to: "failed", code: "WORKER_LOST" });
  assert.deepEqual(await row(id), { status: "failed", failure_code: "WORKER_LOST" });
  assert.equal((await jobs(id)).length, 0);
});

test("순수: STEP_FAILED(처리기가 이미 셈)·다른 단계는 그대로", { skip }, () => {
  assert.deepEqual(reaper.decideReap({ holder: "reserved", status: "rolling_back", stepFailed: true }), { kind: "fail", to: "failed", code: "STEP_FAILED" });
  assert.deepEqual(reaper.decideReap({ holder: "reserved", status: "rolling_back", stepFailed: false }), { kind: "retry", code: "JOB_NOT_PICKED", attempt: 1, max: 2 });
  assert.equal(reaper.decideReap({ holder: "w", status: "shifting" }).kind, "fail");
});
