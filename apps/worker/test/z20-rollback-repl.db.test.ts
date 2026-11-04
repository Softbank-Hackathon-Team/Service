// DB 시험(작업 Z20, M4): 컷오버 뒤 롤백이 복제 객체(슬롯·발행·구독)를 남기지 않는다.
// 진짜 복제가 필요하다: 플랫폼 DB(.env) + 출발·도착 Postgres 두 대(packages/replication 의 docker-compose.test.yml, 55432/55433).
// 두 대가 안 떠 있으면 건너뛴다 (맥에서 평소 test:db 는 건너뜀)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Migration } from "@svc/replication";
import { SOURCE, TARGET, TABLES, reachable, resetAndSeed } from "../../../packages/replication/test/harness.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const replUp = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음"
  : !replUp ? "복제 시험 Postgres(55432/55433)가 안 떠 있음: npm run db:up -w @svc/replication" : false;

let core: typeof import("@svc/core");
let rollback: typeof import("../src/jobs/rollback.js");
let owner: pg.Client;
const T = randomUUID(), M = randomUUID();
const KEYS = ["REPL_SOURCE_URL", "REPL_SOURCE_PEER_URL", "REPL_SOURCE_APP_ROLE", "REPL_SOURCE_LABEL",
  "REPL_TARGET_URL", "REPL_TARGET_PEER_URL", "REPL_TARGET_APP_ROLE", "REPL_TARGET_LABEL", "REPL_TABLES"];
const saved: Record<string, string | undefined> = {};

before(async () => {
  if (skip) return;
  for (const k of KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    REPL_SOURCE_URL: SOURCE.adminUrl, REPL_SOURCE_PEER_URL: SOURCE.peerUrl, REPL_SOURCE_APP_ROLE: "app_user", REPL_SOURCE_LABEL: "src",
    REPL_TARGET_URL: TARGET.adminUrl, REPL_TARGET_PEER_URL: TARGET.peerUrl, REPL_TARGET_APP_ROLE: "app_user", REPL_TARGET_LABEL: "dst",
    REPL_TABLES: TABLES.join(","),
  });
  core = await import("@svc/core");
  rollback = await import("../src/jobs/rollback.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z20-repl')", [T]);
  await core.startBoss();
  await resetAndSeed(500);
});
after(async () => {
  if (skip) return;
  await new Migration({ key: M, source: SOURCE, target: TARGET, tables: TABLES }).teardown().catch(() => {});
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

test("M4: 컷오버 뒤 롤백 → rolled_back 이고, 출발·도착 어디에도 이 이전의 슬롯·발행·구독이 안 남는다", { skip }, async () => {
  // 실제 복제로 컷오버까지 (출발 → 도착, 역방향 복제가 생긴 상태 = 컷오버 뒤)
  const repl = new Migration({ key: M, source: SOURCE, target: TARGET, tables: TABLES });
  const s = await repl.sync();
  assert.equal(s.gate.ready, true, s.gate.reasons.join());
  const cut = await repl.cutover();
  assert.equal(cut.ok, true);
  assert.equal(await repl.phase(), "reverse");

  // 플랫폼 DB: 롤백 중인 이전 한 건 + 예약 잠금
  const src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'rolling_back')`, [M, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, M]);

  const t0 = Date.now();
  assert.equal(await rollback.handleRollback({ tenantId: T, requestId: "r-z20-m4", migrationId: M }), "advanced");
  const ms = Date.now() - t0;
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [M])).rows[0].status, "rolled_back");
  // 복제 찌꺼기 0, 방향 idle (예전: phase forward + 출발 슬롯이 WAL을 계속 쌓음)
  assert.deepEqual(await repl.leftovers(), []);
  assert.equal(await repl.phase(), "idle");
  const a = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='rollback.rolled_back'`, [M])).rows[0];
  assert.equal(a.detail.replication.kind, "after_cutover");
  // PF-E6 (FM-TRF-19): 컷오버 뒤면 DB 를 먼저 출발로 되돌리고 그다음 트래픽 (트래픽 먼저면 사용자가 울타리 친 출발 DB 로 감)
  assert.equal(a.detail.replication.order, "db_then_traffic");
  assert.ok(a.detail.replication.removed.length > 0, JSON.stringify(a.detail.replication));
  assert.deepEqual(a.detail.replication.leftovers, []);
  console.log("    rollback(after_cutover)+teardown ms", ms, "removed", a.detail.replication.removed.length);
});

