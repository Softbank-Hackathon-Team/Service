// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
// db 0050 replication_endpoints: 회사 벽(RLS) 안에서 읽고 쓰기, replicationFor 가 줄을 쓰기, 한쪽만이면 오류,
// 리퍼 tx 안에서 읽기 실패가 트랜잭션을 안 깨기, sync 의 도착 TCP 확인(REPL_TARGET_UNREACHABLE), CLI show 가 비밀을 안 찍기
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { ReplicationEndpoint } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MASTER = "test-master-key-0123456789abcdef-xyz";   // 시험용 가짜 키
let core: typeof import("@svc/core");
let repl: typeof import("../src/jobs/_repl.js");
let reaper: typeof import("../src/lease/reaper.js");
let sync: typeof import("../src/jobs/sync.js");
let replication: typeof import("@svc/replication");
let owner: pg.Client;
const T = randomUUID(), U = randomUUID();

before(async () => {
  if (skip) return;
  for (const k of ["REPL_SOURCE_URL", "REPL_TARGET_URL"]) delete process.env[k];   // env 길은 비워 둔다 (줄이 없으면 null)
  process.env.REPL_SECRET_MASTER_KEY = MASTER;
  process.env.SYNC_RETRY_DELAYS_SEC = "600";   // 시도 2번: 첫 번은 재시도 예약, 두 번째에 paused
  process.env.REPL_REACH_TIMEOUT_MS = "1000";
  core = await import("@svc/core");
  replication = await import("@svc/replication");
  repl = await import("../src/jobs/_repl.js");
  reaper = await import("../src/lease/reaper.js");
  sync = await import("../src/jobs/sync.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  for (const t of [T, U]) await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'repl-endpoints')", [t]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  delete process.env.REPL_SECRET_MASTER_KEY;
  await owner.query("DELETE FROM env_locks WHERE tenant_id = ANY($1)", [[T, U]]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(t: string, status = "syncing") {
  const id = randomUUID(), s = randomUUID(), d = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, d, t]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`, [id, t, s, d, status]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [s, d, t, id]);
  return id;
}
const ep = (t: string, m: string, side: "source" | "target", o: Partial<ReplicationEndpoint> = {}): ReplicationEndpoint => ({
  tenantId: t, migrationId: m, side, label: `${side}-db`, provider: "postgres", host: `${side}.invalid`, port: 5432, dbname: "shop",
  username: "admin", passwordRef: "derive:admin", peerHost: null, peerPort: null, appRole: "app_user", fenceRoles: [], schemaName: null,
  sslmode: null, tlsServername: null, caPem: null, relayHost: null, relayKnownHosts: null, relayPort: 22, ...o,
});
const put = (t: string, e: ReplicationEndpoint) => core.withTenant(t, (tx) => core.upsertReplicationEndpoint(tx, e));

test("정상: 두 쪽을 등록하면 그 회사 아래에서 읽히고, replicationFor 가 줄 끝점(비밀번호는 derive)으로 만든다", { skip }, async () => {
  const M = await seed(T);
  await put(T, ep(T, M, "source"));
  await put(T, ep(T, M, "target", { host: "old.invalid" }));
  await put(T, ep(T, M, "target", { host: "10.1.2.3", sslmode: "require", fenceRoles: ["batch"] }));   // 같은 쪽 다시 등록 = 덮어쓰기
  const rows = await core.withTenant(T, (tx) => core.replicationEndpointsFor(tx, M));
  assert.deepEqual(rows.map((r) => [r.side, r.host]), [["source", "source.invalid"], ["target", "10.1.2.3"]]);
  assert.equal(rows[1]!.passwordRef, "derive:admin");
  const m = (await repl.replicationFor(T, M))!;
  assert.equal(m.cfg.target.origin, "db");
  assert.equal(new URL(m.cfg.target.adminUrl).hostname, "10.1.2.3");
  assert.equal(new URL(m.cfg.source.adminUrl).password,
    replication.deriveReplPassword(MASTER, { tenantId: T, migrationId: M, side: "source" }, "admin"));
  // CLI show: password_ref 는 보이고 풀린 비밀번호는 안 보인다
  const out = execFileSync(process.execPath, ["--import", "tsx", "tools/repl-endpoint.ts", "show", "--tenant", T, "--migration", M],
    { cwd: ROOT, env: process.env, encoding: "utf8" });
  assert.match(out, /derive:admin/);
  for (const side of ["source", "target"] as const)
    assert.ok(!out.includes(replication.deriveReplPassword(MASTER, { tenantId: T, migrationId: M, side }, "admin")), "풀린 비밀번호가 찍혔다");
});

test("거부(RLS): 다른 회사는 줄을 못 보고·못 쓰고, 그 이전으로 replicationFor 를 불러도 줄을 못 쓴다", { skip }, async () => {
  const M = await seed(T);
  await put(T, ep(T, M, "source")); await put(T, ep(T, M, "target"));
  assert.deepEqual(await core.withTenant(U, (tx) => core.replicationEndpointsFor(tx, M)), []);
  // U 로 T 의 이전에 줄 쓰기: 이미 있는 쪽이면 덮어쓰기 0줄 → 오류, 없는 쪽이면 (migration_id, tenant_id) 외래 키, tenant_id=T 면 RLS WITH CHECK
  await assert.rejects(put(U, ep(U, M, "source", { host: "evil.invalid" })), /이 회사에 없다/);
  await owner.query("DELETE FROM replication_endpoints WHERE migration_id = $1 AND side = 'target'", [M]);
  await assert.rejects(put(U, ep(U, M, "target", { host: "evil.invalid" })), /foreign key/);
  await assert.rejects(put(U, ep(T, M, "source", { host: "evil.invalid" })), /row-level security/);
  await put(T, ep(T, M, "target"));
  assert.equal(await repl.replicationFor(U, M), null, "env 도 줄도 없으니 null (T 의 줄을 안 씀)");
  const still = await core.withTenant(T, (tx) => core.replicationEndpointsFor(tx, M));
  assert.deepEqual(still.map((r) => r.host), ["source.invalid", "target.invalid"]);
});

test("거부: 표가 진짜 비밀번호 글자를 password_ref 로 안 받는다 (CHECK), 계약도 거부", { skip }, async () => {
  const M = await seed(T);
  await assert.rejects(owner.query(`INSERT INTO replication_endpoints (tenant_id, migration_id, side, label, provider, host, port, dbname, username, password_ref)
    VALUES ($1,$2,'source','x','postgres','h',5432,'d','u','hunter2')`, [T, M]), /check constraint/);
  await assert.rejects(put(T, ep(T, M, "source", { passwordRef: "env:DATABASE_URL" })));
});

test("거부: 한쪽만 있으면 replicationFor 가 REPL_ENDPOINT_INCOMPLETE, 리퍼는 오류만 남기고 트랜잭션은 계속 쓸 수 있다", { skip }, async () => {
  const M = await seed(T, "cutover");
  await put(T, ep(T, M, "source"));
  await assert.rejects(repl.replicationFor(T, M), (e: unknown) => e instanceof replication.ReplConfigError && e.code === "REPL_ENDPOINT_INCOMPLETE");
  const r = await core.withTenant(T, async (tx) => {
    const fence = await reaper.recoverFence({ tenantId: T, migrationId: M, status: "cutover" }, tx);
    const after = (await tx.query("SELECT status FROM migrations WHERE id = $1", [M])).rows[0]?.status;   // tx 가 안 깨졌나
    return { fence, after };
  });
  assert.match((r.fence as { error: string }).error, /한쪽만/);
  assert.equal(r.after, "cutover");
});

test("sync: 줄 도착 주소에 TCP 로 못 붙으면 재시도 뒤 paused REPL_TARGET_UNREACHABLE (오류에 host:port)", { skip }, async () => {
  const M = await seed(T);
  // 감사 detail 은 IP 를 가린다(<ip>) → 이름 주소로 확인
  await put(T, ep(T, M, "source", { host: "localhost", port: 1 }));
  await put(T, ep(T, M, "target", { host: "localhost", port: 1 }));
  const job = { tenantId: T, requestId: `r-reach-${M.slice(0, 8)}`, migrationId: M };
  assert.equal(await sync.handleSync(job), "skipped", "첫 시도: 재시도 예약 (접속 실패와 같은 꼴)");
  assert.equal(await sync.handleSync(job), "advanced", "두 번째: 시도 소진 → paused");
  const st = (await owner.query("SELECT status, failure_code FROM migrations WHERE id = $1", [M])).rows[0];
  assert.deepEqual(st, { status: "paused", failure_code: "REPL_TARGET_UNREACHABLE" });
  const d = (await owner.query(`SELECT detail FROM audit_events WHERE target = $1 AND detail ? 'error' ORDER BY seq DESC LIMIT 1`, [M])).rows[0]?.detail;
  assert.match(String(d?.error), /^REPL_TARGET_UNREACHABLE localhost:1 /);
});
