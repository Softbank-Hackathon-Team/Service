// DB 시험(작업 Z12) 시나리오 4·5 (int3 = Z1 포함 기준): 단계 작업이 실패할 때 상태와 환경 잠금이 어떻게 남는가
// Z1의 z1-locks.db.test가 이미 보는 것(apply 실패 → failed·잠금 해제, sync 2번 실패 → 자동 롤백, 롤백 실패 → failed 유지)은 다시 안 본다.
// 여기서는 그 밖의 길: onError가 없는 단계(deploy·shift·cutover·cleanup)의 예외, 전이 조건 실패, 실패 코드 → paused, paused에서 나가기.
// 처리 함수 대신 같은 runStep에 시험용 단계 정의를 넣는다 (어댑터 STUB이 실패 코드를 내는 것을 흉내).
// 청소(reapOnce)는 모든 회사를 훑어 다른 시험 파일을 건드리므로, 잠금 하나 처리 함수(reapLock)로 이 이전만 처리한다.
// Z36: Z12-6·7을 고친 뒤 단언을 뒤집었다 (④-a JOB_NOT_PICKED → STEP_FAILED, ④-b worker:<pid>·WORKER_LOST → reserved·STEP_FAILED)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const T = randomUUID();
let core: typeof import("@svc/core");
let step: typeof import("../src/jobs/_step.js");
let reaper: typeof import("../src/lease/reaper.js");
let owner: pg.Client;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  step = await import("../src/jobs/_step.js");
  reaper = await import("../src/lease/reaper.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z12-paused')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

// 상태 s + 두 환경 잠금 reserved(앞 단계가 반납한 모습, 10분)
async function seed(s: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, s]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`,
    [src, dst, T, id]);
  return { id, job: { tenantId: T, requestId: `z12-${randomUUID().slice(0, 6)}`, migrationId: id } };
}
const row = async (id: string) => (await owner.query(
  "SELECT status, paused_from, failure_code, version FROM migrations WHERE id=$1", [id])).rows[0];
const locks = async (id: string) => (await owner.query(
  "SELECT holder, round(extract(epoch from lease_expires_at - now()))::int AS left_sec FROM env_locks WHERE migration_id=$1 ORDER BY env_id", [id])).rows;
const audits = async (id: string, action: string) => (await owner.query(
  "SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action=$2", [id, action])).rows[0].n as number;

// 청소 한 번을 이 이전에만: 잠금 기한을 과거로 → reapLock (reapOnce가 잠금마다 부르는 것과 같은 함수)
async function reapThis(id: string) {
  await owner.query("UPDATE env_locks SET lease_expires_at = now() - interval '1 second' WHERE migration_id=$1", [id]);
  const l = (await owner.query(
    `SELECT l.tenant_id AS "tenantId", l.env_id AS "envId", l.migration_id AS "migrationId", l.holder,
            l.job_id AS "jobId", l.job_queue AS "jobQueue", m.status
       FROM env_locks l JOIN migrations m ON m.id=l.migration_id WHERE l.migration_id=$1 LIMIT 1`, [id])).rows[0];
  return (await reaper.reapLock(l)).action;
}

const boom = (msg: string) => async () => { await new Promise((r) => setTimeout(r, 20)); throw new Error(msg); };

test("④-a onError 없는 단계(deploy 모양)에서 어댑터 예외(마지막 시도 아님) → 상태 그대로, 잠금 reserved 반납 + job.failed 감사 → 기한 뒤 청소가 paused(STEP_FAILED)", { skip }, async () => {
  const m = await seed("deploying");
  const def = { name: "z12deploy", expect: "deploying" as const, work: boom("STUB: argo sync failed") };
  for (let i = 0; i < 2; i++)                                     // deploy 큐 retryLimit 1 = 최대 2번 실행
    await assert.rejects(step.runStep(m.job, def), /argo sync failed/);
  const r = await row(m.id);
  assert.equal(r.status, "deploying", "예외는 상태를 안 바꾼다 (O-1, Z12-5)");
  const l = await locks(m.id);
  assert.ok(l.every((x) => x.holder === "reserved" && x.left_sec > 500), `반납된 잠금: ${JSON.stringify(l)}`);
  assert.equal(await audits(m.id, "z12deploy.attempt_failed"), 0, "onError 없는 단계는 attempt_failed 없음");
  assert.equal(await audits(m.id, "job.failed"), 2, "Z36: 실패마다 job.failed 1줄");
  const act = await reapThis(m.id);
  assert.deepEqual(act, { kind: "fail", to: "paused", code: "STEP_FAILED" });
  const r2 = await row(m.id);
  assert.equal(r2.status, "paused"); assert.equal(r2.paused_from, "deploying");
  assert.equal(r2.failure_code, "STEP_FAILED", "Z12-6 고침: 예전엔 JOB_NOT_PICKED(안 집힘)로 잘못 남았다");
  assert.equal((await locks(m.id)).length, 2, "paused는 잠금 유지");
});

test("④-b ③에서 전이 조건 실패(GuardFailed) → 잠금은 따로 reserved로 반납 + job.failed(GUARD_FAILED) → 기한 뒤 청소가 paused(STEP_FAILED)", { skip }, async () => {
  const m = await seed("deploying");
  // 증거 없이 syncing으로 가려 함 (deploy가 argoHealthy를 빠뜨린 상황)
  const def = { name: "z12guard", expect: "deploying" as const, work: async () => ({ to: "syncing" as const, evidence: {} }) };
  await assert.rejects(step.runStep(m.job, def), (e: Error & { code?: string }) => e.code === "GUARD_FAILED");
  assert.equal((await row(m.id)).status, "deploying");
  const l = await locks(m.id);
  assert.ok(l.every((x) => x.holder === "reserved" && x.left_sec > 500),
    `Z12-7 고침: 예전엔 ③ 트랜잭션과 같이 취소돼 worker:<pid>(90초)로 남았다 ${JSON.stringify(l)}`);
  const f = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='job.failed'", [m.id])).rows;
  assert.equal(f.length, 1); assert.equal(f[0].detail.code, "GUARD_FAILED");
  const act = await reapThis(m.id);
  assert.deepEqual(act, { kind: "fail", to: "paused", code: "STEP_FAILED" }, "예전: 워커는 살아 있는데 WORKER_LOST");
});

test("⑤-a 어댑터 실패 코드를 onError가 paused로 바꾸면 → paused, paused_from·failure_code 기록, 잠금 reserved 유지, 감사 1줄", { skip }, async () => {
  const m = await seed("deploying");
  const def = { name: "z12stub", expect: "deploying" as const, work: boom("STUB_FAIL"),
    onError: async () => ({ to: "paused" as const, failureCode: "ADAPTER_STUB_FAILED", detail: { adapter: "argocd" } }) };
  assert.equal(await step.runStep(m.job, def), "advanced");
  const r = await row(m.id);
  assert.deepEqual([r.status, r.paused_from, r.failure_code], ["paused", "deploying", "ADAPTER_STUB_FAILED"]);
  assert.ok((await locks(m.id)).every((x) => x.holder === "reserved"));
  assert.equal(await audits(m.id, "z12stub.paused"), 1);
  // 같은 작업 재배달 → no-op
  assert.equal(await step.runStep(m.job, def), "skipped");
  // 청소가 와도 paused에서 갈 곳이 없어 건너뛴다 (잠금 유지)
  const act = await reapThis(m.id);
  assert.equal(act.kind, "skip");
  assert.equal((await row(m.id)).status, "paused");
});

test("⑤-b 실패 코드 없이 paused로 가려 하면 T30 조건에 막힘 → 상태 그대로", { skip }, async () => {
  const m = await seed("syncing");
  const def = { name: "z12nocode", expect: "syncing" as const, work: async () => ({ to: "paused" as const }) };
  await assert.rejects(step.runStep(m.job, def), (e: Error & { code?: string }) => e.code === "GUARD_FAILED" && /guardrailRule or failureCode/.test(e.message));
  assert.equal((await row(m.id)).status, "syncing");
});

test("⑤-c paused에서 나가기: 재개(→ paused_from)는 ruleCleared 증거가 있어야 하고 다른 단계로는 못 감, 다음 작업은 부르는 쪽이 넣어야 함, 롤백은 잠금 되찾고 바로 가능", { skip }, async () => {
  const m = await seed("deploying");
  await step.runStep(m.job, { name: "z12stub2", expect: "deploying", work: boom("x"),
    onError: async () => ({ to: "paused", failureCode: "ADAPTER_STUB_FAILED" }) });
  const adv = (to: string, o: Record<string, unknown> = {}) => core.withTenant(T, (tx) =>
    core.advance(tx, { id: m.id, tenantId: T }, "paused", to as never, { audit: { actor: "user:z12", action: `z12.${to}`, target: m.id, result: "ok" }, ...o }));
  await assert.rejects(adv("deploying"), (e: Error & { code?: string }) => e.code === "GUARD_FAILED");           // 증거 없음
  await assert.rejects(adv("syncing", { evidence: { ruleCleared: true } }), (e: Error & { code?: string }) => e.code === "GUARD_FAILED"); // 다른 단계
  assert.equal(await adv("deploying", { evidence: { ruleCleared: true } }), true);
  assert.equal((await row(m.id)).status, "deploying");
  const jobs = await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE name='deploy' AND data->>'migrationId'=$1", [m.id]);
  assert.equal(jobs.rows[0].n, 0, "advance만으로는 deploy 작업이 안 생김 → 그래서 재개 API(POST .../resume, Z36)가 작업을 같이 넣는다 (apps/api/test/z36-resume.db.test.ts)");

  // 롤백 길: 다시 paused로 만든 뒤 → rolling_back (잠금 되찾기)
  await step.runStep(m.job, { name: "z12stub3", expect: "deploying", work: boom("x"),
    onError: async () => ({ to: "paused", failureCode: "ADAPTER_STUB_FAILED" }) });
  await owner.query("UPDATE env_locks SET holder='worker:ghost', lease_expires_at = now() + interval '80 seconds' WHERE migration_id=$1", [m.id]);
  assert.equal(await adv("rolling_back"), true);
  assert.ok((await locks(m.id)).every((x) => x.holder === "reserved"), "롤백 시작이 남의 잠금을 되찾음 (Z1)");
});
