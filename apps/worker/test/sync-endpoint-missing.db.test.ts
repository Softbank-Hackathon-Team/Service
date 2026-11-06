// 진짜 판(MOCK_IAC≠1)에 명세 postgres 가 있는데 복제 끝점(줄·REPL_* env)이 없으면 sync 는 가짜 지연으로 넘어가지 않고 paused REPL_ENDPOINT_MISSING.
//   흉내 판(MOCK_IAC=1, test:db·e2e)은 예전 STUB 길 그대로
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
let core: typeof import("@svc/core");
let adapters: typeof import("@svc/adapters");
let sync: typeof import("../src/jobs/sync.js");
let owner: pg.Client;
const T = randomUUID();
const prevMock = process.env.MOCK_IAC;

before(async () => {
  if (skip) return;
  delete process.env.REPL_SOURCE_URL; delete process.env.REPL_TARGET_URL;
  core = await import("@svc/core");
  adapters = await import("@svc/adapters");
  sync = await import("../src/jobs/sync.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'sync-endpoint-missing')", [T]);
  await core.startBoss();
});
after(async () => {
  process.env.MOCK_IAC = prevMock;
  if (skip) return;
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
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}','{}',$3)`,
    [T, id, JSON.stringify({ spec: adapters.DEMO_SPEC, fieldMeta: {}, unmapped: [], ids: {} })]);
  return id;
}
const st = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const job = (id: string) => ({ tenantId: T, requestId: `r-sem-${id.slice(0, 8)}`, migrationId: id });

test("진짜 판: postgres 명세 + 끝점 없음 → paused REPL_ENDPOINT_MISSING (가짜 지연 없음)", { skip }, async () => {
  process.env.MOCK_IAC = "";
  const id = await seed();
  assert.equal(await sync.handleSync(job(id)), "advanced");
  assert.deepEqual(await st(id), { status: "paused", failure_code: "REPL_ENDPOINT_MISSING" });
  const d = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND detail ? 'error' ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.detail;
  assert.match(String(d?.error), /REPL_ENDPOINT_MISSING/);
  assert.equal(d?.stub, undefined);
});

test("흉내 판(MOCK_IAC=1): 예전 STUB 길 그대로 shifting", { skip }, async () => {
  process.env.MOCK_IAC = "1";
  const id = await seed();
  assert.equal(await sync.handleSync(job(id)), "advanced");
  assert.equal((await st(id)).status, "shifting");
});

test("끝점 없음 문 (순수): 진짜 판 + postgres 일 때만 막는다", { skip }, () => {
  assert.equal(sync.endpointMissingBlocks(true, {}), true);
  assert.equal(sync.endpointMissingBlocks(true, { MOCK_IAC: "1" }), false);
  assert.equal(sync.endpointMissingBlocks(false, {}), false);
  assert.equal(sync.endpointMissingBlocks(null, {}), false);
});
