// DB 시험(작업 Z1): 실행 작업과 환경 잠금 (P-3 수정 뒤), 실패했을 때 잠금이 풀리는지 (ENV_BUSY 재현 W·X).
// 처리기를 직접 부른다. 다른 시험 파일의 워커가 같은 큐 작업을 먼저 집을 수 있어, 끝 상태는 기다려서 본다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let step: typeof import("../src/jobs/_step.js");
let apply: typeof import("../src/jobs/apply.js");
let sync: typeof import("../src/jobs/sync.js");
let rollback: typeof import("../src/jobs/rollback.js");
let owner: pg.Client;
const T = randomUUID();
const audit = { actor: "test", action: "t", target: "t", result: "ok" as const };
const EXPIRES = new Date(Date.now() + 2 * 3600_000).toISOString();

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "300";
  // Z19: sync 재시도는 처리기가 대기를 정해 다시 넣는다(기본 5·15·45초). 이 시험은 "재시도 1번 → 2번째에 롤백" 모양이라 1개만, 길게
  process.env.SYNC_RETRY_DELAYS_SEC = "600";
  process.env.SYNC_EXHAUSTED_ACTION = "rollback";   // 이 파일은 Z1의 자동 롤백 길을 본다 (기본은 paused, Z19)
  core = await import("@svc/core");
  step = await import("../src/jobs/_step.js");
  apply = await import("../src/jobs/apply.js");
  sync = await import("../src/jobs/sync.js");
  rollback = await import("../src/jobs/rollback.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z1-locks')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

// 상태 s + 두 환경 'reserved' 잠금 (+ apply용 계획·승인). 환경은 이전마다 새로
async function seed(s: string, o: { plan?: boolean; holder?: string; envs?: [string, string] } = {}) {
  const id = randomUUID(), planId = randomUUID();
  const [src, dst] = o.envs ?? [randomUUID(), randomUUID()];
  if (!o.envs) await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, s]);
  if (o.plan) {
    const doc = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
      rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
      tfPlanHash: "tf", helmValuesHash: "hv", planHash: "hp", expiresAt: EXPIRES };
    await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
      VALUES ($1,$2,$3,$4,'hp',$5)`, [planId, T, id, JSON.stringify(doc), EXPIRES]);
    await owner.query(`INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash)
      VALUES ($1,$2,$3,'approve','user:dev','hp')`, [T, planId, id]);
    // 적용은 받아들인 판의 명세를 다시 읽는다 (없으면 TF_PLAN_DRIFT)
    const { ONE } = await import("./demo-one.js");
    await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}','{}',$3)`,
      [T, id, JSON.stringify({ spec: ONE, fieldMeta: {}, unmapped: [], ids: {} })]);
  }
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,$5, now() + interval '2 hours'), ($2,$3,$4,$5, now() + interval '2 hours')`,
    [src, dst, T, id, o.holder ?? "reserved"]);
  return { id, planId, src, dst };
}
const st = async (id: string) => (await owner.query(
  "SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0] as { status: string; failure_code: string | null };
const locks = async (id: string) => (await owner.query(
  `SELECT holder, extract(epoch from lease_expires_at - now())::float AS left_sec FROM env_locks
    WHERE migration_id=$1 ORDER BY env_id`, [id])).rows as { holder: string; left_sec: number }[];
async function until(f: () => Promise<boolean>, ms = 10_000) {
  const t0 = Date.now();
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); }
}
const job = (id: string) => ({ tenantId: T, requestId: `r-z1-${id.slice(0, 8)}`, migrationId: id });

test("P-3: apply가 일하는 동안 두 환경 모두 worker:<id>, 끝나면 reserved로 반납(약 600초), 다음 단계 deploying", { skip }, async () => {
  const m = await seed("provisioning", { plan: true });
  const seen = new Set<string>();
  let done = false;
  const run = apply.handleApply({ ...job(m.id), planId: m.planId, planHash: "hp" }).finally(() => { done = true; });
  while (!done) { for (const l of await locks(m.id)) seen.add(l.holder); await new Promise((r) => setTimeout(r, 30)); }
  assert.equal(await run, "advanced");
  assert.ok(seen.has(step.WORKER_HOLDER), `본 주인: ${[...seen]}`);
  const after = await locks(m.id);
  // 다른 시험 파일의 워커가 deploy 작업을 바로 집어 인수했을 수도 있다 → 둘 중 하나
  assert.ok(after.every((l) => l.holder === "reserved" || l.holder.startsWith("worker:")));
  if (after.every((l) => l.holder === "reserved")) assert.ok(after.every((l) => l.left_sec > 500 && l.left_sec <= 600));
  assert.notEqual((await st(m.id)).status, "provisioning");
});

test("P-3: 다른 워커가 살아 있는 잠금을 쥐고 있으면 일을 시작하지 않는다 (job.rejected, 상태 그대로)", { skip }, async () => {
  const m = await seed("provisioning", { plan: true, holder: "worker:someone-else" });
  assert.equal(await apply.handleApply({ ...job(m.id), planId: m.planId, planHash: "hp" }), "skipped");
  assert.equal((await st(m.id)).status, "provisioning");
  assert.ok((await locks(m.id)).every((l) => l.holder === "worker:someone-else"), "남의 잠금은 안 건드림");
  const a = await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='job.rejected'`, [m.id]);
  assert.equal(a.rows[0]?.detail?.reason, "env_lock_not_acquired");
});

