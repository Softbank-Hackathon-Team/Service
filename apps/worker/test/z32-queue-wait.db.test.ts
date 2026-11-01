// DB 시험(작업 Z32, 맥 int5-4 kill 실측 paused 8): 반납(reserved) 기한이 지났어도 다음 단계 작업이 큐에서 줄 서 있으면 JOB_NOT_PICKED 로 멈추지 않는다
//  ① shift 작업이 created 로 대기 중 → 청소는 건너뛰고(step_job_waiting) 예약 기한만 10분 연장, 상태 shifting 그대로
//  ② 대기 작업이 없으면 예전 그대로 paused(JOB_NOT_PICKED)
//  ③ 대기 작업이 QUEUE_WAIT_MAX_SEC(1시간)보다 오래됐으면(워커가 없음) paused(JOB_NOT_PICKED)
//  ④ 다른 이전의 작업은 세지 않는다
//  ⑤ shift 큐만 워커당 동시 5건 (Z62 #38), 나머지 1건
// 작업은 startAfter 로 미래에 넣어 같은 DB 의 다른 시험 워커가 집어 가지 않게 한다
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z32-qwait')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM pgboss.job WHERE data->>'tenantId' = $1", [T]);
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

// 반납 직후 모습: 두 잠금 reserved, 기한 1초 지남
async function seed(status = "shifting") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, T, src, dst, status]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() - interval '1 second'), ($2,$3,$4,'reserved', now() - interval '1 second')`, [src, dst, T, id]);
  return id;
}
const queue = (q: string, id: string) =>
  core.boss.send(q, { tenantId: T, requestId: `z32-qw-${id.slice(0, 8)}`, migrationId: id }, { singletonKey: `${q}:${id}`, startAfter: 3000 });
const expired = async (id: string) => (await owner.query(
  `SELECT l.tenant_id AS "tenantId", l.env_id AS "envId", l.migration_id AS "migrationId", l.holder,
          l.job_id::text AS "jobId", l.job_queue AS "jobQueue", m.status
     FROM env_locks l JOIN migrations m ON m.id=l.migration_id WHERE l.migration_id=$1 LIMIT 1`, [id])).rows[0];
const row = async (id: string) => (await owner.query("SELECT status, failure_code, paused_from FROM migrations WHERE id=$1", [id])).rows[0];
const leftSec = async (id: string) => (await owner.query(
  "SELECT round(extract(epoch from lease_expires_at - now()))::int s FROM env_locks WHERE migration_id=$1", [id])).rows.map((r) => r.s as number);

test("Z32 큐 대기 ①: shift 작업이 줄 서 있음 → 청소가 건너뛰고 예약 기한만 10분 연장, 상태 shifting 그대로", { skip }, async () => {
  const id = await seed();
  await queue("shift", id);
  const r = await reaper.reapLock(await expired(id));
  assert.deepEqual(r.action, { kind: "skip", why: "step_job_waiting" });
  assert.equal(r.applied, false);
  assert.deepEqual(await row(id), { status: "shifting", failure_code: null, paused_from: null });
  const l = await leftSec(id);
  assert.ok(l.length === 2 && l.every((s) => s > 500), JSON.stringify(l));
  assert.equal((await reaper.reapLock(await expired(id))).lost, true, "연장했으니 다음 청소 땐 기한 안 지남");
});

test("Z32 큐 대기 ②: 줄 선 작업 없음 → 예전 그대로 paused(JOB_NOT_PICKED)", { skip }, async () => {
  const id = await seed();
  const r = await reaper.reapLock(await expired(id));
  assert.deepEqual(r.action, { kind: "fail", to: "paused", code: "JOB_NOT_PICKED" });
  assert.deepEqual(await row(id), { status: "paused", failure_code: "JOB_NOT_PICKED", paused_from: "shifting" });
});

test("Z32 큐 대기 ③: 줄 선 작업이 QUEUE_WAIT_MAX_SEC 보다 오래됨(워커 없음) → paused(JOB_NOT_PICKED)", { skip }, async () => {
  const id = await seed();
  await queue("shift", id);
  await owner.query(`UPDATE pgboss.job SET created_on = now() - make_interval(secs => $2)
                      WHERE name='shift' AND data->>'migrationId'=$1`, [id, reaper.QUEUE_WAIT_MAX_SEC + 60]);
  const r = await reaper.reapLock(await expired(id));
  assert.deepEqual(r.action, { kind: "fail", to: "paused", code: "JOB_NOT_PICKED" });
});

test("Z32 큐 대기 ④: 다른 이전의 작업만 있으면 대기로 안 친다", { skip }, async () => {
  const id = await seed(), other = await seed();
  await queue("shift", other);
  const r = await reaper.reapLock(await expired(id));
  assert.deepEqual(r.action, { kind: "fail", to: "paused", code: "JOB_NOT_PICKED" });
});

test("Z32 큐 대기 ⑤: 워커 동시 처리 수 = shift·cleanup 5, 나머지 1 (Z62 #38, 7a)", { skip }, () => {
  assert.equal(core.concurrencyOf("shift"), 5);
  assert.equal(core.concurrencyOf("cleanup"), 5);
  for (const q of ["import", "precheck", "plan", "apply", "deploy", "sync", "cutover", "rollback"])
    assert.equal(core.concurrencyOf(q), 1, q);
});
