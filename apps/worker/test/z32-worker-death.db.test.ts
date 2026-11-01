// DB 시험(작업 Z32, Z6-2): 워커가 죽은 뒤 회복. Z36(청소 작업 + job_id 기록) 위에 얹은 것
//  ① 이전 단계 큐는 pg-boss 작업 생존 신호(heartbeatSeconds 10)를 쓴다 → 죽은 워커의 작업이 15분이 아니라 십몇 초 만에 재시도
//  ② 재시도(같은 작업 번호)는 죽은 앞 시도가 쥔 환경 잠금을 기한(90초)을 기다리지 않고 넘겨받는다
//  ③ 다른 작업 번호는 여전히 못 뺏는다
//  ④~⑦ apply·sync·cutover = "시작 전 사망만 재시도" (시작했으면 Z36 청소 작업에 맡김)
// 실제 kill -9 재현은 tools/load/worker-kill.sh (이 시험은 처리기를 직접 부른다. job_id 는 로그 문맥으로 넣는다 = instrument() 길)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let step: typeof import("../src/jobs/_step.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  step = await import("../src/jobs/_step.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z32')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

// 상태 s, 두 환경 잠금을 holder·jobId 가 쥔 채. 기본 남은 기한 25초 = 마지막 연장 뒤 65초 (selfFence 60초 지남)
async function seed(s: string, holder: string, jobId: string | null, leftSec = 20) { // Z38 R8-4: 인수 기준 25초보다 확실히 아래
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, s]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at, job_id, job_queue)
    VALUES ($1,$3,$4,$5, now() + make_interval(secs => $7), $6, 'deploy'), ($2,$3,$4,$5, now() + make_interval(secs => $7), $6, 'deploy')`,
    [src, dst, T, id, holder, jobId, leftSec]);
  return id;
}
const st = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const locksOf = async (id: string) => (await owner.query(
  "SELECT holder, job_id::text AS job_id FROM env_locks WHERE migration_id=$1", [id])).rows as { holder: string; job_id: string | null }[];
const job = (id: string) => ({ tenantId: T, requestId: `r-z32-${id.slice(0, 8)}`, migrationId: id });
// 진짜 워커처럼: jobAttempt(main.ts) + 로그 문맥 job_id·queue(instrument)
function asJob<R>(queue: string, jobId: string, retryCount: number, retryLimit: number, fn: () => Promise<R>): Promise<R> {
  return step.jobAttempt.run({ queue, retryCount, retryLimit },
    () => core.withLogContext({ job_id: jobId, queue } as never, fn));
}
const deployDef = (seen: string[], id: string) => ({
  name: "z32", expect: "deploying" as const,
  work: async () => {
    seen.push(...(await locksOf(id)).map((r) => `${r.holder}|${r.job_id}`));
    return { to: "syncing" as const, evidence: { argoHealthy: true, securityParity: true } };
  },
});
const probe = (ran: string[], expect: "provisioning" | "syncing") => ({
  name: "z32death", expect,
  work: async () => { ran.push("work"); return { to: expect === "syncing" ? "paused" as const : "failed" as const, failureCode: "Z32_TEST_RAN" }; },
});

test("Z32 ①: 이전 단계 큐 10개 모두 heartbeatSeconds=10, 청소·멱등 큐는 없음", { skip }, async () => {
  for (const q of ["import", "precheck", "plan", "apply", "deploy", "sync", "shift", "cutover", "cleanup", "rollback"]) {
    const r = await owner.query("SELECT heartbeat_seconds FROM pgboss.queue WHERE name=$1", [q]);
    assert.equal(r.rows[0]?.heartbeat_seconds, core.STEP_HEARTBEAT_SEC, q);
  }
  const r = await owner.query("SELECT heartbeat_seconds FROM pgboss.queue WHERE name='lease-reaper'");
  assert.equal(r.rows[0]?.heartbeat_seconds ?? null, null);
});

test("Z32 ②: 같은 작업 번호의 재시도는 죽은 앞 시도의 잠금(selfFence 지남, 기한 25초 남음)을 바로 넘겨받아 다음 상태로 간다", { skip }, async () => {
  const jobId = randomUUID();
  const id = await seed("deploying", "worker:dead-host-1", jobId);
  const seen: string[] = [];
  const r = await asJob("deploy", jobId, 1, 2, () => step.runStep(job(id), deployDef(seen, id)));
  assert.equal(r, "advanced");
  assert.equal((await st(id)).status, "syncing");
  assert.ok(seen.length === 2 && seen.every((s) => s === `${step.WORKER_HOLDER}|${jobId}`), `일하는 동안 잠금: ${seen}`);
  const a = await owner.query(`SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='job.rejected'`, [id]);
  assert.equal(a.rows[0].n, 0);
});

test("Z32 4차 ②-b: 같은 작업 번호라도 마지막 연장 뒤 60초+여유 전이면(남은 = 인수 기준 + 2초) 그만큼 기다렸다 인수한다 (가짜 죽음 방지)", { skip }, async () => {
  const jobId = randomUUID();
  const id = await seed("deploying", "worker:maybe-alive-1", jobId, core.SAME_JOB_TAKEOVER_LEFT_SEC + 2); // Z38 R8-4: 인수 기준이 30 → 25 (감시 여유 5초)
  const seen: string[] = [];
  const t0 = Date.now();
  const r = await asJob("deploy", jobId, 1, 2, () => step.runStep(job(id), deployDef(seen, id)));
  const waited = Date.now() - t0;
  assert.equal(r, "advanced");
  assert.ok(waited >= 1500 && waited < 6000, `기다린 ms: ${waited}`);
  assert.ok(seen.every((s) => s.startsWith(`${step.WORKER_HOLDER}|`)));
});

test("Z32 4차 ②-c: 기다리는 동안 앞 시도가 연장했다(사실은 살아 있음) → 인수 안 함, job.rejected, 상태 그대로", { skip }, async () => {
  const jobId = randomUUID();
  const id = await seed("deploying", "worker:alive-after-all", jobId, core.SAME_JOB_TAKEOVER_LEFT_SEC + 2); // Z38 R8-4: 인수 기준이 30 → 25 (감시 여유 5초)
  const renew = setTimeout(() => { void owner.query(
    "UPDATE env_locks SET lease_expires_at = now() + interval '90 seconds' WHERE migration_id=$1", [id]); }, 500);
  const seen: string[] = [];
  const r = await asJob("deploy", jobId, 1, 2, () => step.runStep(job(id), deployDef(seen, id)));
  clearTimeout(renew);
  assert.equal(r, "skipped");
  assert.equal(seen.length, 0);
  assert.equal((await st(id)).status, "deploying");
  assert.ok((await locksOf(id)).every((l) => l.holder === "worker:alive-after-all"));
});

test("Z32 ③: 다른 작업 번호(또는 번호 없음)는 살아 있는 남의 잠금을 못 뺏는다 → job.rejected, 상태 그대로", { skip }, async () => {
  const id = await seed("deploying", "worker:alive-host-2", randomUUID());
  const seen: string[] = [];
  const r1 = await asJob("deploy", randomUUID(), 0, 2, () => step.runStep(job(id), deployDef(seen, id)));
  const r2 = await step.runStep(job(id), deployDef(seen, id));
  assert.deepEqual([r1, r2], ["skipped", "skipped"]);
  assert.equal(seen.length, 0, "일을 시작하지 않음");
  assert.equal((await st(id)).status, "deploying");
  assert.ok((await locksOf(id)).every((x) => x.holder === "worker:alive-host-2"));
});

test("Z32 ④: apply 재시도인데 앞 시도가 잠금을 잡은 채 죽었다 → 다시 안 함(job.rejected), 잠금은 죽은 이름 그대로 = Z36 청소 몫", { skip }, async () => {
  const jobId = randomUUID();
  const id = await seed("provisioning", "worker:dead-host-3", jobId);
  const ran: string[] = [];
  const r = await asJob("apply", jobId, 1, 1, () => step.runStep(job(id), probe(ran, "provisioning")));
  assert.equal(r, "skipped");
  assert.deepEqual(ran, [], "Terraform 을 다시 돌리지 않음");
  assert.equal((await st(id)).status, "provisioning");
  assert.ok((await locksOf(id)).every((l) => l.holder === "worker:dead-host-3"), "잠금 안 건드림 → 기한 뒤 청소가 WORKER_LOST");
  const a = await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='job.rejected'`, [id]);
  assert.equal(a.rows[0]?.detail?.reason, "previous_attempt_started");
});

