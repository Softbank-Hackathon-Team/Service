// Z75-04 DB 시험: 다른(죽은) 워커가 빌린 실행 역할이 장부에 살아 있을 때 cleanup 재시도는 paused 로 가지 않고,
// 그 역할이 만료될 무렵 다시 하도록 예약한 뒤, 만료 뒤에는 completed(operateRoleRevoked=true) 로 끝난다. DB 없으면 건너뛴다
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
  process.env.STUB_DELAY_MS = "0";
  core = await import("@svc/core");
  cleanup = await import("../src/jobs/cleanup.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z75-cleanup')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false });
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.pool.end(); await owner.end();
});

async function setup() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'cleanup')`,
    [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, id]);
  return { id, src };
}
// 죽은 워커가 빌려 둔 실행 역할 한 줄 (값은 그 워커 메모리에만 있었다)
async function deadWorkerRole(m: string, env: string, expiresInSec: number) {
  await owner.query(`INSERT INTO temp_credentials (credential_ref, tenant_id, migration_id, env_id, provider, purpose, stage, role_ref,
      owner, issued_at, expires_at) VALUES ($1,$2,$3,$4,'aws','operate','destroy','arn:aws:iam::000000000000:role/stub','worker:dead-z75',
      now() - interval '1 minute', now() + make_interval(secs => $5))`, [`z75-${randomUUID()}`, T, m, env, expiresInSec]);
}
const job = (id: string) => ({ tenantId: T, requestId: `r-${id.slice(0, 8)}`, migrationId: id });
const status = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const audits = async (id: string, action: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND action=$2 ORDER BY seq", [id, action])).rows.map((r) => r.detail);

test("Z75-04: 남의 실행 역할이 살아 있으면 cleanup 은 skipped + 다시 예약, 상태는 cleanup 그대로", { skip }, async () => {
  const { id, src } = await setup();
  await deadWorkerRole(id, src, 8);
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  assert.deepEqual(await status(id), { status: "cleanup", failure_code: null });
  const r = await audits(id, "cleanup.retry_scheduled");
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "OPERATE_ROLE_HELD_ELSEWHERE");
  assert.ok(r[0].delaySec >= 1 && r[0].delaySec <= 10, `만료 무렵 (${r[0].delaySec}s)`);
  const q = (await owner.query(`SELECT count(*)::int n FROM pgboss.job WHERE name='cleanup' AND singleton_key=$1 AND state='created'`,
    [`cleanup:${id}`])).rows[0].n;
  assert.equal(q, 1, "같은 키로 하나만 다시 넣음");
  // 회수 요청은 장부에 남는다 (살아 있는 워커였다면 청소가 처리)
  const led = (await owner.query("SELECT status FROM temp_credentials WHERE migration_id=$1 AND owner='worker:dead-z75'", [id]))
    .rows.map((x) => x.status);
  assert.deepEqual(led, ["revoke_requested"]);
});

test("Z75-04: 역할이 만료된 뒤 다시 하면 expired 로 닫히고 completed, operateRoleRevoked=true", { skip }, async () => {
  const { id, src } = await setup();
  await deadWorkerRole(id, src, 8);
  assert.equal(await cleanup.handleCleanup(job(id)), "skipped");
  await owner.query("UPDATE temp_credentials SET expires_at = now() - interval '1 second' WHERE migration_id=$1", [id]);
  assert.equal(await cleanup.handleCleanup(job(id)), "advanced");
  assert.equal((await status(id)).status, "completed");
  const done = await audits(id, "cleanup.completed");
  assert.equal(done.at(-1)?.evidence?.operateRoleRevoked, true);
  const led = (await owner.query("SELECT status FROM temp_credentials WHERE migration_id=$1 AND owner='worker:dead-z75'", [id])).rows;
  assert.deepEqual(led.map((x) => x.status), ["expired"]);
});

test("Z75-04: 기다림은 청소 주기 2배(기본 30초)를 넘지 않는다", { skip }, async () => {
  const { id, src } = await setup();
  await deadWorkerRole(id, src, 600);
  assert.equal(await cleanup.waitForOtherRolesSec(job(id)), 30);
  await owner.query("UPDATE temp_credentials SET expires_at = now() + interval '4 seconds' WHERE migration_id=$1", [id]);
  const s = await cleanup.waitForOtherRolesSec(job(id));
  assert.ok(s >= 4 && s <= 6, `만료 + 1초 (${s}s)`);
});
