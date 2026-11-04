// DB 시험 (PA5a, 계획 26 · A5a): advance() analyze 옵션 — 실패 전이와 실패 원인 분석을 한 트랜잭션에, 분석이 못 들어가도 전이는 확정
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL;
const OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

type Core = typeof import("../src/index.js");
let core: Core;
let owner: pg.Client;
const T = randomUUID(), S = randomUUID(), G = randomUUID();
const ENV_KEYS = ["FAILURE_ANALYSIS", "FAKE_LLM", "AGENT_LLM_KEY_SET", "LLM_BUDGET_USD", "ANTHROPIC_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

before(async () => {
  if (skip) return;
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-pa5a-analyze')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  for (const k of ENV_KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  await core.boss.stop({ graceful: false });
  await core.pool.end();
  await owner.end();
});

function env(o: Partial<Record<typeof ENV_KEYS[number], string | undefined>>) {
  for (const k of ENV_KEYS) {
    const v = k in o ? o[k] : saved[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
async function migrationAt(status: string) {
  const id = randomUUID();
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, T, S, G, status]);
  return id;
}
const fail = (id: string, o: { analyze?: boolean; actor?: string } = {}) => core.withTenant(T, (tx) =>
  core.advance(tx, { id, tenantId: T }, "provisioning", "failed", {
    mode: "ifStill", failureCode: "APPLY_FAILED", analyze: o.analyze ?? true,
    audit: { actor: o.actor ?? "worker", action: "apply.failed", target: id, result: "error" } }));
const runs = async (id: string) => (await owner.query(
  "SELECT kind, status, task FROM agent_runs WHERE migration_id=$1", [id])).rows;
const faJobs = async (id: string) => (await owner.query(
  "SELECT data FROM pgboss.job WHERE name='agent-run' AND singleton_key LIKE $1", [`agent-run:fa:${id}:%`])).rows;
const audits = async (id: string, action: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND action=$2", [id, action])).rows;
const statusOf = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status;

test("정상: 깃발 on + apply 실패 → failed 확정 + 분석 1줄 + 작업 1개 + 감사", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  const id = await migrationAt("provisioning");
  assert.equal(await fail(id), true);
  assert.equal(await statusOf(id), "failed");
  const r = await runs(id);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "failure_analysis");
  assert.equal(r[0].status, "queued");
  assert.match(r[0].task, /APPLY_FAILED/);
  const j = await faJobs(id);
  assert.equal(j.length, 1);
  assert.equal(j[0].data.tenantId, T);
  assert.equal((await audits(id, "agent.failure_analysis.requested")).length, 1);
});

test("정상: 트랜잭션이 취소되면 분석·작업도 0 (같은 트랜잭션)", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  const id = await migrationAt("provisioning");
  await assert.rejects(core.withTenant(T, async (tx) => {
    await core.advance(tx, { id, tenantId: T }, "provisioning", "failed", {
      failureCode: "APPLY_FAILED", analyze: true, audit: { actor: "worker", action: "apply.failed", target: id, result: "error" } });
    throw new Error("boom");
  }), /boom/);
  assert.equal(await statusOf(id), "provisioning");
  assert.equal((await runs(id)).length, 0);
  assert.equal((await faJobs(id)).length, 0);
});

test("정상: 지출 상한 초과 → failed 는 확정, 분석 0, failure_analysis.skipped 감사", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: undefined, ANTHROPIC_API_KEY: undefined, AGENT_LLM_KEY_SET: "1", LLM_BUDGET_USD: "0" });
  const id = await migrationAt("provisioning");
  assert.equal(await fail(id), true);
  assert.equal(await statusOf(id), "failed");
  assert.equal((await runs(id)).length, 0);
  assert.equal((await faJobs(id)).length, 0);
  const sk = await audits(id, "failure_analysis.skipped");
  assert.equal(sk.length, 1);
  assert.equal(sk[0].detail.reason, "budget_exceeded");
});

test("정상: 키 없음 → 건너뜀(llm_key_missing), 전이는 확정", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: undefined, ANTHROPIC_API_KEY: undefined, AGENT_LLM_KEY_SET: undefined });
  const id = await migrationAt("provisioning");
  assert.equal(await fail(id), true);
  assert.equal(await statusOf(id), "failed");
  assert.equal((await audits(id, "failure_analysis.skipped"))[0].detail.reason, "llm_key_missing");
});

test("거부: 같은 실패로 두 번(리퍼 + 워커) → 분석 1개", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  const id = await migrationAt("provisioning");
  const [a, b] = await Promise.all([fail(id, { actor: "lease-reaper" }), fail(id, { actor: "worker" })]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal((await runs(id)).length, 1);
  assert.equal((await faJobs(id)).length, 1);
});

test("거부: 이미 분석 중이면 새 실패에도 건너뜀(busy) — paused 도 분석 대상", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  const id = await migrationAt("deploying");
  const pause = () => core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "deploying", "paused", {
    failureCode: "JOB_FAILED_DEPLOY", analyze: true, audit: { actor: "worker", action: "deploy.paused", target: id, result: "error" } }));
  assert.equal(await pause(), true);
  await owner.query("UPDATE migrations SET status='deploying' WHERE id=$1", [id]);   // 시험용: 재개한 것처럼
  assert.equal(await pause(), true);
  assert.equal((await runs(id)).length, 1);
  assert.equal((await audits(id, "failure_analysis.skipped"))[0].detail.reason, "busy");
});

test("깃발 off(FAILURE_ANALYSIS=0)·analyze:false → 분석 안 넣음, 감사도 없음 (G5-1 뒤 기본은 켬)", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "0", FAKE_LLM: "1" });
  const off = await migrationAt("provisioning");
  assert.equal(await fail(off), true);
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  const noOpt = await migrationAt("provisioning");
  assert.equal(await fail(noOpt, { analyze: false }), true);
  for (const id of [off, noOpt]) {
    assert.equal((await runs(id)).length, 0);
    assert.equal((await audits(id, "failure_analysis.skipped")).length, 0);
  }
});
