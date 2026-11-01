// 장애 시험(작업 Z12) 시나리오 2-B: 진짜 API·워커 프로세스가 돌 때 DB 연결이 끊기면
//  (A) 그 프로세스들의 DB 연결을 전부 강제로 끊기 3번 (단계 deploying / shifting / rollback_window 에서)
//  (B) Postgres 자체를 몇 초 멈췄다 다시 켜기 (CHAOS_PG_STOP·CHAOS_PG_START 명령이 있을 때만)
// 기대: 프로세스 생존, /readyz 회복, 이전이 completed까지 감, 전이 중복 0.
// 실행: node --env-file=.env --import tsx --test --test-concurrency=1 tools/chaos/db-blip.chaos.ts
//  맥(도커):   CHAOS_PG_STOP="docker compose stop db" CHAOS_PG_START="docker compose start db" 를 앞에 붙인다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type pg from "pg";
import { startProc, waitOut, until, sleep, ownerClient, stopProc, killBackends, ROOT, type Proc } from "./_proc.js";

const T = randomUUID();
const PORT = Number(process.env.CHAOS_API_PORT ?? 3917);
const API = `http://127.0.0.1:${PORT}/api/v1`;
const H = { "content-type": "application/json", "x-dev-tenant": T };
let owner: pg.Client;
let api: Proc, wk: Proc;

before(async () => {
  owner = ownerClient(); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z12-blip')", [T]);
  const env = { API_PORT: String(PORT), STUB_DELAY_MS: "600", ROLLBACK_WINDOW_SEC: "1" };
  api = startProc("z12-api", "apps/api/src/main.ts", env);
  wk = startProc("z12-wk", "apps/worker/src/main.ts", env);
  await waitOut(wk, /worker ready/);
  await until(async () => (await fetch(`http://127.0.0.1:${PORT}/readyz`).catch(() => null))?.ok, 30_000, 200);
});
after(async () => {
  await stopProc(api); await stopProc(wk);
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]).catch(() => {});
  await owner.end().catch(() => {});
});

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, { method, headers: H,
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
  const j = await r.json() as Record<string, unknown>;
  if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(j)}`);
  return j;
}
// DB가 잠깐 없을 때도 시험은 계속 묻는다 (오류면 null)
const statusOf = async (id: string) => {
  try { return ((await call("GET", `/migrations/${id}`)) as { status: string }).status; } catch { return null; }
};

async function newMigration() {
  const src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  const { id } = await call("POST", "/migrations", { sourceEnvId: src, targetEnvId: dst }) as { id: string };
  await until(async () => (await statusOf(id)) === "spec_review", 30_000, 100);
  await call("POST", `/migrations/${id}/plan`);
  await until(async () => (await statusOf(id)) === "awaiting_approval", 30_000, 100);
  const plan = await call("GET", `/migrations/${id}/plan`) as { planId: string; planHash: string };
  await call("POST", `/plans/${plan.planId}/approvals`, { decision: "approve", planHash: plan.planHash });
  await until(async () => (await statusOf(id)) === "approved", 10_000, 100);
  await call("POST", `/migrations/${id}/start`);
  return id;
}

const STEP_ACTIONS = ["apply.deploying", "deploy.syncing", "sync.shifting", "shift.cutover",
  "cutover.rollback_window", "cleanup.cleanup", "cleanup.completed"];
async function assertNoDup(id: string) {
  const a = Object.fromEntries((await owner.query(
    `SELECT action, count(*)::int n FROM audit_events WHERE target=$1 GROUP BY action`, [id])).rows.map((r) => [r.action, r.n]));
  for (const act of STEP_ACTIONS) assert.equal(a[act], 1, `${act}=${a[act]} ${JSON.stringify(a)}`);
  return a;
}

test("(A) 진행 중 API·워커 DB 연결 전부 강제 끊기 ×3 → 생존·completed·중복 0", { timeout: 120_000 }, async () => {
  const id = await newMigration();
  const t0 = Date.now();
  const kills: string[] = [];
  for (const at of ["deploying", "shifting", "rollback_window"]) {
    const seen = await until(async () => { const s = await statusOf(id); return s === at || s === "completed" ? s : null; }, 60_000, 20);
    if (seen === "completed") { kills.push(`${at}:missed`); continue; }
    const n = await killBackends(owner, "z12-");
    kills.push(`${at}:${n}conns`);
  }
  await until(async () => (await statusOf(id)) === "completed", 90_000, 100);
  const ms = Date.now() - t0;
  assert.equal(api.child.exitCode, null, `api 죽음: ${api.out.slice(-5).join("\n")}`);
  assert.equal(wk.child.exitCode, null, `worker 죽음: ${wk.out.slice(-5).join("\n")}`);
  assert.ok((await fetch(`http://127.0.0.1:${PORT}/readyz`)).ok);
  const a = await assertNoDup(id);
  const errLines = [...api.out, ...wk.out].filter((l) => /error|terminat/i.test(l)).length;
  console.log(`[z12] blip-A kills=${kills.join(",")} completed in ${ms} ms, error log lines=${errLines}, rejected=${a["job.rejected"] ?? 0}`);
});

