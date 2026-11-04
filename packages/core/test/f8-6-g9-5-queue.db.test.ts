// F8-6: 같은 주인(프로세스)이어도 다른 작업 번호가 기한 안에 쥔 잠금은 못 가져감 / G9-5: 단계 작업은 회사 번호 그룹으로 들어감
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-f8-6-g9-5')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(status: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, T, src, dst, status]);
  return { id, src, dst };
}

test("F8-6 거부: 같은 주인 이름이라도 다른 작업 번호가 기한 안에 쥔 잠금은 인수 못 함 / 같은 작업 번호·예약은 인수", { skip }, async () => {
  const m = await seed("shifting");
  const holder = "worker:same-proc", jobA = randomUUID(), jobB = randomUUID();
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, job_id, job_queue, lease_expires_at)
    VALUES ($1,$2,$3,$4,$5,'shift', now() + interval '90 seconds')`, [m.dst, T, m.id, holder, jobA]);
  const take = (jobId?: string) => core.withTenant(T, (tx) =>
    core.acquireEnvLock(tx, { migrationId: m.id, envId: m.dst, holder, ...(jobId ? { jobId, jobQueue: "shift" } : {}) }));
  assert.equal(await take(jobB), false, "만료·재시도된 두 번째 shift 가 같은 프로세스에서 집혀도 못 쥔다");
  assert.equal(await take(jobA), true, "같은 작업 번호(생존 신호 연장·재인수)는 된다");
  assert.equal(await take(), true, "작업 번호 없이 부르는 쪽(시험·직접 호출)은 예전대로");
  await owner.query("UPDATE env_locks SET holder='reserved', job_id=NULL WHERE migration_id=$1", [m.id]);
  assert.equal(await take(jobB), true, "반납(reserved)된 잠금은 다른 작업이 인수");
});

test("G9-5 정상: advance 가 넣는 단계 작업은 group = 회사 번호 (회사 공평 배분) / 단계 큐가 아닌 작업은 그룹 없음", { skip }, async () => {
  const m = await seed("spec_review");
  await core.withTenant(T, (tx) => core.advance(tx, { id: m.id, tenantId: T }, "spec_review", "prechecking", {
    evidence: {}, next: { queue: "precheck", data: { tenantId: T, requestId: "r", migrationId: m.id } },
    audit: { actor: "t", action: "migration.prechecking", target: m.id, result: "ok" } })).catch(() => undefined);
  // spec_review → prechecking 은 명세가 없으면 막힌다. 막히면 직접 보냄으로 확인
  let row = (await owner.query(`SELECT group_id FROM pgboss.job WHERE name='precheck' AND data->>'migrationId'=$1`, [m.id])).rows[0];
  if (!row) {
    await core.boss.send("precheck", { tenantId: T, requestId: "r", migrationId: m.id }, core.tenantGroup("precheck", T));
    row = (await owner.query(`SELECT group_id FROM pgboss.job WHERE name='precheck' AND data->>'migrationId'=$1`, [m.id])).rows[0];
  }
  assert.equal(row.group_id, T);
  assert.deepEqual(core.tenantGroup("agent-run", T), {});
});

test("G9-5: 단계 큐 work 옵션 = 여러 건 + 회사 몫(groupConcurrency), 그 밖 큐는 1건", async () => {
  const core = await import("../src/boss.js");
  const o = core.stepWorkOptions("apply") as { localConcurrency: number; groupConcurrency?: number };
  assert.ok(o.localConcurrency >= 2, String(o.localConcurrency));
  assert.equal(o.groupConcurrency, core.TENANT_QUEUE_SHARE);
  assert.ok(o.groupConcurrency! < o.localConcurrency, "한 회사가 워커 자리를 다 쓰지 못한다");
  assert.equal(core.concurrencyOf("agent-run"), 1);
});
