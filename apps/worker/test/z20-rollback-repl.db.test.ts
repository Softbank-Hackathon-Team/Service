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
  assert.ok(a.detail.replication.removed.length > 0, JSON.stringify(a.detail.replication));
  assert.deepEqual(a.detail.replication.leftovers, []);
  console.log("    rollback(after_cutover)+teardown ms", ms, "removed", a.detail.replication.removed.length);
});
