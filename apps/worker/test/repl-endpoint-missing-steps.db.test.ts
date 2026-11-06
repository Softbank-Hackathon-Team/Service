// 진짜 판(MOCK_IAC≠1)에 명세 postgres 가 있는데 복제 끝점(줄·REPL_* env)이 없으면 cutover·cleanup·rollback 도 STUB(가짜 성공)으로 넘어가지 않는다 (sync 와 같은 REPL_ENDPOINT_MISSING).
//   postgres 없는 명세와 흉내 판(MOCK_IAC=1)은 예전 STUB 길 그대로
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
let core: typeof import("@svc/core");
let adapters: typeof import("@svc/adapters");
let cutover: typeof import("../src/jobs/cutover.js");
let cleanup: typeof import("../src/jobs/cleanup.js");
let rollback: typeof import("../src/jobs/rollback.js");
let replCleanup: typeof import("../src/jobs/repl-cleanup.js");
let owner: pg.Client;
const T = randomUUID();
const prevMock = process.env.MOCK_IAC;

before(async () => {
  if (skip) return;
  delete process.env.REPL_SOURCE_URL; delete process.env.REPL_TARGET_URL;
  core = await import("@svc/core");
  adapters = await import("@svc/adapters");
  cutover = await import("../src/jobs/cutover.js");
  cleanup = await import("../src/jobs/cleanup.js");
  rollback = await import("../src/jobs/rollback.js");
  replCleanup = await import("../src/jobs/repl-cleanup.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'repl-endpoint-missing-steps')", [T]);
  await core.startBoss();
});
after(async () => {
  if (prevMock === undefined) delete process.env.MOCK_IAC; else process.env.MOCK_IAC = prevMock;
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

function noDbSpec() {
  const s = structuredClone(adapters.DEMO_SPEC) as { components: { id: string; kind: string }[]; links: unknown[] };
  const dbIds = new Set(s.components.filter((c) => c.kind === "postgres").map((c) => c.id));
  assert.ok(dbIds.size > 0, "데모 명세엔 postgres 가 있다");
  s.components = s.components.filter((c) => !dbIds.has(c.id));
  s.links = s.links.filter((l) => ![...dbIds].some((d) => JSON.stringify(l).includes(`"${d}"`)));
  return s;
}

async function seed(status: "cutover" | "cleanup" | "rolling_back" | "rolled_back", o: { postgres: boolean; passedCutover?: boolean }) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, status]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [src, dst, T, id]);
  const spec = o.postgres ? adapters.DEMO_SPEC : noDbSpec();
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}','{}',$3)`,
    [T, id, JSON.stringify({ spec, fieldMeta: {}, unmapped: [], ids: {} })]);
  if (o.passedCutover)
    await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "cutover.rollback_window", target: id, result: "ok",
      detail: { from: "cutover", to: "rollback_window" } }));
  return id;
}
const st = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const job = (id: string) => ({ tenantId: T, requestId: `r-rems-${id.slice(0, 8)}`, migrationId: id });
const into = async (id: string, to: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND detail->>'to' = $2 ORDER BY seq DESC LIMIT 1", [id, to])).rows[0]?.detail;
const lastError = async (id: string) => String((await owner.query(
  "SELECT detail->>'error' AS e FROM audit_events WHERE target=$1 AND detail ? 'error' ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.e ?? "");

test("진짜 판 cutover: postgres 명세 + 끝점 없음 → failed REPL_ENDPOINT_MISSING (가짜 850ms 컷오버로 rollback_window 안 감)", { skip }, async () => {
  process.env.MOCK_IAC = "";
  const id = await seed("cutover", { postgres: true });
  await cutover.handleCutover(job(id));
  assert.deepEqual(await st(id), { status: "failed", failure_code: "REPL_ENDPOINT_MISSING" });
  assert.match(await lastError(id), /REPL_ENDPOINT_MISSING/);
});

test("진짜 판 cleanup: postgres 명세 + 끝점 없음 → paused REPL_ENDPOINT_MISSING (\"STUB: replication slot\" 지웠다고 completed 안 감)", { skip }, async () => {
  process.env.MOCK_IAC = "";
  const id = await seed("cleanup", { postgres: true });
  await cleanup.handleCleanup(job(id));
  assert.deepEqual(await st(id), { status: "paused", failure_code: "REPL_ENDPOINT_MISSING" });
  assert.match(await lastError(id), /REPL_ENDPOINT_MISSING/);
});

test("진짜 판 rollback, 컷오버 전: 트래픽은 출발로 되돌리고 rolled_back, 복제 걷기는 REPL_ENDPOINT_MISSING 으로 덜 끝남 (stub 아님)", { skip }, async () => {
  process.env.MOCK_IAC = "";
  const id = await seed("rolling_back", { postgres: true });
  await rollback.handleRollback(job(id));
  assert.equal((await st(id)).status, "rolled_back");
  const d = await into(id, "rolled_back");
  assert.equal(d.stub, undefined);
  assert.equal(d.replication.cleanup, "incomplete");
  assert.equal(d.replication.code, "REPL_ENDPOINT_MISSING");
  assert.equal((await owner.query("SELECT 1 FROM audit_events WHERE target=$1 AND action='rollback.traffic_restored'", [id])).rowCount, 1);
  assert.equal((await owner.query("SELECT 1 FROM audit_events WHERE target=$1 AND action='rollback.cleanup_incomplete'", [id])).rowCount, 1);
});

test("진짜 판 rollback, 컷오버 뒤: DB 주인이 도착일 수 있어 트래픽을 안 건드리고 rolled_back 으로 안 감", { skip }, async () => {
  process.env.MOCK_IAC = "";
  const id = await seed("rolling_back", { postgres: true, passedCutover: true });
  await rollback.handleRollback(job(id)).catch(() => undefined);
  assert.equal((await st(id)).status, "rolling_back");
  assert.match(await lastError(id), /REPL_ENDPOINT_MISSING/);
  assert.equal((await owner.query("SELECT 1 FROM audit_events WHERE target=$1 AND action='rollback.traffic_restored'", [id])).rowCount, 0);
});

test("진짜 판 repl-cleanup(끝난 이전 다시 걷기): 끝점 없음이면 걷었다(ok·stub)고 하지 않고 감사 error + 덜 끝남", { skip }, async () => {
  process.env.MOCK_IAC = "";
  const id = await seed("rolled_back", { postgres: true });
  assert.equal(await replCleanup.handleReplCleanup(job(id)), "incomplete");
  const a = (await owner.query("SELECT result, detail FROM audit_events WHERE target=$1 AND action='replication.cleanup' ORDER BY seq DESC LIMIT 1", [id])).rows[0];
  assert.equal(a.result, "error");
  assert.equal(a.detail.code, "REPL_ENDPOINT_MISSING");
  assert.equal(a.detail.stub, undefined);
});

test("진짜 판, postgres 없는 명세: cutover·cleanup·rollback 은 예전 STUB 길 그대로 (복제할 DB 가 없다)", { skip }, async () => {
  process.env.MOCK_IAC = "";
  const c = await seed("cutover", { postgres: false });
  await cutover.handleCutover(job(c));
  assert.equal((await st(c)).status, "rollback_window");
  const k = await seed("cleanup", { postgres: false });
  await cleanup.handleCleanup(job(k));
  assert.equal((await st(k)).status, "completed");
  const r = await seed("rolling_back", { postgres: false });
  await rollback.handleRollback(job(r));
  assert.equal((await st(r)).status, "rolled_back");
  assert.equal((await into(r, "rolled_back")).stub, true);
});

test("흉내 판(MOCK_IAC=1), postgres 명세: cutover·cleanup·rollback 은 예전 STUB 길 그대로", { skip }, async () => {
  process.env.MOCK_IAC = "1";
  const c = await seed("cutover", { postgres: true });
  await cutover.handleCutover(job(c));
  assert.equal((await st(c)).status, "rollback_window");
  const k = await seed("cleanup", { postgres: true });
  await cleanup.handleCleanup(job(k));
  assert.equal((await st(k)).status, "completed");
  const r = await seed("rolling_back", { postgres: true });
  await rollback.handleRollback(job(r));
  assert.equal((await st(r)).status, "rolled_back");
  assert.equal((await into(r, "rolled_back")).stub, true);
});
