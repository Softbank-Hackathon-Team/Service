// Z10 리뷰 L6·L7 DB 시험
//   L6: 상태 CHECK가 목록 밖 상태를 막는다. CHECK 자체는 Z9의 0011_integrity_indexes.sql이 넣는다(같은 제약 이름).
//       0011 전 DB(int3)에서는 이 시험만 건너뛴다
//   L7: 계획 만료를 DB 시계(now())로 본다 (planExpired)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("../src/index.js");
let owner: pg.Client;
const T = randomUUID(), S = randomUUID(), G = randomUUID(), M = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z23')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'draft')`, [M, T, S, G]);
});
after(async () => {
  if (skip) return;
  await core.pool.end(); await owner.end();
});

const rejects = (sql: string, args: unknown[]) =>
  assert.rejects(owner.query(sql, args), (e: { code?: string }) => e.code === "23514");   // check_violation

test("L6: 목록 밖 상태는 DB가 거부 (migrations.status·paused_from·failed_at_status, environments.connection_status)", { skip }, async (t) => {
  const has = (await owner.query(`SELECT count(*)::int n FROM pg_constraint WHERE conname = ANY($1)`,
    [["migrations_status_check", "migrations_paused_from_check", "migrations_failed_at_status_check", "environments_connection_status_check"]])).rows[0].n;
  if (has < 4) { t.skip("상태 CHECK 없음 (Z9 0011 반영 전)"); return; }
  await rejects("UPDATE migrations SET status='shiftng' WHERE id=$1", [M]);
  await rejects("UPDATE migrations SET paused_from='nope' WHERE id=$1", [M]);
  await rejects("UPDATE migrations SET failed_at_status='nope' WHERE id=$1", [M]);
  await rejects("UPDATE environments SET connection_status='ok' WHERE id=$1", [S]);
  // 목록 안 값·NULL은 그대로 된다
  await owner.query("UPDATE migrations SET paused_from='syncing', failed_at_status=NULL WHERE id=$1", [M]);
  await owner.query("UPDATE environments SET connection_status='unstable' WHERE id=$1", [S]);
});

test("L7: planExpired는 DB 시계 기준 (지난 계획 true, 남은 계획 false, 없는 계획 null)", { skip }, async () => {
  const ins = async (expiresSql: string) => (await owner.query(
    `INSERT INTO plans (tenant_id, migration_id, plan_doc, plan_hash, expires_at)
     VALUES ($1,$2,'{}','h', ${expiresSql}) RETURNING id`, [T, M])).rows[0].id as string;
  const past = await ins("now() - interval '1 second'"), future = await ins("now() + interval '1 hour'");
  assert.equal(await core.withTenant(T, (tx) => core.planExpired(tx, past)), true);
  assert.equal(await core.withTenant(T, (tx) => core.planExpired(tx, future)), false);
  assert.equal(await core.withTenant(T, (tx) => core.planExpired(tx, randomUUID())), null);
  // 다른 회사로는 안 보인다(RLS) → null (= 만료로 취급되어 승인·apply가 막힌다)
  assert.equal(await core.withTenant(randomUUID(), (tx) => core.planExpired(tx, future)), null);
});
