// 검증 묶음 VPA5a: advance() analyze 경계 — 분석이 어떤 이유로 못 들어가도 전이는 확정, 새 실패(새 version)는 새 분석
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
type Core = typeof import("../src/index.js");
let core: Core;
let owner: pg.Client;
const T = randomUUID(), S = randomUUID(), G = randomUUID();
const KEYS = ["FAILURE_ANALYSIS", "FAKE_LLM", "AGENT_LLM_KEY_SET", "LLM_BUDGET_USD", "ANTHROPIC_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const setEnv = (o: Partial<Record<typeof KEYS[number], string | undefined>>) => {
  for (const k of KEYS) { const v = k in o ? o[k] : saved[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

before(async () => {
  if (skip) return;
  for (const k of KEYS) saved[k] = process.env[k];
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vpa5a-analyze')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  setEnv({});
  await owner.query("DROP TRIGGER IF EXISTS boom ON agent_runs");
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

const mig = async (status: string) => {
  const id = randomUUID();
  await owner.query("INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)", [id, T, S, G, status]);
  return id;
};
const adv = (id: string, from: string, to: string, o: { code?: string; analyze?: boolean } = {}) => core.withTenant(T, (tx) =>
  core.advance(tx, { id, tenantId: T }, from as never, to as never, {
    ...(o.code ? { failureCode: o.code } : {}), ...(o.analyze === false ? { analyze: false } : { analyze: true }),
    audit: { actor: "worker", action: `t.${to}`, target: id, result: "ok" } }));
const runs = async (id: string) => (await owner.query("SELECT id, status FROM agent_runs WHERE migration_id=$1 ORDER BY created_at", [id])).rows;
const audits = async (id: string, a: string) => (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action=$2", [id, a])).rows;
const statusOf = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status as string;

test("분석 대상 아님: failureCode 없음 / analyze:false / 깃발 '0' / failed·paused 가 아닌 전이", { skip }, async () => {
  setEnv({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  // failureCode 없이 failed (advance 가 UNSPECIFIED 로 채우지만 분석은 부르는 쪽 코드가 있어야)
  const a = await mig("provisioning"); await adv(a, "provisioning", "failed");
  assert.equal((await runs(a)).length, 0); assert.equal((await audits(a, "failure_analysis.skipped")).length, 0);
  // analyze 옵션 없음
  const b = await mig("provisioning"); await adv(b, "provisioning", "failed", { code: "X", analyze: false });
  assert.equal((await runs(b)).length, 0);
  // G5-1: 깃발 기본 켬, "0" 일 때만 끔
  setEnv({ FAILURE_ANALYSIS: "0", FAKE_LLM: "1" });
  const c = await mig("provisioning"); await adv(c, "provisioning", "failed", { code: "X" });
  assert.equal((await runs(c)).length, 0);
  // 정상 전이(failed·paused 아님)
  setEnv({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  const d = await mig("planning"); await adv(d, "planning", "cancelled", { code: "X" });
  assert.equal((await runs(d)).length, 0);
});

test("새 실패 = 새 version: 앞 분석이 끝났으면(finished) 다시 실패했을 때 새 분석이 들어간다", { skip }, async () => {
  setEnv({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  const id = await mig("provisioning");
  await adv(id, "provisioning", "failed", { code: "APPLY_FAILED" });
  const first = await runs(id); assert.equal(first.length, 1);
  await owner.query("UPDATE agent_runs SET status='finished' WHERE id=$1", [first[0].id]);
  await adv(id, "failed", "prechecking", { analyze: false });   // G7-2: 다시 계획 = 점검부터
  await owner.query("UPDATE migrations SET status='provisioning' WHERE id=$1", [id]);
  await adv(id, "provisioning", "failed", { code: "APPLY_FAILED" });
  const all = await runs(id);
  assert.equal(all.length, 2);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name='agent-run' AND singleton_key LIKE $1", [`agent-run:fa:${id}:%`])).rows[0].n, 2);
});

test("분석 INSERT 가 DB 오류로 깨져도 전이·감사는 확정되고 failure_analysis.skipped(error) 가 남는다 (SAVEPOINT)", { skip }, async () => {
  setEnv({ FAILURE_ANALYSIS: "1", FAKE_LLM: "1" });
  await owner.query(`CREATE OR REPLACE FUNCTION boom_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`);
  await owner.query("CREATE TRIGGER boom BEFORE INSERT ON agent_runs FOR EACH ROW EXECUTE FUNCTION boom_fn()");
  try {
    const id = await mig("provisioning");
    assert.equal(await adv(id, "provisioning", "failed", { code: "APPLY_FAILED" }), true);
    assert.equal(await statusOf(id), "failed");
    assert.equal((await runs(id)).length, 0);
    assert.equal((await audits(id, "t.failed")).length, 1);
    assert.equal((await audits(id, "failure_analysis.skipped"))[0].detail.reason, "error");
    // 작업도 안 남는다 (SAVEPOINT 로 같이 되돌림)
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name='agent-run' AND singleton_key LIKE $1", [`agent-run:fa:${id}:%`])).rows[0].n, 0);
  } finally {
    await owner.query("DROP TRIGGER IF EXISTS boom ON agent_runs");
  }
});

test("queueAgentRun 경계: 지출 설정이 틀리면 budget_config, 같은 작업 키가 이미 있으면 job_not_created(줄 안 남김)", { skip }, async () => {
  const id = await mig("failed");
  setEnv({ FAKE_LLM: undefined, ANTHROPIC_API_KEY: undefined, AGENT_LLM_KEY_SET: "1", LLM_BUDGET_USD: "not-a-number" });
  const r1 = await core.withTenant(T, (tx) => core.queueAgentRun(tx, { tenantId: T, migrationId: id, requestId: randomUUID(), kind: "failure_analysis", task: "t", checkLlm: true }));
  assert.deepEqual(r1, { skipped: "budget_config" });
  setEnv({ FAKE_LLM: "1" });
  const key = `agent-run:fa:${id}:dup`;
  const ok = await core.withTenant(T, (tx) => core.queueAgentRun(tx, { tenantId: T, migrationId: id, requestId: randomUUID(), kind: "failure_analysis", task: "t", singletonKey: key }));
  assert.ok("runId" in ok);
  await owner.query("UPDATE agent_runs SET status='finished' WHERE migration_id=$1", [id]);   // busy 가 아니라 키 겹침만 보게
  const dup = await core.withTenant(T, (tx) => core.queueAgentRun(tx, { tenantId: T, migrationId: id, requestId: randomUUID(), kind: "failure_analysis", task: "t", singletonKey: key }));
  assert.deepEqual(dup, { skipped: "job_not_created" });
  assert.equal((await runs(id)).length, 1);
});
