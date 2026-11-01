// DB 시험(작업 P): 워커가 일하다 죽었을 때 다른 워커가 이어받는가.
// 생존 신호는 가짜 시계로 돌린다: setInterval은 node:test mock.timers, 경과 시간(performance.now)은 덮어쓴 함수.
// 그래서 기본값(30초 연장 / 60초 스스로 멈춤 / 90초 기한)을 그대로 쓰고도 시험은 1~2초에 끝난다.
// 잠금 기한은 DB now()로 재므로, "90초가 지났다"는 lease_expires_at을 과거로 당겨서 흉내 낸다.
// 다른 시험 파일과 동시에 돌아도 서로 안 건드리게, 기한 지난 줄은 한 트랜잭션 안에서만 만든다(청소 작업이 못 봄).
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let lease: typeof import("../src/lease/index.js");
let owner: pg.Client;
const T = randomUUID(), S = randomUUID(), G = randomUUID();
const audit = { actor: "test", action: "t", target: "t", result: "ok" as const };

// 가짜 시계: performance.now()는 고정 기준 + offset (실제 시간은 안 흐른다), setInterval만 가짜로 돌린다
const realNow = performance.now.bind(performance);
const BASE = realNow();
let offset = 0;
async function advanceClock(ms: number) {
  offset += ms;
  mock.timers.tick(ms);
  await new Promise((r) => setImmediate(r));
}
const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until: timeout");
    await realSleep(10);
  }
}

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  lease = await import("../src/lease/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-p-failover')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
  performance.now = () => BASE + offset;
  mock.timers.enable({ apis: ["setInterval"] });
});
after(async () => {
  mock.timers.reset();
  performance.now = realNow;
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await lease.closeHeartbeatPool(); await core.pool.end(); await owner.end();
});

