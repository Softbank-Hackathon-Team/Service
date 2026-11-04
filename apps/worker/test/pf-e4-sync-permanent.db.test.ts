// PF-E4 (FM-APP-10·11): 복제 대상 DB 가 없거나(3D000) 비밀번호가 틀리면(28P01) 재시도로 안 바뀐다 → 첫 시도에 paused SYNC_FAILED, 원문·pgCode 를 남김.
//   예전엔 5·15·45초 재시도를 다 쓰고 1분 뒤에야 paused (11/3 6차 fdac0ba5 와 같은 모양).
//   플랫폼 DB(DATABASE_URL) + 복제 출발 Postgres(IT_SOURCE_URL, 기본 localhost:55432)가 있을 때만
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const SRC = process.env.IT_SOURCE_URL ?? "postgres://postgres:postgres@localhost:55432/app";
let skip: string | false = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let sync: typeof import("../src/jobs/sync.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  const c = new pg.Client({ connectionString: SRC, connectionTimeoutMillis: 1500 });
  try { await c.connect(); } catch { skip = "복제 출발 Postgres 없음 (IT_SOURCE_URL)"; return; } finally { await c.end().catch(() => {}); }
  process.env.SYNC_RETRY_DELAYS_SEC = "600,601,602";
  core = await import("@svc/core");
  sync = await import("../src/jobs/sync.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-pfe4')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  delete process.env.REPL_SOURCE_URL; delete process.env.REPL_TARGET_URL;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'syncing')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [src, dst, T, id]);
  return id;
}
const st = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const job = (id: string) => ({ tenantId: T, requestId: `r-pfe4-${id.slice(0, 8)}`, migrationId: id });

test("PF-E4: 도착 DB 이름이 없음(3D000) → 첫 시도에 paused SYNC_FAILED, 재시도 예약 0, 원문·pgCode 감사", async (t) => {
  if (skip) return t.skip(skip);
  const u = new URL(SRC); u.pathname = "/pfe4_no_such_db";
  process.env.REPL_SOURCE_URL = SRC; process.env.REPL_TARGET_URL = u.toString();
  const id = await seed();
  assert.equal(await sync.handleSync(job(id)), "advanced");
  assert.deepEqual(await st(id), { status: "paused", failure_code: "SYNC_FAILED" });
  const tries = (await owner.query("SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='sync.retry_scheduled'", [id])).rows[0].n;
  assert.equal(tries, 0, "재시도 안 함");
  const d = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND detail ? 'pgCode' ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.detail;
  assert.equal(d?.pgCode, "3D000"); assert.equal(d?.permanent, true);
  assert.match(String(d?.error), /pfe4_no_such_db/);
});

test("PF-E4 정상 쪽: 못 닿는 주소(연결 거절, SQLSTATE 없음)는 예전처럼 재시도 예약 (일시 장애일 수 있음)", async (t) => {
  if (skip) return t.skip(skip);
  process.env.REPL_SOURCE_URL = SRC; process.env.REPL_TARGET_URL = "postgres://postgres:postgres@127.0.0.1:1/app";
  const id = await seed();
  assert.equal(await sync.handleSync(job(id)), "skipped");
  assert.equal((await st(id)).status, "syncing");
  const tries = (await owner.query("SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='sync.retry_scheduled'", [id])).rows[0].n;
  assert.equal(tries, 1);
});

test("PF-E8 (FM-APP-17): precheck 실패로 멈추면 감사에 checks(id·detail·hint)가 남는다 — 앱 계정 없음(DB-05) → REPL_*_APP_ROLE 안내", async (t) => {
  if (skip) return t.skip(skip);
  const tgt = new URL(SRC); tgt.port = "55433";
  process.env.REPL_SOURCE_URL = SRC; process.env.REPL_TARGET_URL = tgt.toString();
  process.env.REPL_SOURCE_APP_ROLE = "pfe8_no_role"; process.env.REPL_TARGET_APP_ROLE = "pfe8_no_role";
  try {
    const id = await seed();
    assert.equal(await sync.handleSync(job(id)), "advanced");
    assert.equal((await st(id)).status, "paused");
    const d = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND detail ? 'checks' ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.detail;
    const c = (d?.checks ?? []).find((x: { id: string; side: string }) => x.id === "DB-05" && x.side === "source");
    assert.ok(c, JSON.stringify(d));
    assert.match(c.hint, /REPL_SOURCE_APP_ROLE/);
  } finally { delete process.env.REPL_SOURCE_APP_ROLE; delete process.env.REPL_TARGET_APP_ROLE; }
});

test("PF-E22: {tf:} 를 못 채운 주소면 첫 시도에 paused REPL_TF_FACTS_MISSING, 재시도 0", async (t) => {
  if (skip) return t.skip(skip);
  process.env.REPL_SOURCE_URL = SRC; process.env.REPL_TARGET_URL = "postgres://u:p@{tf:pfe22_no_key}:5432/app";
  const id = await seed();
  assert.equal(await sync.handleSync(job(id)), "advanced");
  assert.deepEqual(await st(id), { status: "paused", failure_code: "REPL_TF_FACTS_MISSING" });
  const tries = (await owner.query("SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='sync.retry_scheduled'", [id])).rows[0].n;
  assert.equal(tries, 0);
});
