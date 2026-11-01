// Z36 (Z12-4): 단계가 잠금을 인수할 때 pg-boss 작업 id·큐를 잠금 줄에 적는가, 그리고 청소가 그 작업을 실패 처리하는가.
// 진짜 워커처럼 instrument()로 감싸서 부른다 (로그 문맥에 job_id·queue가 들어가는 길). 작업은 이 파일이 직접 만든 active 작업
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const T = randomUUID();
const Q = "z36-jobid";                 // 다른 워커가 안 집는 시험 전용 큐
let core: typeof import("@svc/core");
let step: typeof import("../src/jobs/_step.js");
let reaper: typeof import("../src/lease/reaper.js");
let instr: typeof import("../src/instrument.js");
let owner: pg.Client;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  step = await import("../src/jobs/_step.js");
  reaper = await import("../src/lease/reaper.js");
  instr = await import("../src/instrument.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z36-jobid')", [T]);
  await core.startBoss();
  await core.boss.createQueue(Q, { policy: "stately", retryLimit: 0 });
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.deleteQueue(Q).catch(() => {});
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(s: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, T, src, dst, s]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, id]);
  return { id, job: { tenantId: T, requestId: "z36", migrationId: id } };
}
const lockRows = async (id: string) => (await owner.query(
  "SELECT holder, job_id::text AS job_id, job_queue FROM env_locks WHERE migration_id=$1", [id])).rows;

test("일하는 동안 잠금 줄에 job_id·job_queue가 적힌다 → 워커가 죽으면 청소가 paused(WORKER_LOST) + 그 작업 failed (예전: 15분 active)", { skip }, async () => {
  const m = await seed("deploying");
  // 진짜 active 작업 하나 (워커가 집은 상태)
  const jobId = await core.boss.send(Q, m.job);
  const [fetched] = await core.boss.fetch(Q);
  assert.equal(fetched?.id, jobId);
  let during: Awaited<ReturnType<typeof lockRows>> = [];
  // 처리기: 일하는 도중 잠금 줄을 읽고 "죽는다"(③을 안 하고 영원히 안 끝나는 대신, 잠금을 그대로 두고 예외 없이 멈춘 것처럼)
  const handler = instr.instrument(Q, async () => step.runStep(m.job, { name: "z36dep", expect: "deploying",
    work: async () => { during = await lockRows(m.id); throw new step.RetryLater(Q as never, m.job, 0); } }));
  // RetryLater는 잠금을 반납하고 다시 넣는다 → "일하는 동안" 줄만 본다
  await handler({ id: jobId!, data: m.job }).catch(() => undefined);
  assert.equal(during.length, 2);
  assert.ok(during.every((x) => x.job_id === jobId && x.job_queue === Q && x.holder === step.WORKER_HOLDER), JSON.stringify(during));

  // 죽은 모습: 잠금 = 그 워커 + 그 작업, 기한 지남
  await owner.query(`UPDATE env_locks SET holder='worker:z36-dead', job_id=$2, job_queue=$3, lease_expires_at = now() - interval '1 second'
    WHERE migration_id=$1`, [m.id, jobId, Q]);
  const l = (await owner.query(
    `SELECT l.tenant_id AS "tenantId", l.env_id AS "envId", l.migration_id AS "migrationId", l.holder,
            l.job_id::text AS "jobId", l.job_queue AS "jobQueue", m.status
       FROM env_locks l JOIN migrations m ON m.id=l.migration_id WHERE l.migration_id=$1 LIMIT 1`, [m.id])).rows[0];
  const r = await reaper.reapLock(l);
  assert.deepEqual(r.action, { kind: "fail", to: "paused", code: "WORKER_LOST" });
  assert.equal(r.jobFailed, true);
  const js = (await owner.query("SELECT state FROM pgboss.job WHERE id=$1", [jobId])).rows[0];
  assert.equal(js.state, "failed", "Z12-4 고침: 죽은 워커의 작업이 바로 failed (retryLimit 0 큐)");
  const a = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.paused'", [m.id])).rows[0];
  assert.equal(a.detail.jobId, jobId);
});

test("decideReap: reserved + 이 단계 실패 감사 있음 → STEP_FAILED, 없음 → JOB_NOT_PICKED, 워커 이름 → WORKER_LOST", () => {
  if (skip) return;
  assert.deepEqual(reaper.decideReap({ holder: "reserved", status: "deploying", stepFailed: true }), { kind: "fail", to: "paused", code: "STEP_FAILED" });
  assert.deepEqual(reaper.decideReap({ holder: "reserved", status: "deploying" }), { kind: "fail", to: "paused", code: "JOB_NOT_PICKED" });
  assert.deepEqual(reaper.decideReap({ holder: "worker:x", status: "deploying", stepFailed: true }), { kind: "fail", to: "paused", code: "WORKER_LOST" });
  assert.deepEqual(reaper.decideReap({ holder: "reserved", status: "rolling_back", stepFailed: true }), { kind: "fail", to: "failed", code: "STEP_FAILED" });
});

test("실패 횟수는 이 단계에 들어온 뒤 것만 센다 (재개하면 0부터)", { skip }, async () => {
  const m = await seed("syncing");
  await step.recordAttemptFailure(m.job, "sync", { attempts: 1, max: 2, error: "old" });
  assert.equal(await step.failedAttempts(m.job, "sync"), 1);
  // 상태 이동(= 재개) 흉내: updated_at이 감사 시각 뒤로
  await new Promise((r) => setTimeout(r, 20));
  await owner.query("UPDATE migrations SET updated_at = now() WHERE id=$1", [m.id]);
  assert.equal(await step.failedAttempts(m.job, "sync"), 0, "예전: 재개한 sync가 지난번 실패를 이어 세서 첫 실패에 바로 롤백");
});
