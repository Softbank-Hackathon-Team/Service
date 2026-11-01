// 장애 시험(작업 Z12) 시나리오 1: 진짜 워커 프로세스를 일하는 도중 SIGKILL → 무슨 일이 일어나나 (int3 = Z1 잠금 포함 기준)
// 실행: node --env-file=.env --import tsx --test --test-concurrency=1 tools/chaos/crash-takeover.chaos.ts
//       실제 시간(잠금 90초 + 청소 1분 주기)으로 한 번 보려면 앞에 CHAOS_REAL_TIME=1 (약 2~3분 더 걸림)
// test:db와 같이 돌리지 않는다 (자식 워커가 다른 시험의 작업을 집어 가고, 다른 시험의 워커가 이 시험 작업을 집어 간다)
//
// 시간 당기기(기본): 환경 잠금 기한(lease_expires_at)을 과거로 바꾸고 청소(reapOnce)를 이 프로세스에서 한 번 부른다.
// 워커·큐·잠금·상태 이동은 전부 진짜 코드다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { startProc, waitOut, until, sleep, ownerClient, stopProc, type Proc } from "./_proc.js";

const T = randomUUID();
const STUB_MS = 2500;                 // 단계마다 "일하는 척" 2.5초 → 그 사이에 죽인다
const REAL = process.env.CHAOS_REAL_TIME === "1";
let owner: pg.Client;
let core: typeof import("@svc/core");
let reaper: typeof import("../../apps/worker/src/lease/reaper.js");
const procs: Proc[] = [];

before(async () => {
  process.env.STUB_DELAY_MS = String(STUB_MS);
  core = await import("@svc/core");
  reaper = await import("../../apps/worker/src/lease/reaper.js");
  owner = ownerClient(); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z12-crash')", [T]);
  await core.startBoss();          // 이 프로세스는 작업을 넣고 들여다보기만 한다. boss.work 없음
});
after(async () => {
  for (const p of procs) await stopProc(p);
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

const worker = (name: string, env: Record<string, string> = {}) => {
  const p = startProc(name, "apps/worker/src/main.ts", { STUB_DELAY_MS: String(STUB_MS), ROLLBACK_WINDOW_SEC: "1", ...env });
  procs.push(p); return p;
};

async function seedProvisioning() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID(), planId = randomUUID();
  const exp = new Date(Date.now() + 2 * 3600_000).toISOString();
  const doc = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: "tf", helmValuesHash: "hv", planHash: "hp", expiresAt: exp };
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'provisioning')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
    VALUES ($1,$2,$3,$4,'hp',$5)`, [planId, T, id, JSON.stringify(doc), exp]);
  await owner.query(`INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash)
    VALUES ($1,$2,$3,'approve','user:dev','hp')`, [T, planId, id]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved',$5), ($2,$3,$4,'reserved',$5)`, [src, dst, T, id, exp]);
  // start 경로가 넣는 것과 같은 apply 작업 (같은 작업 키)
  await core.boss.send("apply", { tenantId: T, requestId: "z12-crash", migrationId: id, planId, planHash: "hp" },
    { singletonKey: `apply:${dst}` });
  return { id, dst };
}

const status = async (id: string) => (await owner.query(
  "SELECT status, failure_code, paused_from FROM migrations WHERE id=$1", [id])).rows[0];
const lastJob = async (id: string, q: string) => (await owner.query(
  `SELECT id, state, retry_count FROM pgboss.job WHERE name=$2 AND data->>'migrationId'=$1 ORDER BY created_on DESC LIMIT 1`,
  [id, q])).rows[0] as { id: string; state: string; retry_count: number } | undefined;
const auditCounts = async (id: string) => Object.fromEntries((await owner.query(
  `SELECT action, count(*)::int n FROM audit_events WHERE target=$1 GROUP BY action`, [id]))
  .rows.map((r) => [r.action, r.n]));
