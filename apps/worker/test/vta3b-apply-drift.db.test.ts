// VTA3b DB 시험: 계획·승인한 뒤 명세(spec_v2)가 사라지거나 내용이 바뀌면 적용 단계가 TF_PLAN_DRIFT (MOCK_IAC 길)
//   drift 실패는 provisioning 에서 난 실패라 다시 계획(replan) 길이 열려 있다 (failed_at_status = provisioning)
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let plan: typeof import("../src/jobs/plan.js");
let apply: typeof import("../src/jobs/apply.js");
let owner: pg.Client;
const T = randomUUID();
const prev = { MOCK_IAC: process.env.MOCK_IAC, TF_BIN: process.env.TF_BIN };

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  plan = await import("../src/jobs/plan.js");
  apply = await import("../src/jobs/apply.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vta3b')", [T]);
  await core.startBoss();
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

// 가져오기 → 계획 → 승인·잠금 → provisioning 까지 (승인·상태는 시험 준비라 owner 로 바로)
async function approvedV2(source: "aws" | "gcp") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,$4,'s','connected'), ($2,$3,'gcp','d','connected')`, [src, dst, T, source]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  await imp.handleImport({ tenantId: T, requestId: `r-vta3b-i-${id.slice(0, 8)}`, migrationId: id });
  await owner.query(`UPDATE migrations SET status='planning' WHERE id=$1`, [id]);
  const planId = randomUUID();
  await plan.handlePlan({ tenantId: T, requestId: `r-vta3b-p-${id.slice(0, 8)}`, migrationId: id, planId });
  const p = (await core.withTenant(T, (tx) => core.loadLatestPlan(tx, id)))!;
  await owner.query(`INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash)
    VALUES ($1,$2,$3,'approve','user:dev',$4)`, [T, planId, id, p.planHash]);
  await owner.query(`UPDATE migrations SET status='provisioning' WHERE id=$1`, [id]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [src, dst, T, id]);
  return { id, planId, plan: p };
}
const applyJob = (m: { id: string; planId: string; plan: { planHash: string } }) =>
  ({ tenantId: T, requestId: `r-vta3b-a-${m.id.slice(0, 8)}`, migrationId: m.id, planId: m.planId, planHash: m.plan.planHash });
const st = async (id: string) => (await owner.query(
  "SELECT status, failure_code, failed_at_status FROM migrations WHERE id=$1", [id])).rows[0];

test("정상: 아무것도 안 바뀌면 흉내 적용 → deploying, InfraReady 에 link.<postgres>.* 출력", { skip }, async () => {
  const m = await approvedV2("gcp");
  process.env.MOCK_IAC = "1";
  await apply.handleApply(applyJob(m));
  assert.equal((await st(m.id)).status, "deploying");
  const infra = (await core.withTenant(T, (tx) => core.loadInfraReady(tx, m.id)))!;
  assert.ok(Object.keys(infra.tfOutputs).some((k) => /^link\.[^.]+\.host$/.test(k)));
});

test("거부: 승인 뒤 사람이 고친 판(spec_v2 없음)이 생기면 TF_PLAN_DRIFT, provisioning 실패라 다시 계획 가능, 잠금 0", { skip }, async () => {
  const m = await approvedV2("gcp");
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta)
    SELECT tenant_id, migration_id, 2, '{}', '{}'::jsonb FROM spec_versions WHERE migration_id=$1 AND version=1`, [m.id]);
  process.env.MOCK_IAC = "1";
  await apply.handleApply(applyJob(m));
  assert.deepEqual(await st(m.id), { status: "failed", failure_code: "TF_PLAN_DRIFT", failed_at_status: "provisioning" });
  assert.equal((await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [m.id])).rows[0].n, 0);
  assert.equal(await core.withTenant(T, (tx) => core.loadInfraReady(tx, m.id)), null);
});

test("거부: 승인 뒤 사람이 명세 내용을 고친 판(postgres 저장 공간)이 생기면 TF_PLAN_DRIFT (몰래 바꿔 타지 않음)", { skip }, async () => {
  const m = await approvedV2("gcp");
  const cur = (await owner.query(`SELECT spec_v2 FROM spec_versions WHERE migration_id=$1 AND version=1`, [m.id])).rows[0].spec_v2;
  const spec = structuredClone(cur.spec);
  const pg0 = spec.components.find((c: { kind: string }) => c.kind === "postgres");
  pg0.props.storageGb = (pg0.props.storageGb ?? 20) + 7;
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
    VALUES ($1,$2,2,'{}','{}'::jsonb,$3)`, [T, m.id, JSON.stringify({ ...cur, spec })]);
  // 지문 대조는 진짜 terraform 길(realApply)의 첫 단계. terraform 을 부르기 전에 멈추므로 실행 파일은 없는 경로로 둔다
  process.env.MOCK_IAC = "0"; process.env.TF_BIN = "/nonexistent/terraform";
  await apply.handleApply(applyJob(m));
  assert.deepEqual(await st(m.id), { status: "failed", failure_code: "TF_PLAN_DRIFT", failed_at_status: "provisioning" });
});
