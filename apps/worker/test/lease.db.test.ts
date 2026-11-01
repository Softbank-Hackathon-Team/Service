// DB 시험: 생존 신호와 청소 작업. DATABASE_URL·OWNER_DATABASE_URL이 없으면 건너뛴다
//
// Z53(flaky 수정): 맥에서 k3d·terraform 과 같이 돌릴 때 5건 연쇄 실패(첫 실패 beats=1) 재현됨.
//   원인 1) 고정 잠(350ms) 뒤에 "연장 2번 이상"을 단정 → 부하에서 setInterval(100ms)이 밀리면 1번만 됨
//   원인 2) 단정이 실패하면 hb.stop()·cleanup()까지 못 가서 env_locks 줄이 남음
//           → 같은 환경(S, G)을 쓰는 뒤 시험 4개가 전부 23505(env_locks_pkey 중복)로 연쇄 실패
//   원인 3) "다시 돌리면 applied=0"은 DB 전체를 보는 reapOnce 기준 → 다른 시험이 남긴 잠금이 그 사이 만료되면 깨짐
// 고친 방법
//   - 고정 잠 대신 조건이 될 때까지 기다림: node:test 의 t.waitFor(조건, {interval, timeout})
//     timeout 은 "실패라고 볼 만큼 충분히 긴 값"(5초). 빠른 기계에선 예전처럼 수백 ms 안에 끝난다
//   - 정리는 t.after() 로 등록 → 단정이 실패해도 생존 신호 멈춤·잠금 삭제가 반드시 돈다
//   - 청소 시험의 두 번째 단정은 "내 이전의 상태가 그대로인가"로 좁힘
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

// 기다림 한도. 정상이면 수백 ms, 부하가 심해도 이 안에 끝나야 한다 (넘으면 진짜 고장으로 본다)
const WAIT = { interval: 20, timeout: 5_000 };

let core: typeof import("@svc/core");
let lease: typeof import("../src/lease/index.js");
let owner: pg.Client;
const T = randomUUID(), S = randomUUID(), G = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  lease = await import("../src/lease/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-lease')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false });
  await lease.closeHeartbeatPool(); await core.pool.end(); await owner.end();
});