const locks = async (id: string) => (await owner.query(
  "SELECT holder, lease_expires_at > now() AS live FROM env_locks WHERE migration_id=$1 ORDER BY env_id", [id])).rows;
const expireLocks = (id: string) => owner.query(
  "UPDATE env_locks SET lease_expires_at = now() - interval '1 second' WHERE migration_id=$1", [id]);

test("deploy 도중 SIGKILL → 잠금 만료 → 청소가 paused(WORKER_LOST) → 다른 워커는 안 이어받음 → 롤백으로만 빠져나옴", { timeout: 300_000 }, async () => {
  const w1 = worker("z12-w1");
  await waitOut(w1, /worker ready/);
  const m = await seedProvisioning();
  await until(async () => (await lastJob(m.id, "deploy"))?.state === "active", 20_000);
  await sleep(300);
  const held = await locks(m.id);
  assert.ok(held.every((l) => l.holder.startsWith("worker:") && l.live), `일하는 동안 잠금 주인: ${JSON.stringify(held)}`);
  w1.child.kill("SIGKILL"); const tKill = Date.now();
  await w1.exited;

  const w2 = worker("z12-w2");
  await waitOut(w2, /worker ready/);
  await sleep(3000);
  assert.equal((await status(m.id)).status, "deploying", "기한 전에는 아무도 손 안 댐");

  if (!REAL) { await expireLocks(m.id); await reaper.reapOnce(); }
  // REAL: w2의 청소 작업(매분)이 잠금 기한(90초) 지난 뒤 처리할 때까지 기다린다
  await until(async () => (await status(m.id)).status === "paused", REAL ? 200_000 : 5_000, 200);
  const pausedMs = Date.now() - tKill;
  console.log(`[z12] crash-deploy(${REAL ? "real time" : "lease backdated"}): kill→paused ${pausedMs} ms`);
  const s = await status(m.id);
  assert.equal(s.failure_code, "WORKER_LOST"); assert.equal(s.paused_from, "deploying");
  // 【Z12-4 고침, Z36】 잠금 줄에 job_id가 적혀 청소가 죽은 작업을 바로 실패 처리 → active로 15분 안 남는다.
  // deploy 큐는 재시도가 남아 있어(Z19: 2번·10초) failed가 아니라 retry로 간다 → w2가 집지만 paused라 job.rejected
  const dj = (await lastJob(m.id, "deploy"))!;
  assert.notEqual(dj.state, "active", `Z12-4: 죽은 워커의 작업이 active로 남으면 안 된다 (지금 ${dj.state})`);
  assert.equal((await locks(m.id)).length, 2, "paused는 잠금 유지");

  // 다른 워커가 이어받나? → 5초 동안 그대로 (재시도 작업은 paused라 no-op)
  await sleep(5000);
  assert.equal((await status(m.id)).status, "paused", "자동 이어받기 없음");
  // 재시도 대기(10초)를 당겨 바로 집히게
  await owner.query("UPDATE pgboss.job SET start_after = now() WHERE id=$1 AND state='retry'", [dj.id]);
  await until(async () => ((await auditCounts(m.id))["job.rejected"] ?? 0) >= 1, 30_000, 100).catch(async (e) => {
    console.log(`[z12] job after supervise: ${JSON.stringify(await lastJob(m.id, "deploy"))}, w2 tail: ${w2.out.slice(-4).join(" | ")}`);
    throw e;
  });
  assert.equal((await status(m.id)).status, "paused", "재시도된 작업도 no-op");

  // 사람이 할 수 있는 것: 롤백 (재개 API는 없다 → Z12-3). control.ts의 롤백 경로와 같은 advance 호출
  const tRb = Date.now();
  await core.withTenant(T, (tx) => core.advance(tx, { id: m.id, tenantId: T }, "paused", "rolling_back", {
    evidence: { reason: "z12 recover" },
    next: { queue: "rollback", data: { tenantId: T, requestId: "z12-rb", migrationId: m.id }, opts: { singletonKey: `rollback:${m.id}` } },
    audit: { actor: "user:z12", action: "migration.rolling_back", target: m.id, result: "ok" } }));
  await until(async () => (await status(m.id)).status === "rolled_back", 20_000, 100);
  const rbMs = Date.now() - tRb;
  assert.equal((await locks(m.id)).length, 0, "rolled_back에서 잠금 해제");
  const a = await auditCounts(m.id);
  assert.equal(a["deploy.syncing"], undefined, "죽은 워커의 deploy는 흔적 없음");
  assert.equal(a["migration.paused"], 1); assert.equal(a["rollback.rolled_back"], 1); assert.equal(a["job.rejected"], 1);
  console.log(`[z12] crash-deploy(${REAL ? "real time" : "lease backdated"}): kill→paused ${pausedMs} ms, rollback→rolled_back ${rbMs} ms, audit ${JSON.stringify(a)}`);
  await stopProc(w2);
});

