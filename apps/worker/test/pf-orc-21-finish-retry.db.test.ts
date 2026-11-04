// PF FM-ORC-21: 바깥 일이 성공한 뒤 finish 트랜잭션의 일시 DB 오류는 다시 한다 (failed·자원 삭제로 번지지 않게)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DB 없음" : false;
let core: typeof import("@svc/core");
let step: typeof import("../src/jobs/_step.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  step = await import("../src/jobs/_step.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-orc-21')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(s: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, s]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at) VALUES
    ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, id]);
  return id;
}
const st = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const asJob = <R>(queue: string, fn: () => Promise<R>) =>
  step.jobAttempt.run({ queue, retryCount: 0, retryLimit: 1 }, () => core.withLogContext({ job_id: randomUUID(), queue } as never, fn));
const transient = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });

process.env.FINISH_RETRY_SEC = "0,0,0";
for (const c of [
  { queue: "apply", from: "provisioning", to: "deploying", evidence: { applyOk: true } },
  { queue: "cutover", from: "cutover", to: "rollback_window", evidence: { cutoverStepsOk: true } },
] as const) {
  test(`PF FM-ORC-21 정상: ${c.queue} 바깥 일 성공 뒤 finish 에서 일시 DB 오류(40P01) 한 번 → 다시 해서 ${c.to}`, { skip }, async () => {
    const id = await seed(c.from);
    let outsideDone = 0, thrown = 0;
    const def = { name: c.queue, expect: c.from,
      work: async () => { outsideDone++; return { to: c.to, evidence: c.evidence, inTx: async () => { if (thrown++ === 0) throw transient(); } }; } };
    assert.equal(await asJob(c.queue, () => step.runStep({ tenantId: T, requestId: "pf21", migrationId: id }, def as never)), "advanced");
    assert.equal(outsideDone, 1, "바깥 일은 한 번만");
    assert.equal((await st(id)).status, c.to);
  });
}

test("PF FM-ORC-21 거부: 일시 오류가 아니면(제약 위반 등) 예전처럼 다시 하지 않고 실패", { skip }, async () => {
  const id = await seed("provisioning");
  let tries = 0;
  const def = { name: "apply", expect: "provisioning",
    work: async () => ({ to: "deploying", evidence: { applyOk: true }, inTx: async () => { tries++; throw Object.assign(new Error("check violation"), { code: "23514" }); } }) };
  await assert.rejects(asJob("apply", () => step.runStep({ tenantId: T, requestId: "pf21b", migrationId: id }, def as never)));
  assert.equal(tries, 1);
  assert.equal(step.isTransientDbError(Object.assign(new Error("x"), { code: "57P01" })), true);
  assert.equal(step.isTransientDbError(new Error("Connection terminated unexpectedly")), true);
  assert.equal(step.isTransientDbError(Object.assign(new Error("x"), { code: "23505" })), false);
});
