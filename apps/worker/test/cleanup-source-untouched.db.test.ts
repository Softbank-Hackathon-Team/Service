// 정리(cleanup → completed)는 고객 출발 앱을 건드리지 않는다. 감사 기록이 "0 으로 줄였다"고 적지 않고,
// 출발 앱은 그대로 돌며 사람이 내린다고 남기는지 본다. DB 없으면 건너뛴다
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-cleanup-source')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false });
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.pool.end(); await owner.end();
});

test("정리 끝: 출발 앱을 줄였다고 적지 않고, 그대로 두었으며 사람이 내린다고 감사에 남긴다", { skip }, async () => {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'cleanup')`,
    [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, id]);

  assert.equal(await cleanup.handleCleanup({ tenantId: T, requestId: `r-${id.slice(0, 8)}`, migrationId: id }), "advanced");
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "completed");
  const [d] = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='cleanup.completed'", [id])).rows.map((r) => r.detail);
  assert.ok(d, "cleanup.completed 감사가 있어야 함");
  assert.ok(!d.removed.some((x: string) => /source app/i.test(x)), `걷은 목록에 출발 앱이 없어야 함: ${JSON.stringify(d.removed)}`);
  assert.deepEqual(d.sourceApp, { touched: false, decommission: "human" });
});