test("apply 도중 SIGKILL → 잠금 만료 → 청소가 failed(WORKER_LOST) + 잠금 해제(Z1 이른 실패) → 같은 환경 다시 예약 가능", { timeout: 60_000 }, async () => {
  const w1 = worker("z12-w3");
  await waitOut(w1, /worker ready/);
  const m = await seedProvisioning();
  await until(async () => (await lastJob(m.id, "apply"))?.state === "active", 10_000);
  await sleep(300);
  w1.child.kill("SIGKILL"); await w1.exited;
  await expireLocks(m.id);
  await reaper.reapOnce();
  const s = await status(m.id);
  assert.equal(s.status, "failed"); assert.equal(s.failure_code, "WORKER_LOST");
  assert.equal((await locks(m.id)).length, 0);
  assert.equal((await lastJob(m.id, "apply"))!.state, "failed", "Z12-4 고침: 죽은 워커의 apply 작업이 바로 failed (apply 재시도 0)");
  console.log(`[z12] crash-apply: failed/${s.failure_code}, locks released`);
});

test("SIGTERM(정상 종료) 도중의 작업: graceful stop이 작업 끝까지 기다림", { timeout: 60_000 }, async () => {
  const w1 = worker("z12-w5");
  await waitOut(w1, /worker ready/);
  const m = await seedProvisioning();
  await until(async () => (await lastJob(m.id, "apply"))?.state === "active", 10_000);
  const t0 = Date.now();
  w1.child.kill("SIGTERM");
  const code = await w1.exited;
  const ms = Date.now() - t0;
  const s = (await status(m.id)).status;
  const j = await lastJob(m.id, "apply");
  const l = await locks(m.id);
  console.log(`[z12] sigterm: exit=${code} after ${ms} ms, migration=${s}, apply job=${j?.state}, locks=${l.map((x) => x.holder).join(",")}`);
  assert.equal(code, 0);
  assert.equal(s, "deploying");
  assert.equal(j?.state, "completed");
  assert.ok(l.every((x) => x.holder === "reserved"), "반납 완료");
});

test("【Z12-2 고침, Z36】 같은 호스트에 워커 2개(같은 지표 포트) → 두 번째는 다음 포트로 열고 산다", { timeout: 60_000 }, async () => {
  const a = worker("z12-p1", { WORKER_METRICS_PORT: "19465" });
  await waitOut(a, /worker ready/);
  const b = worker("z12-p2", { WORKER_METRICS_PORT: "19465" });
  await waitOut(b, /worker ready/);
  await sleep(2000);
  assert.equal(b.child.exitCode, null, "두 번째 워커가 살아 있다");
  assert.ok(b.out.some((l) => /metrics port in use/.test(l)));
  assert.ok(b.out.some((l) => /"metrics_port":19466/.test(l)), b.out.slice(-3).join(" | "));
  const r = await fetch("http://127.0.0.1:19466/metrics");
  assert.equal(r.status, 200);
  console.log(`[z36] second worker same port: alive, metrics on 19466`);
  await stopProc(a); await stopProc(b);
});