test("P-3 fence: 일하는 도중 잠금을 뺏기면 상태를 옮기지 않는다 (LEASE_LOST)", { skip }, async () => {
  const m = await seed("deploying");
  const run = step.runStep(job(m.id), { name: "z1fence", expect: "deploying",
    work: async () => {
      // 일하는 중에 롤백이 잠금을 되찾아 간 것처럼
      await owner.query("UPDATE env_locks SET holder='worker:thief' WHERE migration_id=$1", [m.id]);
      return { to: "syncing", evidence: { argoHealthy: true, securityParity: true } };
    } });
  await assert.rejects(run, { code: "LEASE_LOST" });
  assert.equal((await st(m.id)).status, "deploying");
});

test("apply 실패 → failed(APPLY_FAILED), 잠금 해제 → 같은 환경으로 다음 이전 승인 가능 (X의 ENV_BUSY)", { skip }, async () => {
  const m = await seed("provisioning", { plan: true });
  process.env.APPLY_STUB_FAIL = "1";
  try { assert.equal(await apply.handleApply({ ...job(m.id), planId: m.planId, planHash: "hp" }), "advanced"); }
  finally { delete process.env.APPLY_STUB_FAIL; }
  assert.deepEqual(await st(m.id), { status: "failed", failure_code: "APPLY_FAILED" });
  assert.equal((await locks(m.id)).length, 0);
  // 같은 환경 쌍으로 다음 이전: 예약이 된다
  const n = await seed("approved", { envs: [m.src, m.dst] }).catch((e) => e);
  assert.ok(!(n instanceof Error), `다음 이전 잠금 예약 실패: ${n}`);
});

test("sync 실패 1번째: 재시도 기록 + 대기 뒤 다시 넣기(Z19), 잠금은 reserved로 반납 / 2번째: 자동 rolling_back → 롤백 작업 → rolled_back, 잠금 해제 (W의 ENV_BUSY)", { skip }, async () => {
  const m = await seed("syncing");
  process.env.SYNC_STUB_FAIL = "1";
  try {
    assert.equal(await sync.handleSync(job(m.id)), "skipped");   // Z19: 예외 대신 RetryLater (예전: rejects /SYNC_STUB_FAIL/)
    assert.equal((await st(m.id)).status, "syncing");
    assert.ok((await locks(m.id)).every((l) => l.holder === "reserved"), "재시도(다른 워커일 수도)가 바로 인수하게 반납");
    assert.equal(await sync.handleSync(job(m.id)), "advanced");
  } finally { delete process.env.SYNC_STUB_FAIL; }
  assert.deepEqual(await st(m.id), { status: "rolling_back", failure_code: "SYNC_FAILED" });
  const q = await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE name='rollback' AND data->>'migrationId'=$1", [m.id]);
  assert.equal(q.rows[0].n, 1, "롤백 작업이 같은 트랜잭션에서 들어감");
  await rollback.handleRollback(job(m.id)).catch(() => undefined);   // 다른 워커가 먼저 했으면 skipped
  await until(async () => (await st(m.id)).status === "rolled_back");
  assert.equal((await st(m.id)).failure_code, "SYNC_FAILED", "rolled_back에도 이유가 남는다");
  assert.equal((await locks(m.id)).length, 0);
});

test("롤백 시작은 일하던 워커의 잠금을 되찾는다 → 롤백 작업이 바로 인수 (매달린 sync가 있어도)", { skip }, async () => {
  const m = await seed("syncing", { holder: "worker:stuck-sync" });
  await core.withTenant(T, (tx) => core.advance(tx, { id: m.id, tenantId: T }, "syncing", "rolling_back",
    { failureCode: "USER_REQUESTED", audit }));
  assert.ok((await locks(m.id)).every((l) => l.holder === "reserved"));
  await rollback.handleRollback(job(m.id));
  assert.equal((await st(m.id)).status, "rolled_back");
  assert.equal((await locks(m.id)).length, 0);
});

test("롤백 자체가 2번 실패 → failed(ROLLBACK_FAILED), 잠금은 남는다 → 수동 정리 확인 뒤 cancelled에서 해제", { skip }, async () => {
  const m = await seed("rolling_back");
  const boom = { name: "rollback", expect: "rolling_back" as const,
    work: async () => { throw new Error("lb unreachable"); },
    onError: async (e: unknown, j: { tenantId: string; requestId: string; migrationId: string }) => {
      const n = (await step.failedAttempts(j, "rollback")) + 1;
      if (n >= rollback.ROLLBACK_MAX_ATTEMPTS) return { to: "failed" as const, failureCode: "ROLLBACK_FAILED" };
      await step.recordAttemptFailure(j, "rollback", { attempts: n, max: rollback.ROLLBACK_MAX_ATTEMPTS, error: String(e) });
      return null;
    } };
  await assert.rejects(step.runStep(job(m.id), boom), /lb unreachable/);
  assert.equal((await st(m.id)).status, "rolling_back");
  assert.equal(await step.runStep(job(m.id), boom), "advanced");
  assert.deepEqual(await st(m.id), { status: "failed", failure_code: "ROLLBACK_FAILED" });
  assert.equal((await locks(m.id)).length, 2, "데이터가 반쯤 바뀐 뒤의 실패는 잠금 유지");
  await core.withTenant(T, (tx) => core.advance(tx, { id: m.id, tenantId: T }, "failed", "cancelled",
    { evidence: { manualCleanupConfirmed: true }, audit }));
  assert.equal((await locks(m.id)).length, 0);
});
