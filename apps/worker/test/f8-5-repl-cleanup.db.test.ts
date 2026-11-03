// F8-5: 끝난 이전의 남은 복제 객체 다시 걷기 작업 (상태는 안 바꿈)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let job: typeof import("../src/jobs/repl-cleanup.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  job = await import("../src/jobs/repl-cleanup.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-f8-5')", [T]);
});
after(async () => {
  if (skip) return;
  await core.pool.end(); await owner.end();
});

async function seed(status: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, T, src, dst, status]);
  return id;
}
const data = (id: string) => ({ tenantId: T, requestId: "r-f8-5", migrationId: id });
const lastAudit = async (id: string) => (await owner.query(
  `SELECT result, detail FROM audit_events WHERE target=$1 AND action='replication.cleanup' ORDER BY seq DESC LIMIT 1`, [id])).rows[0];
const status = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status;
function cleaner(left: string[][]) {
  let calls = 0;
  return { get calls() { return calls; },
    teardown: async () => { calls++; return { removed: ["sub_x"] }; },
    leftovers: async () => left.shift() ?? [] };
}

test("F8-5 정상: rolled_back 에서 걷기 → 남은 것 0 이면 done + 감사 ok, 상태 그대로", { skip }, async () => {
  const id = await seed("rolled_back");
  const c = cleaner([[]]);
  assert.equal(await job.handleReplCleanup(data(id), c), "done");
  assert.equal(c.calls, 1);
  const a = await lastAudit(id);
  assert.equal(a.result, "ok");
  assert.deepEqual(a.detail.removed, ["sub_x"]);
  assert.equal(await status(id), "rolled_back");
});

test("F8-5 정상: 또 남으면 incomplete + 감사 error(남은 이름), 다시 누르면 다시 걷는다", { skip }, async () => {
  const id = await seed("cancelled");
  const c = cleaner([["slot_left"], []]);
  assert.equal(await job.handleReplCleanup(data(id), c), "incomplete");
  const a = await lastAudit(id);
  assert.equal(a.result, "error");
  assert.deepEqual(a.detail.leftovers, ["slot_left"]);
  assert.equal(await job.handleReplCleanup(data(id), c), "done");
  assert.equal(c.calls, 2);
});

test("F8-5 거부: 끝나지 않은 이전(syncing·failed)은 걷지 않는다 (진행 중 복제를 지우면 안 됨)", { skip }, async () => {
  for (const s of ["syncing", "failed"]) {
    const id = await seed(s);
    const c = cleaner([[]]);
    assert.equal(await job.handleReplCleanup(data(id), c), "skipped");
    assert.equal(c.calls, 0, s);
    assert.equal((await lastAudit(id)).detail.skipped, true);
    assert.equal(await status(id), s);
  }
});

test("F8-5: 복제 설정이 없는 개발 환경은 stub (감사 ok, stub:true)", { skip }, async () => {
  const id = await seed("completed");
  assert.equal(await job.handleReplCleanup(data(id), null), "stub");
  assert.equal((await lastAudit(id)).detail.stub, true);
});
