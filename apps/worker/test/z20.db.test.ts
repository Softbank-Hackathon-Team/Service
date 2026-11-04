// DB 시험(작업 Z20): 코드 리뷰 Z10 중간 항목 M1·M2·M3·M8·M10.
// 처리기를 직접 부른다. 다른 시험 파일의 워커가 다음 큐 작업을 먼저 집을 수 있어, 다음 상태는 "지나갔는지"로 본다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let step: typeof import("../src/jobs/_step.js");
let cutover: typeof import("../src/jobs/cutover.js");
let imp: typeof import("../src/jobs/import.js");
let adapters: typeof import("@svc/adapters");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "50";
  core = await import("@svc/core");
  step = await import("../src/jobs/_step.js");
  cutover = await import("../src/jobs/cutover.js");
  imp = await import("../src/jobs/import.js");
  adapters = await import("@svc/adapters");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z20')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(s: string, o: { lockSec?: number } = {}) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, s]);
  if (o.lockSec !== undefined) await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + make_interval(secs => $5)), ($2,$3,$4,'reserved', now() + make_interval(secs => $5))`,
    [src, dst, T, id, o.lockSec]);
  return { id, src, dst };
}
const st = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status as string;
const job = (id: string) => ({ tenantId: T, requestId: `r-z20-${id.slice(0, 8)}`, migrationId: id });

test("M1: 승인 예약 기한(계획 만료)이 곧 끝나도, 단계 작업이 끝나면 잠금 기한이 반납 기한(600초)으로 다시 잡혀 청소 작업 목록에 안 나온다", { skip }, async () => {
  const m = await seed("deploying", { lockSec: 1 });      // 승인 뒤 2시간이 거의 다 지난 이전
  const r = await step.runStep(job(m.id), { name: "z20m1", expect: "deploying",
    work: async () => ({ to: "syncing", evidence: { argoHealthy: true, securityParity: true } }) });
  assert.equal(r, "advanced");
  await new Promise((res) => setTimeout(res, 1200));      // 예전 기한(1초)을 넘긴다
  const left = (await owner.query(`SELECT holder, extract(epoch from lease_expires_at - now())::float s FROM env_locks
    WHERE migration_id=$1`, [m.id])).rows as { holder: string; s: number }[];
  assert.equal(left.length, 2);
  // 다른 시험 파일의 워커가 sync를 집었으면 worker:… (90초), 아니면 reserved (≈600초)
  for (const l of left) assert.ok(l.holder.startsWith("worker:") ? l.s > 0 : l.s > 500, JSON.stringify(l));
  const expired = await core.listExpiredEnvLocks(1000);
  assert.equal(expired.filter((x) => x.migrationId === m.id).length, 0, "청소 작업이 진행 중 이전을 paused로 보내지 않는다");
});

test("M2: ③에서 inTx가 감사를 쓰는 작업과 API 롤백(행 → 감사)이 겹쳐도 교착(40P01) 없이 둘 다 끝난다", { skip }, async () => {
  const m = await seed("deploying", { lockSec: 600 });
  // API 쪽: 같은 회사, 이전 행을 먼저 잠그고 잠깐 뒤에 감사 (control.ts 롤백·취소 모양)
  let apiResolve!: () => void;
  const apiGo = new Promise<void>((r) => { apiResolve = r; });
  let workerInTx = false;
  const workerRun = step.runStep(job(m.id), { name: "z20m2", expect: "deploying",
    work: async () => {
      // ②가 끝나는 순간 API가 행을 잡는다
      apiResolve();
      await new Promise((r) => setTimeout(r, 150));
      return { to: "syncing", evidence: { argoHealthy: true, securityParity: true },
        // apply의 saveInfraReady처럼 inTx 안에서 감사를 쓴다 (회사 감사 자문 잠금)
        inTx: async (tx) => { workerInTx = true; await core.writeAudit(tx, T, { actor: "worker", action: "z20.inTx", target: m.id, result: "ok" }); } };
    } });
  const apiRun = (async () => {
    await apiGo;
    return core.withTenant(T, async (tx) => {
      await tx.query("SELECT 1 FROM migrations WHERE id=$1 FOR UPDATE", [m.id]);
      await new Promise((r) => setTimeout(r, 400));      // 워커 ③이 들어올 시간
      await core.writeAudit(tx, T, { actor: "user:dev", action: "z20.api", target: m.id, result: "ok" });
      return "api-ok";
    });
  })();
  const [w, a] = await Promise.allSettled([workerRun, apiRun]);
  assert.equal(a.status, "fulfilled", a.status === "rejected" ? String(a.reason) : "");
  assert.equal(w.status, "fulfilled", w.status === "rejected" ? `${(w.reason as { code?: string }).code} ${w.reason}` : "");
  assert.ok(workerInTx);
  assert.notEqual(await st(m.id), "deploying");
});

test("M3: 컷오버(STUB)가 적는 롤백 창 = core 기본값 하나 (cutover 작업과 advance 가 같은 값)", { skip }, async () => {
  assert.equal(cutover.ROLLBACK_WINDOW_SEC, core.DEFAULT_ROLLBACK_WINDOW_SEC);
  const m = await seed("cutover", { lockSec: 600 });
  assert.equal(await cutover.handleCutover(job(m.id)), "advanced");
  const r = (await owner.query(`SELECT extract(epoch from rollback_window_ends_at - now())::float s FROM migrations WHERE id=$1`, [m.id])).rows[0];
  assert.ok(Math.abs(r.s - core.DEFAULT_ROLLBACK_WINDOW_SEC) < 5, `창 ${r.s}초, 기대 ${core.DEFAULT_ROLLBACK_WINDOW_SEC}초`);
});

test("M8: apply 큐 만료 3600초, 이미 있던 큐(예전 DB)도 startBoss가 정책 표로 덮어쓴다", { skip }, async () => {
  const exp = async () => (await owner.query("SELECT expire_seconds FROM pgboss.queue WHERE name='apply'")).rows[0].expire_seconds as number;
  assert.equal(await exp(), 3600);
  await owner.query("UPDATE pgboss.queue SET expire_seconds=900 WHERE name='apply'");   // 고치기 전 DB 흉내
  await core.startBoss();
  assert.equal(await exp(), 3600);
  const other = (await owner.query("SELECT expire_seconds FROM pgboss.queue WHERE name='sync'")).rows[0].expire_seconds;
  assert.equal(other, 900, "나머지 큐는 기본 15분 그대로");
});

test("M10: import가 discover(바깥 호출) 동안 DB 트랜잭션을 열어 두지 않는다 (idle in transaction 0)", { skip }, async () => {
  const m = await seed("importing");
  const a = imp.importDeps;
  const orig = a.discover;
  let during = -1;
  a.discover = async (...args: Parameters<typeof orig>) => {
    await new Promise((r) => setTimeout(r, 300));          // 진짜 클라우드 API처럼 느리게
    during = (await owner.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname = current_database() AND usename='app_user' AND state LIKE 'idle in transaction%'
        AND query LIKE '%JOIN environments e ON e.id = m.source_env_id%'`)).rows[0].n;   // import ①의 마지막 쿼리
    return orig(...args);
  };
  try { await imp.handleImport(job(m.id)); } finally { a.discover = orig; }
  assert.equal(during, 0, "discover 중 열린 트랜잭션 수");
  assert.notEqual(await st(m.id), "importing");
  const v = await owner.query("SELECT count(*)::int n FROM spec_versions WHERE migration_id=$1", [m.id]);
  assert.equal(v.rows[0].n, 1);
});

test("M10: discover 동안 취소되면 저장·전이 없이 끝난다 (③에서 상태 다시 확인)", { skip }, async () => {
  const m = await seed("importing");
  const a = imp.importDeps;
  const orig = a.discover;
  a.discover = async (...args: Parameters<typeof orig>) => {
    await owner.query("UPDATE migrations SET status='cancelled' WHERE id=$1", [m.id]);
    return orig(...args);
  };
  try { await imp.handleImport(job(m.id)); } finally { a.discover = orig; }
  assert.equal(await st(m.id), "cancelled");
  const v = await owner.query("SELECT count(*)::int n FROM spec_versions WHERE migration_id=$1", [m.id]);
  assert.equal(v.rows[0].n, 0);
});