test("Z32 ⑤: apply 재시도인데 앞 시도가 잠금을 잡기 전에 죽었다(reserved) → 처음부터 한다 (예전: 계획 만료 2시간까지 reserved)", { skip }, async () => {
  const id = await seed("provisioning", "reserved", null);
  const ran: string[] = [];
  const r = await asJob("apply", randomUUID(), 1, 1, () => step.runStep(job(id), probe(ran, "provisioning")));
  assert.equal(r, "advanced");
  assert.deepEqual(ran, ["work"]);
  assert.equal((await st(id)).failure_code, "Z32_TEST_RAN");
});

test("Z32 ⑥: sync 재시도인데 앞 시도가 예외로 실패했다(job.failed 감사) → 다시 안 함", { skip }, async () => {
  const jobId = randomUUID();
  const id = await seed("syncing", "reserved", null);
  await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "job.failed", target: id, result: "error", detail: { jobId, job: "sync" } }));
  const ran: string[] = [];
  const r = await asJob("sync", jobId, 1, 1, () => step.runStep(job(id), probe(ran, "syncing")));
  assert.equal(r, "skipped");
  assert.deepEqual(ran, []);
});

test("Z32 ⑦: apply·sync·cutover 는 처리기 예외면 첫 시도도 마지막 시도로 친다, 큐 retry_limit 1", { skip }, async () => {
  for (const queue of ["apply", "sync", "cutover"])
    assert.equal(step.jobAttempt.run({ queue, retryCount: 0, retryLimit: 1 }, () => step.isLastAttempt()), true, queue);
  assert.equal(step.jobAttempt.run({ queue: "deploy", retryCount: 0, retryLimit: 2 }, () => step.isLastAttempt()), false);
  for (const q of ["apply", "sync", "cutover"]) {
    const r = await owner.query("SELECT retry_limit FROM pgboss.queue WHERE name=$1", [q]);
    assert.equal(r.rows[0].retry_limit, 1, q);
  }
});
