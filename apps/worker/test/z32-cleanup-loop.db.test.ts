// DB 시험(작업 Z32, 맥 B4 22:18Z): 롤백 창이 끝났는데 cleanup 이 잠금을 못 쥐어 건너뛰면(잠금 줄이 없음·남이 쥠)
// 예전: rescheduleUntilWindowEnds 가 "남은 0초 + 1초" 뒤로 다시 넣음 → 1.5초마다 시작→skipped 무한 반복
// 이제: 창이 끝났고 잠금 줄이 없으면 다시 넣지 않음(감사 cleanup.reschedule_stopped), 남이 쥐었으면 15초 뒤 1개. 창이 남았으면 예전처럼
// 7a: 고아 이전 치우기 = tools/ops/force-fail.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let cleanup: typeof import("../src/jobs/cleanup.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  cleanup = await import("../src/jobs/cleanup.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z32-cleanup-loop')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM pgboss.job WHERE data->>'tenantId' = $1", [T]);
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(windowSql: string, holder: string | null) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, rollback_window_ends_at)
    VALUES ($1,$2,$3,$4,'rollback_window', ${windowSql})`, [id, T, src, dst]);
  if (holder) await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,$5, now() + interval '90 seconds'), ($2,$3,$4,$5, now() + interval '90 seconds')`, [src, dst, T, id, holder]);
  return id;
}
const queued = async (id: string) => (await owner.query(
  `SELECT count(*)::int n FROM pgboss.job WHERE name='cleanup' AND data->>'migrationId'=$1 AND state IN ('created','retry')`, [id])).rows[0].n as number;
const job = (id: string) => ({ tenantId: T, requestId: `r-z32-cl-${id.slice(0, 8)}`, migrationId: id });

test("Z32 cleanup 반복: 창 끝남 + 잠금 줄 없음 → skipped, 다시 넣지 않음, 감사 reschedule_stopped", { skip }, async () => {
  const id = await seed("now() - interval '1 minute'", null);
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  assert.equal(await queued(id), 0, "예전: 1초 뒤 cleanup 다시 → 무한 반복");
  const a = await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='cleanup.reschedule_stopped'`, [id]);
  assert.equal(a.rowCount, 1);
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "rollback_window");
});

test("Z32 cleanup 반복: 창 끝남 + 남(살아 있는 워커)이 잠금을 쥠 → 15초 뒤 1개만 다시 (1초 반복 아님)", { skip }, async () => {
  const id = await seed("now() - interval '1 minute'", "worker:someone-else");
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  assert.equal(await queued(id), 1);
  const s = (await owner.query(`SELECT extract(epoch from start_after - now())::int s FROM pgboss.job
     WHERE name='cleanup' AND data->>'migrationId'=$1 AND state='created'`, [id])).rows[0].s as number;
  assert.ok(s >= cleanup.CLEANUP_LOCK_RETRY_SEC - 2 && s <= cleanup.CLEANUP_LOCK_RETRY_SEC + 1, `startAfter 남은 초: ${s}`);
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped", "같은 키가 대기 중이면 더 안 쌓임");
  assert.equal(await queued(id), 1);
});

test("Z32 8차 R8-42: 창 끝남 + 한쪽 환경 잠금 줄만 남음(reserved) → 다시 넣지 않음 (15초 반복 아님)", { skip }, async () => {
  const id = await seed("now() - interval '1 minute'", "reserved");
  await owner.query("DELETE FROM env_locks WHERE migration_id=$1 AND env_id = (SELECT target_env_id FROM migrations WHERE id=$1)", [id]);
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  assert.equal(await queued(id), 0);
  const a = await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='cleanup.reschedule_stopped'`, [id]);
  assert.equal(a.rows[0]?.detail?.reason, "window_over_no_live_lock_holder");
});

test("Z32 7a ops:force-fail: 고아 rollback_window 이전 → failed(OPERATOR_FORCE_FAILED), 대기 cleanup 삭제, 감사 force_failed", { skip }, async () => {
  const id = await seed("now() - interval '1 hour'", null);
  await core.boss.send("cleanup", job(id), { singletonKey: `cleanup:${id}`, startAfter: 3000 });
  const { execFileSync } = await import("node:child_process");
  const run = (...a: string[]) => execFileSync(process.execPath, ["--import", "tsx", "tools/ops/force-fail.ts", id, "--reason", "z32 test", ...a],
    { cwd: new URL("../../../", import.meta.url).pathname, env: process.env, encoding: "utf8" });
  const dry = JSON.parse(run().trim().split("\n").pop()!);
  assert.equal(dry.changed, false); assert.equal(dry.plan.queuedJobs, 1);
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "rollback_window", "미리 보기는 안 바꿈");
  const done = JSON.parse(run("--yes").trim().split("\n").pop()!);
  assert.equal(done.changed, true);
  assert.deepEqual((await owner.query("SELECT status, failure_code, failed_at_status FROM migrations WHERE id=$1", [id])).rows[0],
    { status: "failed", failure_code: "OPERATOR_FORCE_FAILED", failed_at_status: "rollback_window" });
  assert.equal(await queued(id), 0);
  const a = await owner.query("SELECT actor, detail FROM audit_events WHERE target=$1 AND action='migration.force_failed'", [id]);
  assert.equal(a.rowCount, 1); assert.equal(a.rows[0].detail.reason, "z32 test"); assert.match(a.rows[0].actor, /^operator:/);
  assert.throws(() => run("--yes"), "이미 끝 상태면 exit 1");
});

test("Z32 cleanup 반복: 창이 아직 남음(10분) → 예전처럼 남은 시간 뒤로 1개 다시 넣음", { skip }, async () => {
  const id = await seed("now() + interval '10 minutes'", "reserved");
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  assert.equal(await queued(id), 1);
  const s = (await owner.query(`SELECT extract(epoch from start_after - now())::int s FROM pgboss.job
     WHERE name='cleanup' AND data->>'migrationId'=$1 AND state='created'`, [id])).rows[0].s as number;
  assert.ok(s > 590 && s <= 602, `startAfter 남은 초: ${s}`);
});

test("Z38 R8-25: 창이 방금(1초 전) 끝났는데 건너뜀 → 창 검사 경합일 수 있어 1초 뒤 한 번 더 넣는다", { skip }, async () => {
  const id = await seed("now() - interval '1 second'", null);
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  assert.equal(await queued(id), 1);
});