// 이전 하나를 상태 s로 만들고 두 환경 잠금을 holder로 쥔다 (시험 준비는 표 주인 계정)
// 정리(잠금 삭제)는 t.after 로 걸어 둔다 → 이 시험이 어디서 실패해도 다음 시험이 같은 환경을 쓸 수 있다
async function setup(t: TestContext, s: string, holder: string, leaseSql: string) {
  const id = randomUUID();
  t.after(() => cleanup(id));
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, S, G, s]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,$5, ${leaseSql}), ($2,$3,$4,$5, ${leaseSql})`, [S, G, T, id, holder]);
  return id;
}
const cleanup = (id: string) => owner.query("DELETE FROM env_locks WHERE migration_id=$1", [id]);
const row = async (id: string) => (await owner.query(
  "SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];

// 표 주인 연결에서 연 트랜잭션은 시험이 실패해도 닫는다 (안 닫으면 after 의 DELETE 가 영원히 기다림)
async function inTx(t: TestContext) {
  await owner.query("BEGIN");
  let open = true;
  t.after(async () => { if (open) await owner.query("ROLLBACK"); });
  return async () => { if (open) { open = false; await owner.query("ROLLBACK"); } };
}

test("생존 신호: 연장하고, 주인이 바뀌면 NOT_OWNER로 스스로 멈춤", { skip }, async (t) => {
  const id = await setup(t, "provisioning", "worker:w1", "now() + interval '90 seconds'");
  let lost: string | null = null;
  const hb = lease.startHeartbeat({ tenantId: T, migrationId: id, envIds: [S, G], holder: "worker:w1",
    // selfFenceMs 2000 → 10000: 부하로 연장이 2초 밀리면 NOT_OWNER 대신 DB_UNREACHABLE 로 끝나는 두 번째 flaky 방지
    intervalMs: 100, selfFenceMs: 10_000, onLost: (r) => { lost = r; } });
  t.after(() => hb.stop());
  await t.waitFor(() => assert.ok(hb.beats() >= 2, `beats=${hb.beats()}`), WAIT);
  await owner.query("UPDATE env_locks SET holder='worker:w2' WHERE env_id=$1", [G]);
  await t.waitFor(() => assert.equal(lost, "NOT_OWNER"), WAIT);
  assert.equal(hb.signal.aborted, true);
});

test("생존 신호: DB에 못 닿으면 여유 시간 뒤 DB_UNREACHABLE", { skip }, async (t) => {
  const id = await setup(t, "provisioning", "worker:w1", "now() + interval '90 seconds'");
  // DB가 응답하지 않는 상황 흉내: 다른 연결이 잠금 줄을 쥐고 놓지 않아 연장 UPDATE가 멈춘다
  const rollback = await inTx(t);
  await owner.query("SELECT * FROM env_locks WHERE migration_id=$1 FOR UPDATE", [id]);
  let lost: string | null = null;
  let lostAt = 0;
  const t0 = performance.now();
  const hb = lease.startHeartbeat({ tenantId: T, migrationId: id, envIds: [S, G], holder: "worker:w1",
    intervalMs: 100, selfFenceMs: 600, onLost: (r) => { lost = r; lostAt = performance.now(); } });
  t.after(() => hb.stop());
  await t.waitFor(() => assert.equal(lost, "DB_UNREACHABLE"), WAIT);
  await rollback();
  const took = Math.round(lostAt - t0);
  console.log(`self-fence ${took} ms after start (selfFenceMs=600)`);
  // 여유 시간보다 일찍 멈추면 안 된다 (늦는 건 부하 탓일 수 있어 위 WAIT 한도로만 본다)
  assert.ok(took >= 600 - 20, `너무 일찍 멈춤: ${took}ms`);
});

test("L9: 연장 도중 연결이 끊겨도 다음 연장은 새 연결로 이어 간다 (죽은 연결을 풀에 돌려주지 않음)", { skip }, async (t) => {
  const id = await setup(t, "provisioning", "worker:w1", "now() + interval '90 seconds'");
  // 연장 UPDATE를 잠금으로 붙잡아 두고(연결이 작업 중), 그 연결을 서버에서 끊는다
  const rollback = await inTx(t);
  await owner.query("SELECT * FROM env_locks WHERE migration_id=$1 FOR UPDATE", [id]);
  let lost: string | null = null;
  // selfFenceMs 는 이 시험의 대상이 아니다(재연결이 대상). 부하에서 "끊을 연결 찾기"가 늦어져도 스스로 멈추지 않게 넉넉히
  const hb = lease.startHeartbeat({ tenantId: T, migrationId: id, envIds: [S, G], holder: "worker:w1",
    intervalMs: 100, selfFenceMs: 15_000, onLost: (r) => { lost = r; } });
  t.after(() => hb.stop());
  // pg_stat_activity는 트랜잭션 안에서 첫 조회 값이 고정되므로 끊기는 다른 연결로 한다
  const killer = new pg.Client({ connectionString: OWNER }); await killer.connect();
  t.after(() => killer.end().catch(() => {}));
  let killed = 0;
  await t.waitFor(async () => {
    const r = await killer.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'app_user' AND wait_event_type = 'Lock' AND query ILIKE '%env_locks%'`);
    killed += r.rowCount ?? 0;
    assert.ok(killed >= 1, "연장 중인 연결을 찾아 끊음");
  }, { interval: 50, timeout: WAIT.timeout });
  await rollback();
  await t.waitFor(() => assert.ok(hb.beats() >= 2, `끊긴 뒤에도 연장이 이어짐 beats=${hb.beats()}`), WAIT);
  assert.equal(lost, null);
});

test("청소: 예약 만료(approved) → stale + 잠금 해제", { skip }, async (t) => {
  const a = await setup(t, "approved", "reserved", "now() - interval '1 second'");
  const rep = await lease.reapOnce();
  assert.ok(rep.applied >= 1, JSON.stringify(rep));
  assert.equal((await row(a)).status, "stale");
  assert.equal((await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [a])).rows[0].n, 0);
});

test("청소: 워커가 쥔 채 기한 지남 → provisioning은 failed, syncing은 paused (WORKER_LOST)", { skip }, async (t) => {
  const b = await setup(t, "provisioning", "worker:w9", "now() - interval '1 second'");
  await lease.reapOnce();
  assert.deepEqual(await row(b), { status: "failed", failure_code: "WORKER_LOST" });
  assert.equal((await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [b])).rows[0].n, 0,
    "Z1 DRAFT(ai): provisioning 이하의 실패는 잠금을 푼다 (워커는 60초에 스스로 멈춰 이미 손을 뗐다)");
  await cleanup(b);
  const c = await setup(t, "syncing", "worker:w9", "now() - interval '1 second'");
  await lease.reapOnce();
  assert.deepEqual(await row(c), { status: "paused", failure_code: "WORKER_LOST" });
  // 두 번 돌려도 내 이전은 더 바뀌지 않는다 (paused는 목록에서 빠진다)
  // Z53: 예전엔 again.applied === 0 (DB 전체 기준) → 다른 시험이 남긴 만료 잠금이 있으면 깨졌다
  const audits = async () => (await owner.query(
    "SELECT count(*)::int n FROM audit_events WHERE target=$1", [c])).rows[0].n as number;
  const before2 = await audits();
  await lease.reapOnce();
  assert.deepEqual(await row(c), { status: "paused", failure_code: "WORKER_LOST" });
  assert.equal(await audits(), before2, "두 번째 청소는 내 이전에 감사 기록을 더 남기지 않는다");
});
