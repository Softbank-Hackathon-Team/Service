// PF FM-ORC-08: apply 뒤 단계에서 롤백으로 끝나도(rolled_back) 도착 자원 지우기 작업이 생기고, 작업은 rolled_back 에서도 지운다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let rollback: typeof import("../src/jobs/rollback.js");
let td: typeof import("../src/jobs/target-destroy.js");
let owner: pg.Client;
const T = randomUUID();
const audit = { actor: "worker", action: "t", target: "x", result: "ok" as const };

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  rollback = await import("../src/jobs/rollback.js");
  td = await import("../src/jobs/target-destroy.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-orc-08')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function setup(s: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, s]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, id]);
  return id;
}
const jobs = async (id: string) => (await owner.query(
  `SELECT count(*)::int n FROM pgboss.job WHERE name='target-destroy' AND data->>'migrationId'=$1`, [id])).rows[0].n as number;

for (const stage of ["deploying", "syncing", "shifting"]) {
  test(`PF FM-ORC-08 정상: ${stage} → rolling_back → rolled_back 이면 target-destroy 1개 + 감사 requested(trigger rolled_back)`, { skip }, async () => {
    const id = await setup(stage);
    await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, stage as never, "rolling_back",
      { audit, evidence: { reason: "x" }, failureCode: "JOB_FAILED_DEPLOY" }));
    assert.equal(await jobs(id), 0, "롤백 시작만으로는 안 넣는다(롤백 작업이 도착 자원을 아직 쓸 수 있음)");
    assert.equal(await rollback.handleRollback({ tenantId: T, requestId: "r", migrationId: id }), "advanced");
    assert.equal(await jobs(id), 1);
    const a = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='target_teardown.requested'`, [id])).rows[0].detail;
    assert.equal(a.trigger, "rolled_back");
    let called = 0;
    assert.equal(await td.handleTargetDestroy({ tenantId: T, requestId: "r", migrationId: id }, { env: { TF_WORK_DIR: "/nonexistent" }, noRoles: true,
      runner: { destroy: async () => { called++; return { ok: true, workDir: "/w", steps: [], log: [], elapsedMs: 1 }; } } as never }), "destroyed");
    assert.equal(called, 1);
  });
}

test("PF FM-ORC-08 거부: completed(도착이 새 주인)로 끝나면 지우기 작업을 안 넣고, 넣어도 skipped", { skip }, async () => {
  assert.equal(core.tearsDownTarget("cleanup", "completed"), false);
  assert.equal(core.tearsDownTarget("rolling_back", "rolled_back"), true);
  assert.equal(core.tearsDownTarget("cutover", "failed"), false, "데이터가 움직인 뒤 실패는 롤백이 먼저");
  const id = await setup("completed");
  assert.equal(await td.handleTargetDestroy({ tenantId: T, requestId: "r", migrationId: id }, { env: { TF_WORK_DIR: "/nonexistent" }, noRoles: true,
    runner: { destroy: async () => { throw new Error("불리면 안 됨"); } } as never }), "skipped");
});