const STOP = process.env.CHAOS_PG_STOP, START = process.env.CHAOS_PG_START;
const DOWN_MS = Number(process.env.CHAOS_PG_DOWN_MS ?? 5000);   // 멈춰 둘 시간
test(`(B) Postgres 정지 ${DOWN_MS / 1000}초 → 재시작: 프로세스 생존, readyz 회복 시간, 이전 completed`, {
  timeout: 180_000, skip: !STOP || !START ? "CHAOS_PG_STOP / CHAOS_PG_START 없음" : false }, async () => {
  const id = await newMigration();
  await until(async () => (await statusOf(id)) === "syncing", 30_000, 20);
  await owner.end();                                   // 시험 쪽 연결도 끊길 것이므로 먼저 닫는다
  const tStop = Date.now();
  execSync(STOP!, { cwd: ROOT, stdio: "ignore" });
  const downProbe = await fetch(`http://127.0.0.1:${PORT}/readyz`).then((r) => r.status, () => -1);
  await sleep(DOWN_MS);
  assert.equal(api.child.exitCode, null, `DB 없는 동안 api 죽음: ${api.out.slice(-8).join("\n")}`);
  assert.equal(wk.child.exitCode, null, `DB 없는 동안 worker 죽음: ${wk.out.slice(-8).join("\n")}`);
  execSync(START!, { cwd: ROOT, stdio: "ignore" });
  const tStart = Date.now();
  await until(async () => (await fetch(`http://127.0.0.1:${PORT}/readyz`).catch(() => null))?.ok, 60_000, 100);
  const readyMs = Date.now() - tStart;
  owner = ownerClient(); await owner.connect();
  const final = await until(async () => { const s = await statusOf(id); return s === "completed" ? s : null; }, 60_000, 200)
    .catch(async () => `stuck:${await statusOf(id)}`);
  if (final !== "completed") {
    const jobs = (await owner.query(`SELECT name, state, retry_count, output->>'message' AS msg FROM pgboss.job WHERE data->>'migrationId'=$1 ORDER BY created_on`, [id])).rows;
    console.log(`[z12] blip-B ${final}; jobs=${JSON.stringify(jobs)}; worker log tail:\n${wk.out.slice(-6).join("\n")}`);
  }
  assert.equal(final, "completed");
  const doneMs = Date.now() - tStart;
  assert.equal(api.child.exitCode, null); assert.equal(wk.child.exitCode, null);
  await assertNoDup(id);
  console.log(`[z12] blip-B readyz while down=${downProbe}, down ${tStart - tStop} ms, readyz back ${readyMs} ms after start, completed ${doneMs} ms after start`);
});