test("PF-E17: 지난 시도가 DB 를 이미 되돌리고 트래픽에서 실패했으면, 재시도도 컷오버 뒤 롤백으로 이어 간다 (activeWriter·순서)", { skip }, async () => {
  const M2 = randomUUID();
  await resetAndSeed(200);
  const repl = new Migration({ key: M2, source: SOURCE, target: TARGET, tables: TABLES });
  assert.equal((await repl.sync()).gate.ready, true);
  assert.equal((await repl.cutover()).ok, true);
  // 1번째 시도: DB 되돌리기까지 끝 (phase 가 reverse 가 아니게 됨), 그다음 트래픽에서 실패했다고 친다
  const r1 = await repl.rollback({ teardown: false });
  assert.equal(r1.kind, "after_cutover");
  assert.notEqual(await repl.phase(), "reverse");
  const src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s2','connected'), ($2,$3,'gcp','g2','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'rolling_back')`, [M2, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, M2]);
  await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "rollback.db_reverted", target: M2, result: "ok", detail: { requestId: "r-pfe17-1" } }));
  try {
    assert.equal(await rollback.handleRollback({ tenantId: T, requestId: "r-pfe17-2", migrationId: M2 }), "advanced");
    const a = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='rollback.rolled_back'`, [M2])).rows[0];
    assert.equal(a.detail.replication.kind, "after_cutover", "예전: before_cutover 로 빠져 activeWriter 를 안 되돌림");
    assert.equal(a.detail.replication.order, "db_then_traffic");
    assert.deepEqual(await repl.leftovers(), []);
  } finally { await repl.teardown().catch(() => {}); }
});

async function seedRollingBack(id: string) {
  const src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s-${id.slice(0, 4)}','connected'), ($2,$3,'gcp','g-${id.slice(0, 4)}','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'rolling_back')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, id]);
}

test("PF-E33 (RV-21): 다시 롤백(updated_at 이 바뀜)해도 db_reverted 기록을 잃지 않는다", { skip }, async () => {
  const M3 = randomUUID();
  await resetAndSeed(200);
  const repl = new Migration({ key: M3, source: SOURCE, target: TARGET, tables: TABLES });
  assert.equal((await repl.sync()).gate.ready, true);
  assert.equal((await repl.cutover()).ok, true);
  assert.equal((await repl.rollback({ teardown: false })).kind, "after_cutover");
  await seedRollingBack(M3);
  await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "rollback.db_reverted", target: M3, result: "ok", detail: { requestId: "r-pfe33-1" } }));
  // rolling_back → failed → rolling_back 처럼 updated_at 이 기록 뒤로 바뀜
  await owner.query(`UPDATE migrations SET updated_at = now() + interval '1 minute' WHERE id=$1`, [M3]);
  try {
    assert.equal(await rollback.handleRollback({ tenantId: T, requestId: "r-pfe33-2", migrationId: M3 }), "advanced");
    const a = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='rollback.rolled_back'`, [M3])).rows[0];
    assert.equal(a.detail.replication.kind, "after_cutover");
  } finally { await repl.teardown().catch(() => {}); }
});

test("PF-E32 (RV-19): 컷오버 전, 복제 주소를 못 만들어도({tf:} 빔) 트래픽은 되돌리고 rolled_back + cleanup_incomplete", { skip }, async () => {
  const M4 = randomUUID();
  await seedRollingBack(M4);
  const saved = process.env.REPL_TARGET_URL;
  process.env.REPL_TARGET_URL = "postgres://u:p@{tf:pfe32_no_key}:5432/app";
  try {
    assert.equal(await rollback.handleRollback({ tenantId: T, requestId: "r-pfe32", migrationId: M4 }), "advanced");
    assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [M4])).rows[0].status, "rolled_back");
    const w = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='rollback.cleanup_incomplete'`, [M4])).rows[0];
    assert.match(String(w?.detail?.warning), /pfe32_no_key/);
  } finally { process.env.REPL_TARGET_URL = saved; }
});

test("PF-E32 거부: 컷오버 뒤면 복제 주소 없이 트래픽을 옮기지 않고 실패(재시도)", { skip }, async () => {
  const M5 = randomUUID();
  await seedRollingBack(M5);
  await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "migration.advanced", target: M5, result: "ok", detail: { from: "cutover", to: "rollback_window" } }));
  const saved = process.env.REPL_TARGET_URL;
  process.env.REPL_TARGET_URL = "postgres://u:p@{tf:pfe32_no_key}:5432/app";
  try {
    await rollback.handleRollback({ tenantId: T, requestId: "r-pfe32b", migrationId: M5 }).catch(() => "threw");
    assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [M5])).rows[0].status, "rolling_back");
    const f = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='rollback.attempt_failed'`, [M5])).rows[0];
    assert.match(String(f?.detail?.error), /needs the replication endpoints/);
  } finally { process.env.REPL_TARGET_URL = saved; }
});