// 상태 s인 이전 하나 + 두 환경 잠금을 holder로 쥔 상태 (기한은 살아 있음)
async function setup(s: string, holder = "worker:w1") {
  const id = randomUUID();
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, S, G, s]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,$5, now() + interval '90 seconds'), ($2,$3,$4,$5, now() + interval '90 seconds')`,
    [S, G, T, id, holder]);
  return id;
}
const drop = (id: string) => owner.query("DELETE FROM env_locks WHERE migration_id=$1", [id]);
const locks = async (id: string) => (await owner.query(
  `SELECT holder, extract(epoch FROM lease_expires_at - now())::float AS left_sec
     FROM env_locks WHERE migration_id=$1 ORDER BY env_id`, [id])).rows as { holder: string; left_sec: number }[];
const status = async (id: string) => (await owner.query(
  "SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];

// 이 시험이 "90초가 지났다"를 만드는 방법: 같은 트랜잭션에서 기한을 과거로 당기고 바로 인수를 시도한다.
// 확정 전이라 다른 파일의 청소 작업은 이 줄을 기한 지남으로 보지 못한다
async function expireAndAcquire(id: string, holder: string) {
  return core.withTenant(T, async (tx) => {
    await tx.query("UPDATE env_locks SET lease_expires_at = now() - interval '1 second' WHERE migration_id=$1", [id]);
    const a = await core.acquireEnvLock(tx, { migrationId: id, envId: S, holder });
    const b = await core.acquireEnvLock(tx, { migrationId: id, envId: G, holder });
    return a && b;
  });
}

test("가짜 시계: 기본값 그대로 30초마다 연장, 기한은 늘 60초 넘게 남는다", { skip }, async () => {
  const id = await setup("provisioning");
  const hb = lease.startHeartbeat({ tenantId: T, migrationId: id, envIds: [S, G], holder: "worker:w1" });
  try {
    for (let i = 1; i <= 4; i++) {
      await advanceClock(30_000);
      await until(() => hb.beats() === i);
      const l = await locks(id);
      assert.ok(l.every((x) => x.left_sec > 85), `연장 뒤 남은 기한 ${l.map((x) => x.left_sec.toFixed(1))}`);
    }
    assert.equal(hb.signal.aborted, false, "주인이고 DB가 살아 있으면 멈추지 않는다");
  } finally { hb.stop(); await drop(id); }
});

test("이어받기: w1이 멈춘 사이 기한이 지나면 w2가 인수, w1은 다음 연장에서 NOT_OWNER", { skip }, async () => {
  const id = await setup("provisioning");
  let lost: string | null = null;
  const hb1 = lease.startHeartbeat({ tenantId: T, migrationId: id, envIds: [S, G], holder: "worker:w1",
    onLost: (r) => { lost = r; } });
  try {
    await advanceClock(30_000); await until(() => hb1.beats() === 1);

    // 기한이 살아 있으면 w2는 못 뺏는다
    const early = await core.withTenant(T, (tx) =>
      core.acquireEnvLock(tx, { migrationId: id, envId: S, holder: "worker:w2" }));
    assert.equal(early, false, "살아 있는 잠금은 인수 불가");

    // w1이 멈춤(GC·네트워크 단절) → 90초 기한 지남 → w2 인수
    assert.equal(await expireAndAcquire(id, "worker:w2"), true);
    assert.deepEqual((await locks(id)).map((x) => x.holder), ["worker:w2", "worker:w2"]);

    // w1이 깨어나 다음 연장을 시도 → 0줄 → 스스로 멈춤
    await advanceClock(30_000);
    await until(() => lost !== null);
    assert.equal(lost, "NOT_OWNER");
    assert.equal(hb1.signal.aborted, true);

    // 좀비 w1이 상태를 옮기려 해도 fence에서 막힌다. 상태는 그대로
    await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "provisioning", "deploying",
      { fence: { envId: G, holder: "worker:w1" }, evidence: { applyOk: true }, audit })), { code: "LEASE_LOST" });
    assert.equal((await status(id)).status, "provisioning");

    // 새 주인 w2는 옮길 수 있다
    await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "provisioning", "deploying",
      { fence: { envId: G, holder: "worker:w2" }, evidence: { applyOk: true }, audit }));
    assert.equal((await status(id)).status, "deploying");
  } finally { hb1.stop(); await drop(id); }
});

test("DB 단절: 연장이 매달려 있어도 마지막 성공 60초 뒤(감시 주기 5초 안)에 DB_UNREACHABLE", { skip }, async () => {
  const id = await setup("provisioning");
  let lost: string | null = null, lostAtFake = -1;
  const hb = lease.startHeartbeat({ tenantId: T, migrationId: id, envIds: [S, G], holder: "worker:w1",
    onLost: (r) => { lost = r; lostAtFake = offset; } });
  const blocker = new pg.Client({ connectionString: OWNER }); await blocker.connect();
  try {
    const base = offset;                         // 마지막 성공 = 시작 시각
    // 잠금 줄을 다른 연결이 쥐고 놓지 않음 → 연장 UPDATE가 매달린다 (DB가 응답 없는 상황 흉내)
    await blocker.query("BEGIN");
    await blocker.query("SELECT * FROM env_locks WHERE migration_id=$1 FOR UPDATE", [id]);
    await advanceClock(30_000);                  // 1번째 연장 시작 → 매달림
    await advanceClock(30_000);                  // 60초: 아직 "넘지" 않음
    await realSleep(30);
    assert.equal(lost, null, "60초 정각에는 아직 안 멈춘다 (> 비교)");
    await advanceClock(5_000);                   // 65초: 감시 주기 한 번
    await until(() => lost !== null);
    assert.equal(lost, "DB_UNREACHABLE");
    const fencedAfter = lostAtFake - base;
    assert.ok(fencedAfter > 60_000 && fencedAfter <= 65_000, `self-fence at +${fencedAfter}ms`);
    // 90초 기한보다 먼저 멈춘다 = 다른 워커가 인수하기 전에 이 워커는 이미 손을 뗐다 (여유 25~30초)
    assert.ok(90_000 - fencedAfter >= 25_000);
  } finally {
    await blocker.query("ROLLBACK"); await blocker.end();
    hb.stop(); await realSleep(100); await drop(id);
  }
});

// 【발견 P-1】 스스로 멈춘 뒤에도 매달려 있던 연장이 풀리면 그대로 COMMIT된다.
// 결과: 이미 일을 멈춘 워커 이름으로 잠금이 90초 더 늘어나, 그동안 다른 워커가 인수하지 못하고 청소 작업도 못 본다.
// 기대: 멈춘(aborted) 뒤 끝난 연장은 ROLLBACK (또는 연장 UPDATE에 statement_timeout보다 짧은 lock_timeout)
test("【P-1 재현】 스스로 멈춘 뒤 늦게 끝난 연장은 잠금을 늘리지 않아야 한다", { skip }, async () => {
  const id = await setup("provisioning");
  let lost: string | null = null;
  const hb = lease.startHeartbeat({ tenantId: T, migrationId: id, envIds: [S, G], holder: "worker:w1",
    onLost: (r) => { lost = r; } });
  const blocker = new pg.Client({ connectionString: OWNER }); await blocker.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("UPDATE env_locks SET lease_expires_at = now() + interval '20 seconds' WHERE migration_id=$1", [id]);
    await advanceClock(30_000);                  // 연장 시작 → blocker 때문에 매달림
    await advanceClock(35_000);                  // 65초 → 스스로 멈춤
    await until(() => lost !== null);
    await blocker.query("COMMIT");               // DB가 돌아옴: 남은 기한 20초
    await realSleep(300);                        // 매달렸던 연장이 끝날 시간
    const left = (await locks(id)).map((x) => x.left_sec);
    assert.ok(left.every((s) => s < 30), `멈춘 워커가 기한을 늘렸다: 남은 초 ${left.map((s) => s.toFixed(1))}`);
  } finally { await blocker.end().catch(() => undefined); hb.stop(); await drop(id); }
});

test("청소가 먼저 오면: 기한 지난 워커 잠금 → failed(WORKER_LOST), 잠금은 풀리고, 늦은 w2 작업은 재확인에서 멈춘다", { skip }, async () => {
  const id = await setup("provisioning", "worker:w9");
  // reapOnce()는 모든 회사를 훑어 다른 시험 파일의 줄까지 건드리므로, 같은 판단 함수 + 같은 advance 호출로 이 이전만 처리한다
  const act = lease.decideReap({ holder: "worker:w9", status: "provisioning" });
  assert.deepEqual(act, { kind: "fail", to: "failed", code: "WORKER_LOST" });
  const moved = await core.withTenant(T, async (tx) => {
    await tx.query("UPDATE env_locks SET lease_expires_at = now() - interval '1 second' WHERE migration_id=$1", [id]);
    return core.advance(tx, { id, tenantId: T }, "provisioning", "failed",
      { mode: "ifStill", failureCode: "WORKER_LOST", audit });
  });
  assert.equal(moved, true);
  assert.deepEqual(await status(id), { status: "failed", failure_code: "WORKER_LOST" });
  // Z1 DRAFT(ai): provisioning 실패는 잠금을 푼다 → 늦게 온 w2는 인수할 줄 자체가 없다 (예전 O-2: 인수는 됐음)
  const w2 = await core.withTenant(T, (tx) => core.acquireEnvLock(tx, { migrationId: id, envId: S, holder: "worker:w2" }));
  assert.equal(w2, false, "잠금이 풀려 인수 불가. 상태도 failed라 runStep 재확인에서 일을 시작하지 않는다");
  // 늦게 도착한 같은 단계 작업: ifStill이라 아무것도 안 바뀐다
  const late = await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "provisioning", "deploying",
    { mode: "ifStill", evidence: { applyOk: true }, audit }));
  assert.equal(late, false);
  await drop(id);
});

test("같은 순간 두 워커가 인수 시도 → 정확히 하나만 성공", { skip }, async () => {
  const id = await setup("provisioning", "worker:w0");
  const tries = 5;
  for (let i = 0; i < tries; i++) {
    await owner.query("UPDATE env_locks SET holder='worker:w0', lease_expires_at = now() + interval '90 seconds' WHERE migration_id=$1", [id]);
    const attempt = (h: string) => core.withTenant(T, async (tx) => {
      await tx.query("UPDATE env_locks SET lease_expires_at = now() - interval '1 second' WHERE migration_id=$1 AND holder='worker:w0'", [id]);
      return core.acquireEnvLock(tx, { migrationId: id, envId: S, holder: h });
    });
    const r = await Promise.all([attempt("worker:a"), attempt("worker:b")]);
    assert.equal(r.filter(Boolean).length, 1, `round ${i}: ${JSON.stringify(r)}`);
  }
  await drop(id);
});
