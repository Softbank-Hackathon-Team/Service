// DB 시험(작업 Z32 z32-10, 맥 10b 승인 409): 기한 지난 남의 잠금 회수 규칙
//  쥔 이전이 잠금을 쥘 일 없는 상태(끝·낡음·승인 전)면 승인 예약이 그 줄을 회수(LOCK_RECLAIMED 정보 반환)하고 진행한다
//  쥔 이전이 실행 중(syncing 등)이면 기한이 지나도 예전처럼 409 ENV_BUSY
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("../src/index.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z32-reclaim')", [T]);
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.pool.end(); await owner.end();
});

async function seed(oldStatus: string) {
  const src = randomUUID(), dst = randomUUID(), a = randomUUID(), b = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES
    ($1,$2,$3,$4,$5), ($6,$2,$3,$4,'awaiting_approval')`, [a, T, src, dst, oldStatus, b]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'worker:dead', now() - interval '30 minutes'), ($2,$3,$4,'reserved', now() - interval '30 minutes')`,
    [src, dst, T, a]);
  return { src, dst, a, b };
}
const reserve = (s: { src: string; dst: string; b: string }) => core.withTenant(T, (tx) =>
  core.reserveEnvLocks(tx, { id: s.b, tenantId: T }, [s.src, s.dst], new Date(Date.now() + 600_000)));
const holders = async (s: { src: string; dst: string }) => (await owner.query(
  "SELECT migration_id FROM env_locks WHERE env_id = ANY($1::uuid[]) ORDER BY env_id", [[s.src, s.dst]])).rows.map((r) => r.migration_id);

test("만료 + 쥔 이전이 completed(고아 잠금) → 회수하고 새 이전이 예약", { skip }, async () => {
  const s = await seed("completed");
  const got = await reserve(s);
  assert.equal(got.length, 2);
  assert.ok(got.every((g) => g.fromMigrationId === s.a && g.fromStatus === "completed"));
  assert.deepEqual(await holders(s), [s.b, s.b]);
});

test("만료여도 쥔 이전이 syncing(실행 중) → 409 ENV_BUSY, 잠금 그대로", { skip }, async () => {
  const s = await seed("syncing");
  await assert.rejects(reserve(s), (e: { code?: string }) => e.code === "ENV_BUSY");
  assert.deepEqual(await holders(s), [s.a, s.a]);
});
