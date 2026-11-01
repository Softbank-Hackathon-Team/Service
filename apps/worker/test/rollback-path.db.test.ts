// DB 시험(작업 P): 컷오버 중·뒤 실패 → 되돌림·롤백 상태 전이.
// 상태 표(VALID) + 전이 조건(guard) + 잠금 해제 규칙이 같이 맞물리는지 본다. 롤백 처리기는 실제 runStep으로 부른다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let rollback: typeof import("../src/jobs/rollback.js");
let cleanup: typeof import("../src/jobs/cleanup.js");
let owner: pg.Client;
const T = randomUUID(), S = randomUUID(), G = randomUUID();
const audit = { actor: "test", action: "t", target: "t", result: "ok" as const };

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "0";
  core = await import("@svc/core");
  rollback = await import("../src/jobs/rollback.js");
  cleanup = await import("../src/jobs/cleanup.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-p-rollback')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
});
let bossStarted = false;
after(async () => {
  if (skip) return;
  if (bossStarted) await core.boss.stop({ graceful: false });
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.pool.end(); await owner.end();
});

// 상태 s, 두 환경을 'reserved'로 쥔 이전 (실행 중 잠금 모양). 환경은 이전마다 새로 만든다(잠금 충돌 방지)
async function setup(s: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, s]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`,
    [src, dst, T, id]);
  return id;
}
const row = async (id: string) => (await owner.query(
  `SELECT status, failure_code, failed_at_status, rollback_window_ends_at IS NOT NULL AS has_window
     FROM migrations WHERE id=$1`, [id])).rows[0];
const lockCount = async (id: string) => (await owner.query(
  "SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [id])).rows[0].n as number;
const mv = (id: string, from: string, to: string, o: Partial<import("@svc/core").AdvanceOpts> = {}) =>
  core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T },
    from as never, to as never, { audit, ...o }));
const job = (id: string) => ({ tenantId: T, requestId: `r-${id.slice(0, 8)}`, migrationId: id });

test("컷오버 중단 → 되돌림(cutover→shifting): revertOk 없으면 거부, 있으면 shifting + 실패 사유 남김", { skip }, async () => {
  const id = await setup("cutover");
  await assert.rejects(mv(id, "cutover", "shifting", { evidence: { revertOk: false } }), { code: "GUARD_FAILED" });
  assert.equal((await row(id)).status, "cutover");
  await mv(id, "cutover", "shifting", { evidence: { revertOk: true }, failureCode: "CUTOVER_LAG_TIMEOUT" });
  const r = await row(id);
  assert.equal(r.status, "shifting");
  assert.equal(r.failure_code, "CUTOVER_LAG_TIMEOUT", "되돌림 이유는 shifting에서도 보인다");
  assert.equal(await lockCount(id), 2, "되돌림은 이전이 계속되므로 잠금 유지");
});

test("되돌린 뒤 롤백: shifting → rolling_back → (롤백 처리기) → rolled_back, 잠금 해제", { skip }, async () => {
  const id = await setup("shifting");
  await mv(id, "shifting", "rolling_back", { evidence: { reason: "error rate" } });
  assert.equal(await rollback.handleRollback(job(id)), "advanced");
  const r = await row(id);
  assert.equal(r.status, "rolled_back");
  assert.equal(await lockCount(id), 0, "끝 상태로 가면 잠금이 풀린다");
  // 같은 롤백 작업이 두 번 와도 아무것도 안 한다 (받는 쪽 멱등)
  assert.equal(await rollback.handleRollback(job(id)), "skipped");
});

test("컷오버 단계 실패 → failed(cutover): 다시 계획 불가, 잠금 유지, 수동 정리 확인 뒤에만 취소", { skip }, async () => {
  const id = await setup("cutover");
  await mv(id, "cutover", "failed", { failureCode: "CUTOVER_C3_ROWCOUNT" });
  const r = await row(id);
  assert.equal(r.status, "failed"); assert.equal(r.failed_at_status, "cutover");
  assert.equal(r.failure_code, "CUTOVER_C3_ROWCOUNT");
  assert.equal(await lockCount(id), 2, "실패는 잠금을 남긴다 (반쯤 바뀐 환경을 사람이 본다)");
  await assert.rejects(mv(id, "failed", "planning"), { code: "GUARD_FAILED" }, "컷오버 뒤 실패는 다시 계획 불가");
  await assert.rejects(mv(id, "failed", "cancelled"), { code: "GUARD_FAILED" });
  await mv(id, "failed", "cancelled", { evidence: { manualCleanupConfirmed: true } });
  assert.equal(await lockCount(id), 0);
});

test("롤백 가능 창 안에서 롤백 → rolled_back, 창 끝에 깨어난 cleanup 작업은 아무것도 안 함", { skip }, async () => {
  const id = await setup("cutover");
  await mv(id, "cutover", "rollback_window", { evidence: { cutoverStepsOk: true }, rollbackWindowSec: 120 });
  assert.equal((await row(id)).has_window, true);
  await mv(id, "rollback_window", "rolling_back", { evidence: { reason: "customer asked" } });
  assert.equal((await row(id)).has_window, false, "롤백 중에는 창 시각을 지운다");
  assert.equal(await rollback.handleRollback(job(id)), "advanced");
  assert.equal((await row(id)).status, "rolled_back");
  // 컷오버 때 startAfter로 미리 넣어 둔 cleanup 작업이 나중에 깨어난 상황
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  assert.equal((await row(id)).status, "rolled_back", "롤백된 이전을 정리하지 않는다");
  const rej = (await owner.query(
    "SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='job.rejected'", [id])).rows[0].n;
  assert.ok(rej >= 1, "멈춘 작업은 job.rejected로 감사에 남는다");
});

test("롤백 확인 실패: 출발이 아프면 rolled_back 거부, rolling_back → failed는 잠금 유지", { skip }, async () => {
  const id = await setup("rolling_back");
  await assert.rejects(mv(id, "rolling_back", "rolled_back",
    { evidence: { sourceWeight100: true, sourceHealthy: false } }), { code: "GUARD_FAILED" });
  await assert.rejects(mv(id, "rolling_back", "rolled_back",
    { evidence: { sourceWeight100: false, sourceHealthy: true } }), { code: "GUARD_FAILED" });
  assert.equal((await row(id)).status, "rolling_back");
  await mv(id, "rolling_back", "failed", { failureCode: "ROLLBACK_SOURCE_UNHEALTHY" });
  assert.equal((await row(id)).failed_at_status, "rolling_back");
  assert.equal(await lockCount(id), 2);
});

test("길 없는 이동은 조건 이전에 막힌다: 컷오버 중 일시정지, 정리 중 롤백, 완료 뒤 롤백", { skip }, async () => {
  const a = await setup("cutover");
  await assert.rejects(mv(a, "cutover", "paused", { evidence: { guardrailRule: "MG-3-01" } }),
    { code: "INVALID_TRANSITION" }, "컷오버 중에는 멈추지 않는다 (C6' 되돌림만)");
  await assert.rejects(mv(a, "cutover", "rolling_back"), { code: "INVALID_TRANSITION" });
  const b = await setup("cleanup");
  await assert.rejects(mv(b, "cleanup", "rolling_back"), { code: "INVALID_TRANSITION" },
    "정리를 시작하면 롤백을 포기한 것");
  const c = await setup("completed");
  await assert.rejects(mv(c, "completed", "rolling_back"), { code: "INVALID_TRANSITION" });
});

test("상태가 이미 바뀐 뒤 늦게 온 롤백 요청: strict는 409, ifStill은 false", { skip }, async () => {
  const id = await setup("rollback_window");
  await mv(id, "rollback_window", "rolling_back");
  await assert.rejects(mv(id, "rollback_window", "rolling_back"), { code: "INVALID_TRANSITION" });
  assert.equal(await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T },
    "rollback_window", "rolling_back", { mode: "ifStill", audit })), false);
});

// 【발견 P-4】 롤백 가능 창이 이미 끝났어도(rollback_window_ends_at <= now) rollback_window → rolling_back이 허용된다.
// 창 마감은 cleanup으로 가는 조건(T26)에만 쓰인다. 창이 끝난 뒤 정리 작업이 늦게 돌면 그 사이 롤백이 열려 있다.
// 기대가 "창이 끝나면 롤백 불가"인지 "cleanup 시작 전까지는 허용"인지는 사람이 정한다 → todo로만 남긴다
test("【P-4 재현】 롤백 가능 창이 끝난 뒤 롤백 시도는 막혀야 하나?", { skip }, async () => {
  const id = await setup("rollback_window");
  await owner.query("UPDATE migrations SET rollback_window_ends_at = now() - interval '1 second' WHERE id=$1", [id]);
  await assert.rejects(mv(id, "rollback_window", "rolling_back"), { code: "GUARD_FAILED" });
});

test("L8: 창이 끝나기 전에 깬 cleanup 작업은 남은 시간 뒤로 자신을 다시 넣는다 (같은 키라 한 번만)", { skip }, async () => {
  await core.startBoss(); bossStarted = true;
  const id = await setup("cutover");
  await mv(id, "cutover", "rollback_window", { evidence: { cutoverStepsOk: true }, rollbackWindowSec: 120 });
  const queued = async () => (await owner.query(
    `SELECT count(*)::int n, min(extract(epoch FROM start_after - now()))::int s FROM pgboss.job
      WHERE name = 'cleanup' AND singleton_key = $1 AND state = 'created'`, [`cleanup:${id}`])).rows[0];
  const before = (await queued()).n;
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  assert.equal((await row(id)).status, "rollback_window", "창 안이라 아무것도 안 바뀜");
  const q1 = await queued();
  assert.equal(q1.n, before + 1, "다시 넣음");
  assert.ok(q1.s >= 110 && q1.s <= 122, `창 끝 무렵에 깨어남 (남은 ${q1.s}s)`);
  // 한 번 더 일찍 깨도 대기 중인 같은 키 작업이 있으니 쌓이지 않는다
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  assert.equal((await queued()).n, before + 1);
  // 롤백된 이전에 늦게 깬 작업은 다시 넣지 않는다 (기존 시험과 같은 길)
  await mv(id, "rollback_window", "rolling_back", { evidence: { reason: "test" } });
  assert.equal(await rollback.handleRollback(job(id)), "advanced");
  await owner.query(`DELETE FROM pgboss.job WHERE name='cleanup' AND singleton_key=$1`, [`cleanup:${id}`]);
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  assert.equal((await queued()).n, 0);
});
