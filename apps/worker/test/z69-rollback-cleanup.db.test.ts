// DB 시험(작업 Z69): 롤백 작업이 복제 객체를 걷고, 걷기가 실패해도 롤백은 rolled_back으로 끝난다(경고만).
// 진짜 복제가 필요하다: 플랫폼 DB(.env) + 출발·도착 Postgres 두 대(55432/55433). 안 떠 있으면 건너뛴다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Migration } from "@svc/replication";
import { SOURCE, TARGET, TABLES, q, reachable, resetAndSeed } from "../../../packages/replication/test/harness.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const replUp = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음"
  : !replUp ? "복제 시험 Postgres(55432/55433)가 안 떠 있음: npm run db:up -w @svc/replication" : false;

let core: typeof import("@svc/core");
let rollback: typeof import("../src/jobs/rollback.js");
let owner: pg.Client;
const T = randomUUID();
const KEYS = ["REPL_SOURCE_URL", "REPL_SOURCE_PEER_URL", "REPL_SOURCE_APP_ROLE", "REPL_SOURCE_LABEL",
  "REPL_TARGET_URL", "REPL_TARGET_PEER_URL", "REPL_TARGET_APP_ROLE", "REPL_TARGET_LABEL", "REPL_TABLES"];
const saved: Record<string, string | undefined> = {};
const used: string[] = [];

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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z69')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await q(SOURCE, "ALTER DATABASE app RESET lock_timeout").catch(() => {});
  for (const M of used) await new Migration({ key: M, source: SOURCE, target: TARGET, tables: TABLES }).teardown().catch(() => {});
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

/** 플랫폼 DB에 rolling_back 이전 한 건 + 예약 잠금 */
async function rollingBack(M: string) {
  const src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'rolling_back')`, [M, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, M]);
}
const statusOf = async (M: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [M])).rows[0].status;
const auditOf = async (M: string, action: string) =>
  (await owner.query(`SELECT result, detail FROM audit_events WHERE target=$1 AND action=$2`, [M, action])).rows;

test("Z69: 컷오버 전 롤백(정방향 복제 중) → rolled_back, 구독·슬롯·발행 0, cleanup ok", { skip }, async () => {
  await resetAndSeed(300);
  const M = randomUUID(); used.push(M);
  const repl = new Migration({ key: M, source: SOURCE, target: TARGET, tables: TABLES });
  const s = await repl.sync();
  assert.equal(s.gate.ready, true, s.gate.reasons.join());
  assert.equal(await repl.phase(), "forward");
  assert.ok((await repl.leftovers()).length >= 3, "정방향 구독·슬롯·발행이 있어야 시작");
  await rollingBack(M);
  const t0 = Date.now();
  assert.equal(await rollback.handleRollback({ tenantId: T, requestId: "r-z69-a", migrationId: M }), "advanced");
  const ms = Date.now() - t0;
  assert.equal(await statusOf(M), "rolled_back");
  assert.deepEqual(await repl.leftovers(), []);
  assert.equal(await repl.phase(), "idle");
  const a = (await auditOf(M, "rollback.rolled_back"))[0];
  assert.equal(a.detail.replication.kind, "before_cutover");
  assert.equal(a.detail.replication.cleanup, "ok");
  assert.ok(a.detail.replication.removed.some((x: string) => x.includes(":subscription:")), JSON.stringify(a.detail.replication));
  // 출발 슬롯은 DROP SUBSCRIPTION이 같이 지운다(removed엔 안 나옴). 남았는지는 leftovers=[]로 본다
  assert.deepEqual(await q(SOURCE, "SELECT slot_name FROM pg_replication_slots"), []);
  assert.equal((await auditOf(M, "rollback.cleanup_incomplete")).length, 0);
  console.log("    before_cutover rollback+cleanup ms", ms, "removed", a.detail.replication.removed.length);
});

test("Z69: 컷오버 뒤 롤백에서 걷기가 실패(출발 마커 스키마 잠김) → 그래도 rolled_back + 경고 감사, 다시 걷으면 0", { skip }, async () => {
  await resetAndSeed(300);
  const M = randomUUID(); used.push(M);
  const repl = new Migration({ key: M, source: SOURCE, target: TARGET, tables: TABLES });
  assert.equal((await repl.sync()).gate.ready, true);
  assert.equal((await repl.cutover()).ok, true);
  assert.equal(await repl.phase(), "reverse");
  await rollingBack(M);

  // 출발 DB: teardown의 DROP SCHEMA _repl 이 잠금 대기 200ms 뒤 실패하게 만든다
  await q(SOURCE, "CREATE SCHEMA IF NOT EXISTS _repl");
  await q(SOURCE, "CREATE TABLE IF NOT EXISTS _repl.z69_hold (x int)");
  await q(SOURCE, "ALTER DATABASE app SET lock_timeout = '200ms'");
  const holder = new pg.Client({ connectionString: SOURCE.adminUrl }); await holder.connect();
  await holder.query("SET lock_timeout = 0");
  await holder.query("BEGIN"); await holder.query("LOCK TABLE _repl.z69_hold IN ACCESS SHARE MODE");
  try {
    assert.equal(await rollback.handleRollback({ tenantId: T, requestId: "r-z69-b", migrationId: M }), "advanced");
  } finally {
    await holder.query("ROLLBACK"); await holder.end();
    await q(SOURCE, "ALTER DATABASE app RESET lock_timeout");
  }
  assert.equal(await statusOf(M), "rolled_back", "걷기 실패가 ROLLBACK_FAILED로 번지면 안 된다");
  const a = (await auditOf(M, "rollback.rolled_back"))[0];
  assert.equal(a.detail.replication.kind, "after_cutover");
  assert.equal(a.detail.replication.cleanup, "incomplete");
  assert.match(a.detail.replication.warning, /teardown failed: .*lock timeout/i);
  const w = await auditOf(M, "rollback.cleanup_incomplete");
  assert.equal(w.length, 1);
  assert.equal(w[0].result, "error");
  assert.equal(w[0].detail.kind, "after_cutover");
  // 원인을 치우고 다시 걷으면 찌꺼기 0 (teardown은 여러 번 불러도 안전)
  await repl.teardown();
  assert.deepEqual(await repl.leftovers(), []);
  assert.equal(await repl.phase(), "idle");
  console.log("    warning:", a.detail.replication.warning.slice(0, 120));
});
