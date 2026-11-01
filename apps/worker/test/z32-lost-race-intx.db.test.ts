// DB 시험(작업 Z32, Z83 10차 지적): 단계가 일하는 사이 다른 배달이 상태를 먼저 옮기면(advance 짐) inTx 쓰기는 남지 않는다
//  예전: inTx(계획서 저장 등)가 advance 앞에서 돌고 advance 가 false 여도 확정 → 늦은 plan 배달의 새 plans 행이 남아 승인이 409 PLAN_SUPERSEDED
//  이제: 진 트랜잭션은 통째로 취소, 잠금은 따로 반납(reserved) → 다음 작업·청소가 정상으로 이어 간다
//  이긴 경우(평소)는 예전 그대로 inTx 쓰기가 남는다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let step: typeof import("../src/jobs/_step.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  step = await import("../src/jobs/_step.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z32-lost-race')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'deploying')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, id]);
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-z32-lr-${id.slice(0, 8)}`, migrationId: id });
const marks = async (id: string) => (await owner.query(
  "SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='z32.intx_mark'", [id])).rows[0].n as number;
const def = (id: string, beatenBy: string | null) => ({
  name: "z32lr", expect: "deploying" as const,
  work: async () => {
    // 일하는 사이 다른 배달이 먼저 옮김 (owner 연결 = 다른 트랜잭션)
    if (beatenBy) await owner.query("UPDATE migrations SET status=$2, version = version + 1 WHERE id=$1", [id, beatenBy]);
    return { to: "syncing" as const, evidence: { argoHealthy: true, securityParity: true },
             inTx: (tx: import("@svc/core").Tx) => core.writeAudit(tx, T, { actor: "worker", action: "z32.intx_mark", target: id, result: "ok" }) };
  },
});

test("Z32 lost race: 다른 배달이 먼저 옮기면 inTx 쓰기는 취소되고, 잠금은 reserved 로 반납된다", { skip }, async () => {
  const id = await seed();
  const r = await step.runStep(job(id), def(id, "syncing"));
  assert.equal(r, "skipped");
  assert.equal(await marks(id), 0, "예전: 진 쪽의 inTx 쓰기(예: 새 plans 행)가 남았다");
  const l = (await owner.query("SELECT holder FROM env_locks WHERE migration_id=$1", [id])).rows.map((x) => x.holder);
  assert.deepEqual(l, ["reserved", "reserved"], "워커 이름으로 남으면 90초 뒤 청소가 WORKER_LOST");
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "syncing");
});

test("Z32 lost race: 이긴 경우(평소)는 inTx 쓰기가 남고 다음 상태로 간다", { skip }, async () => {
  const id = await seed();
  assert.equal(await step.runStep(job(id), def(id, null)), "advanced");
  assert.equal(await marks(id), 1);
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "syncing");
});
