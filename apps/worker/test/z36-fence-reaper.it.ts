// Z36 (Z42 Q17) 끝-끝: 컷오버 도중 워커가 죽은 이전을 청소 작업(reapLock)이 처리하면 출발 DB 울타리가 걷히나.
// 플랫폼 DB(.env) + 복제 시험 DB 두 대(packages/replication: npm run db:up, 55432/55433)가 다 있어야 돈다. 없으면 건너뜀.
// 죽음 흉내: 정방향 복제를 만든 뒤 출발에 울타리(fence)만 치고, 잠금은 죽은 워커 이름 + 기한 지남으로 둔다 (= C2 직후 SIGKILL)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Migration, withClient, fence, unfence, appCanWrite } from "@svc/replication";
import { SOURCE, TARGET, TABLES, reachable, resetAndSeed } from "../../../packages/replication/test/harness.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const replUp = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음"
  : !replUp ? "복제 시험 Postgres(55432/55433)가 안 떠 있음: npm run db:up -w @svc/replication" : false;
const T = randomUUID();
let core: typeof import("@svc/core");
let reaper: typeof import("../src/lease/reaper.js");
let owner: pg.Client;
const saved: Record<string, string | undefined> = {};

before(async () => {
  if (skip) return;
  // 청소 작업이 replicationFromEnv()로 같은 두 DB를 보게 한다 (이 시험 프로세스 안에서만)
  const env = { REPL_SOURCE_URL: SOURCE.adminUrl, REPL_TARGET_URL: TARGET.adminUrl,
    REPL_SOURCE_PEER_URL: SOURCE.peerUrl, REPL_TARGET_PEER_URL: TARGET.peerUrl,
    REPL_SOURCE_APP_ROLE: "app_user", REPL_TARGET_APP_ROLE: "app_user", REPL_TABLES: TABLES.join(",") };
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  core = await import("@svc/core");
  reaper = await import("../src/lease/reaper.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z36-fence')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await withClient(SOURCE, async (c) => { await c.query("SET default_transaction_read_only = off"); await unfence(c, SOURCE); }).catch(() => {});
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
  await resetAndSeed(10).catch(() => {});
});

test("컷오버 중 워커 SIGKILL(울타리만 치고 죽음) → 청소: 출발 울타리 걷기 → failed(WORKER_LOST), 감사 detail.fence", { skip }, async () => {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'cutover')`,
    [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at) VALUES
    ($1,$3,$4,'worker:z36-dead', now() - interval '1 second'), ($2,$3,$4,'worker:z36-dead', now() - interval '1 second')`,
    [src, dst, T, id]);
  // 워커가 쓰는 것과 같은 이름(이전 id)으로 정방향 복제 → 울타리
  await resetAndSeed(200);
  const m = new Migration({ key: id, source: SOURCE, target: TARGET, tables: TABLES });
  await m.sync();
  await withClient(SOURCE, (c) => fence(c, SOURCE));
  assert.equal(await withClient(SOURCE, (c) => appCanWrite(c, SOURCE, "orders")), false, "재현: 출발 쓰기 막힘");

  const l = (await owner.query(
    `SELECT l.tenant_id AS "tenantId", l.env_id AS "envId", l.migration_id AS "migrationId", l.holder,
            l.job_id AS "jobId", l.job_queue AS "jobQueue", m.status
       FROM env_locks l JOIN migrations m ON m.id=l.migration_id WHERE l.migration_id=$1 LIMIT 1`, [id])).rows[0];
  const t0 = performance.now();
  const r = await reaper.reapLock(l);
  const ms = Math.round(performance.now() - t0);
  assert.deepEqual(r.action, { kind: "fail", to: "failed", code: "WORKER_LOST" });
  assert.equal(r.applied, true);
  const row = (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
  assert.deepEqual(row, { status: "failed", failure_code: "WORKER_LOST" });
  assert.equal(await withClient(SOURCE, (c) => appCanWrite(c, SOURCE, "orders")), true, "출발 쓰기가 돌아옴");
  const a = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed'", [id])).rows[0];
  assert.equal(a.detail.fence.action, "unfenced_source");
  assert.equal(a.detail.fence.sourceWritable, true);
  assert.equal((await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [id])).rows[0].n, 2,
    "컷오버 실패는 잠금 유지(사람이 확인 뒤 취소). 출발은 다시 쓸 수 있으니 서비스는 안 멈춤");
  console.log(`[z36] reaper cutover recovery ${ms} ms: ${JSON.stringify(a.detail.fence)}`);
  await m.teardown();
});
