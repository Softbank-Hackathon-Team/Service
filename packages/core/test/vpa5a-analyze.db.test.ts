// 검증 PA5a: analyze 의 조건 경계(깃발 값·failureCode·to 상태)와 분석이 못 들어가는 모든 길(error·budget_config)에서 전이는 확정
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vpa5a-analyze')", [T]);
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


const strictFail = (id: string, o: { analyze?: boolean; failureCode?: string } = {}) => core.withTenant(T, (tx) =>
  core.advance(tx, { id, tenantId: T }, "provisioning", "failed", {
    ...(o.failureCode === undefined ? { failureCode: "APPLY_FAILED" } : o.failureCode ? { failureCode: o.failureCode } : {}),
    analyze: o.analyze ?? true, audit: { actor: "worker", action: "apply.failed", target: id, result: "error" } }));

test("깃발 값 경계: '1' 만 켜짐 — 0·true·빈 값·없음은 분석 0, 감사도 0", { skip }, async () => {
  for (const v of ["0", "true", "", " 1", undefined]) {
    env({ FAILURE_ANALYSIS: v, FAKE_LLM: "1" });
    const id = await migrationAt("provisioning");
    await strictFail(id);
    assert.equal(await statusOf(id), "failed", `FAILURE_ANALYSIS=${JSON.stringify(v)}`);
    assert.equal((await runs(id)).length, 0, `FAILURE_ANALYSIS=${JSON.stringify(v)}`);
    assert.equal((await audits(id, "agent.failure_analysis.requested")).length + (await audits(id, "failure_analysis.skipped")).length, 0);
  }
});

test("실패 코드 없음(→ paused 가드레일 규칙) · failed/paused 가 아닌 이동 → 분석 0", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  const a = await migrationAt("shifting");
  await core.withTenant(T, (tx) => core.advance(tx, { id: a, tenantId: T }, "shifting", "paused",
    { evidence: { guardrailRule: "MG-3-02" }, analyze: true, audit: { actor: "worker", action: "guardrail.pause", target: a, result: "ok" } }));
  assert.equal(await statusOf(a), "paused");
  assert.equal((await runs(a)).length, 0, "규칙 멈춤은 실패가 아님");
  const b = await migrationAt("provisioning");
  await core.withTenant(T, (tx) => core.advance(tx, { id: b, tenantId: T }, "provisioning", "deploying",
    { evidence: { applyOk: true }, analyze: true, failureCode: "IGNORED", audit: { actor: "worker", action: "apply.ok", target: b, result: "ok" } }));
  assert.equal(await statusOf(b), "deploying");
  assert.equal((await runs(b)).length, 0, "failed·paused 로 가는 이동만");
});

test("분석 넣기가 DB 오류로 깨져도(SAVEPOINT) failed 는 확정, 줄·작업은 0, 감사 skipped(error)", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  const id = await migrationAt("provisioning");
  // 이 파일의 격리 DB 에서만: 새 agent_runs 줄을 전부 거부하는 제약. 시험 끝에 지운다
  await owner.query("ALTER TABLE agent_runs ADD CONSTRAINT vpa5a_boom CHECK (false) NOT VALID");
  try {
    assert.equal(await strictFail(id), true);
  } finally { await owner.query("ALTER TABLE agent_runs DROP CONSTRAINT vpa5a_boom"); }
  assert.equal(await statusOf(id), "failed", "분석 오류가 실패 전이를 막지 않음");
  assert.equal((await runs(id)).length, 0);
  assert.equal((await faJobs(id)).length, 0, "SAVEPOINT 로 작업도 되돌아감");
  const sk = await audits(id, "failure_analysis.skipped");
  assert.equal(sk.length, 1); assert.equal(sk[0].detail.reason, "error");
  assert.equal((await audits(id, "apply.failed")).length, 1, "본 감사는 그대로");
});

test("지출 설정이 틀리면(LLM_BUDGET_USD=abc, 실제 키 모드) 건너뜀 budget_config, 전이는 확정", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: undefined, ANTHROPIC_API_KEY: "sk-test-not-real", LLM_BUDGET_USD: "abc" });
  const id = await migrationAt("provisioning");
  await strictFail(id);
  assert.equal(await statusOf(id), "failed");
  assert.equal((await runs(id)).length, 0);
  const sk = await audits(id, "failure_analysis.skipped");
  assert.equal(sk.length, 1);
  assert.match(String(sk[0].detail.reason), /budget_config|llm_key_missing/);
});

test("분석 task 글에는 상태·코드 이름만 — 비밀처럼 보이는 값이 안 들어간다, 분석 줄의 회사는 이전의 회사", { skip }, async () => {
  env({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  const id = await migrationAt("provisioning");
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "provisioning", "failed",
    { failureCode: "APPLY_FAILED", analyze: true, evidence: { applyOk: false },
      audit: { actor: "worker", action: "apply.failed", target: id, result: "error", detail: { stderr: "AKIA-SECRET-LEAK token=abc" } } }));
  const r = (await owner.query("SELECT task, tenant_id FROM agent_runs WHERE migration_id=$1", [id])).rows;
  assert.equal(r.length, 1);
  assert.ok(!r[0].task.includes("AKIA-SECRET-LEAK") && !r[0].task.includes("token="));
  assert.equal(r[0].tenant_id, T);
});
