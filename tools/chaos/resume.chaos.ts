// 장애 시험(작업 Z36) 재개: 진짜 API·워커 프로세스로 "멈춤 → POST .../resume → completed"
//  (A) 어댑터 실패: 워커 STUB_FAIL_STEP=deploy → 재시도 소진 → paused(JOB_FAILED_DEPLOY) → 재개 → completed
//  (B) 워커 SIGKILL(deploy 중) → 청소 → paused(WORKER_LOST) → 새 워커 + 재개 → completed
// 실행: node --env-file=.env --import tsx --test --test-concurrency=1 tools/chaos/resume.chaos.ts
// 기다리는 시간(재시도 대기 10초, 잠금 90초)은 DB 시각을 당긴다. 상태 이동·잠금·큐는 전부 진짜 코드
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { startProc, waitOut, until, sleep, ownerClient, stopProc, type Proc } from "./_proc.js";

const T = randomUUID();
const PORT = Number(process.env.CHAOS_API_PORT ?? 3918);
const API = `http://127.0.0.1:${PORT}/api/v1`;
const H = { "content-type": "application/json", "x-dev-tenant": T };
const ENV = { API_PORT: String(PORT), STUB_DELAY_MS: "600", ROLLBACK_WINDOW_SEC: "1" };
let owner: pg.Client;
let core: typeof import("@svc/core");
let reaper: typeof import("../../apps/worker/src/lease/reaper.js");
let api: Proc;
const procs: Proc[] = [];

before(async () => {
  core = await import("@svc/core");
  reaper = await import("../../apps/worker/src/lease/reaper.js");
  owner = ownerClient(); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z36-resume')", [T]);
  await core.startBoss();
  api = startProc("z36-api", "apps/api/src/main.ts", ENV);
  await until(async () => (await fetch(`http://127.0.0.1:${PORT}/readyz`).catch(() => null))?.ok, 30_000, 200);
});
after(async () => {
  await stopProc(api); for (const p of procs) await stopProc(p);
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]).catch(() => {});
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end().catch(() => {});
});

const worker = (name: string, env: Record<string, string> = {}) => { const p = startProc(name, "apps/worker/src/main.ts", { ...ENV, ...env }); procs.push(p); return p; };
async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { ...H, ...extra },
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
  const j = await r.json() as Record<string, unknown>;
  if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const row = async (id: string) => (await owner.query("SELECT status, failure_code, paused_from FROM migrations WHERE id=$1", [id])).rows[0];
const auditCounts = async (id: string) => Object.fromEntries((await owner.query(
  `SELECT action, count(*)::int n FROM audit_events WHERE target=$1 GROUP BY action`, [id])).rows.map((r) => [r.action, r.n]));
// pg-boss 재시도 대기를 당긴다 (deploy 큐: 10초)
const hurryRetries = (id: string) => owner.query(
  "UPDATE pgboss.job SET start_after = now() WHERE data->>'migrationId'=$1 AND state IN ('retry','created') AND start_after > now()", [id]);

async function newMigration() {
  const src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  const { id } = await call("POST", "/migrations", { sourceEnvId: src, targetEnvId: dst }) as { id: string };
  await until(async () => (await row(id)).status === "spec_review", 30_000, 100);
  await call("POST", `/migrations/${id}/plan`);
  await until(async () => (await row(id)).status === "awaiting_approval", 30_000, 100);
  const plan = await call("GET", `/migrations/${id}/plan`) as { planId: string; planHash: string };
  await call("POST", `/plans/${plan.planId}/approvals`, { decision: "approve", planHash: plan.planHash });
  await until(async () => (await row(id)).status === "approved", 10_000, 100);
  await call("POST", `/migrations/${id}/start`);
  return id;
}

test("(A) 어댑터 실패(STUB_FAIL_STEP=deploy) → 재시도 3번 → paused(JOB_FAILED_DEPLOY) → 재개 → completed", { timeout: 120_000 }, async () => {
  const w = worker("z36-wa", { STUB_FAIL_STEP: "deploy" });
  await waitOut(w, /worker ready/);
  const id = await newMigration();
  const t0 = Date.now();
  await until(async () => { await hurryRetries(id); return (await row(id)).status === "paused"; }, 60_000, 200);
  const tPaused = Date.now() - t0;
  assert.deepEqual(await row(id), { status: "paused", failure_code: "JOB_FAILED_DEPLOY", paused_from: "deploying" });
  const a0 = await auditCounts(id);
  assert.equal(a0["job.failed"], 3, `deploy 3번 실행(첫 시도 + 재시도 2) 모두 job.failed: ${JSON.stringify(a0)}`);
  const t1 = Date.now();
  const r = await call("POST", `/migrations/${id}/resume`, { reason: "argo fixed" }, { "idempotency-key": `z36-a-${id}` });
  assert.equal(r.status, "deploying");
  await until(async () => (await row(id)).status === "completed", 60_000, 100);
  const tDone = Date.now() - t1;
  const a = await auditCounts(id);
  assert.equal(a["migration.resumed"], 1); assert.equal(a["deploy.syncing"], 1); assert.equal(a["cleanup.completed"], 1);
  assert.equal((await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [id])).rows[0].n, 0);
  console.log(`[z36] A: start→paused ${tPaused} ms (retry waits pulled), resume→completed ${tDone} ms`);
  await stopProc(w);
});

test("(B) deploy 중 워커 SIGKILL → 청소 paused(WORKER_LOST), 죽은 작업은 active로 안 남음 → 새 워커 + 재개 → completed", { timeout: 120_000 }, async () => {
  const w1 = worker("z36-wb1", { STUB_DELAY_MS: "2500" });
  await waitOut(w1, /worker ready/);
  const id = await newMigration();
  await until(async () => (await owner.query(
    "SELECT 1 FROM pgboss.job WHERE name='deploy' AND data->>'migrationId'=$1 AND state='active'", [id])).rowCount, 30_000, 100);
  await sleep(300);
  const held = (await owner.query("SELECT holder, job_id FROM env_locks WHERE migration_id=$1", [id])).rows;
  assert.ok(held.every((l) => l.holder.startsWith("worker:") && l.job_id), `잠금 줄에 작업 id: ${JSON.stringify(held)}`);
  w1.child.kill("SIGKILL"); await w1.exited;
  await owner.query("UPDATE env_locks SET lease_expires_at = now() - interval '1 second' WHERE migration_id=$1", [id]);
  await reaper.reapOnce();
  assert.deepEqual(await row(id), { status: "paused", failure_code: "WORKER_LOST", paused_from: "deploying" });
  const dead = (await owner.query("SELECT state FROM pgboss.job WHERE id=$1", [held[0].job_id])).rows[0];
  assert.notEqual(dead.state, "active", "Z12-4: 청소가 죽은 작업을 실패(재시도) 처리");

  const w2 = worker("z36-wb2");
  await waitOut(w2, /worker ready/);
  const t1 = Date.now();
  const r = await call("POST", `/migrations/${id}/resume`);
  assert.equal(r.status, "deploying");
  await until(async () => { await hurryRetries(id); return (await row(id)).status === "completed"; }, 60_000, 100);
  const tDone = Date.now() - t1;
  const a = await auditCounts(id);
  assert.equal(a["deploy.syncing"], 1, `deploy 전이는 한 번만: ${JSON.stringify(a)}`);
  console.log(`[z36] B: kill→paused(WORKER_LOST) via reaper, resume→completed ${tDone} ms, audit ${JSON.stringify(a)}`);
  await stopProc(w2);
});
