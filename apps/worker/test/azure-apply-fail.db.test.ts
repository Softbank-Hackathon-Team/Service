// Z53: 워커 apply 의 Azure Mock 실패 경로 (DB 시험). 지금까지는 STUB 경로(APPLY_STUB_FAIL)만 DB 로 봤다
//   - AZURE_MOCK_FAIL=apply → provisioning → failed(AZURE_MOCK_APPLY_FAILED), 잠금 해제, 감사 기록에 Mock 로그
//   - AZURE_MOCK=0        → provisioning → failed(AZURE_MOCK_DISABLED), 잠금 해제
//   - 둘 다 failed 이고 실패 지점이 provisioning → T37 로 다시 계획할 수 있다(failed_at_status 확인)
// 성공 경로는 일부러 안 넣었다: 성공하면 deploy 작업이 pg-boss 큐에 남아 다음 시험 파일의 워커가 집는다(순서 의존)
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let apply: typeof import("../src/jobs/apply.js");
let owner: pg.Client;
const T = randomUUID();
const EXPIRES = new Date(Date.now() + 2 * 3600_000).toISOString();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  apply = await import("../src/jobs/apply.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z53-azure')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

// 환경 변수는 시험 하나 동안만 바꾸고 t.after 로 되돌린다 (다른 시험에 새지 않게)
function withEnv(t: TestContext, vars: Record<string, string>) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  t.after(() => { for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v); });
}

// provisioning 상태 + 도착 azure_mock + 명세 1판 + 계획·승인 + 두 환경 reserved 잠금
async function seed() {
  const id = randomUUID(), planId = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'azure_mock','az','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'provisioning')`, [id, T, src, dst]);
  const { ONE } = await import("./demo-one.js");
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
    VALUES ($1,$2,1,'{}','{}',$3)`, [T, id, JSON.stringify({ spec: ONE, fieldMeta: {}, unmapped: [], ids: {} })]);
  const doc = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: "tf", helmValuesHash: "hv", planHash: "hp", expiresAt: EXPIRES };
  await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
    VALUES ($1,$2,$3,$4,'hp',$5)`, [planId, T, id, JSON.stringify(doc), EXPIRES]);
  await owner.query(`INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash)
    VALUES ($1,$2,$3,'approve','user:dev','hp')`, [T, planId, id]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`,
    [src, dst, T, id]);
  return { id, planId };
}
const st = async (id: string) => (await owner.query(
  "SELECT status, failure_code, failed_at_status FROM migrations WHERE id=$1", [id])).rows[0];
const lockCount = async (id: string) => (await owner.query(
  "SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [id])).rows[0].n as number;
const job = (id: string, planId: string) =>
  ({ tenantId: T, requestId: `r-z53-${id.slice(0, 8)}`, migrationId: id, planId, planHash: "hp" });

test("Azure Mock apply 실패 → failed(AZURE_MOCK_APPLY_FAILED), 잠금 해제, 감사 기록에 Mock 로그", { skip }, async (t) => {
  withEnv(t, { AZURE_MOCK: "1", AZURE_MOCK_FAIL: "apply", AZURE_MOCK_LATENCY_MS: "0" });
  const m = await seed();
  assert.equal(await apply.handleApply(job(m.id, m.planId)), "advanced");
  assert.deepEqual(await st(m.id), { status: "failed", failure_code: "AZURE_MOCK_APPLY_FAILED", failed_at_status: "provisioning" });
  assert.equal(await lockCount(m.id), 0, "provisioning 실패는 잠금을 푼다");
  const a = await owner.query(`SELECT action, detail FROM audit_events WHERE target=$1 ORDER BY seq`, [m.id]);
  const text = JSON.stringify(a.rows);
  assert.match(text, /ServerQuotaExceeded/, "Mock 실패 로그가 감사 기록에 남는다");
});

test("AZURE_MOCK=0 → failed(AZURE_MOCK_DISABLED), 잠금 해제", { skip }, async (t) => {
  withEnv(t, { AZURE_MOCK: "0" });
  const m = await seed();
  assert.equal(await apply.handleApply(job(m.id, m.planId)), "advanced");
  assert.deepEqual(await st(m.id), { status: "failed", failure_code: "AZURE_MOCK_DISABLED", failed_at_status: "provisioning" });
  assert.equal(await lockCount(m.id), 0);
});
