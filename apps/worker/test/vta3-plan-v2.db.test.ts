// VTA3 DB 시험: PLAN_IR=v2 계획 작업 끝까지 (TA3 는 고르기까지만 시험) + 사전 점검 깃발 + PA4 확인 항목이 v2 승인 행을 읽는지
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let plan: typeof import("../src/jobs/plan.js");
let pre: typeof import("../src/jobs/precheck.js");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID();
const prev = { PLAN_IR: process.env.PLAN_IR, IMPORT_IR: process.env.IMPORT_IR };

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  plan = await import("../src/jobs/plan.js");
  pre = await import("../src/jobs/precheck.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vta3'), ($2, 'test-vta3-other')", [T, OTHER]);
  await core.startBoss();
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

// v2 가져오기(IMPORT_IR=v2) 판을 만든 뒤 계획 단계로 둔다 (시험 준비라 owner 로 상태를 바로 씀)
async function importedPlanning(provider: "aws" | "gcp") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,$4,'s','connected'), ($2,$3,'gcp','d','connected')`, [src, dst, T, provider]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  process.env.IMPORT_IR = "v2";
  await imp.handleImport({ tenantId: T, requestId: `r-vta3-${id.slice(0, 8)}`, migrationId: id });
  delete process.env.IMPORT_IR;
  await owner.query(`UPDATE migrations SET status='planning' WHERE id=$1`, [id]);
  return { id, dst };
}
const job = (id: string) => ({ tenantId: T, requestId: `r-vta3p-${id.slice(0, 8)}`, migrationId: id, planId: randomUUID() });
const mig = async (id: string) => (await owner.query(`SELECT status, failure_code FROM migrations WHERE id=$1`, [id])).rows[0] as
  { status: string; failure_code: string | null };
const savedPlan = async (id: string) => core.withTenant(T, (tx) => core.loadLatestPlan(tx, id));

test("정상: PLAN_IR=v2 + gcp v2 가져오기 판 → 계획서 irVersion 2·specSource spec_v2·instances, 확인 항목도 같이", { skip }, async () => {
  const m = await importedPlanning("gcp");
  process.env.PLAN_IR = "v2";
  await plan.handlePlan(job(m.id));
  assert.equal((await mig(m.id)).status, "awaiting_approval");
  const p = (await savedPlan(m.id))!;
  assert.equal(p.irVersion, "2");
  assert.equal(p.specSource, "spec_v2");
  assert.ok((p.instances ?? []).some((x) => x.kind === "postgres"));
  assert.match(p.adapterVersion, /-target@/);
  assert.deepEqual(p.acknowledgements?.slice(0, 2).map((a) => a.id), ["cost", "failure_cost_policy"]);
});

test("깃발 off: 같은 v2 판이어도 계획서에 v2 칸이 없다 (지금 동작 그대로)", { skip }, async () => {
  const m = await importedPlanning("gcp");
  delete process.env.PLAN_IR;
  await plan.handlePlan(job(m.id));
  assert.equal((await mig(m.id)).status, "awaiting_approval");
  const p = (await savedPlan(m.id))!;
  assert.equal(p.irVersion, undefined);
  assert.equal(p.specSource, undefined);
});

test("거부: 사람이 고친 판에 spec_v2 가 없으면 계획 작업이 재시도 없이 failed(NEEDS_HUMAN), 계획서 없음", { skip }, async () => {
  const m = await importedPlanning("gcp");
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta)
    SELECT tenant_id, migration_id, 2, spec, '{}'::jsonb FROM spec_versions WHERE migration_id=$1 AND version=1`, [m.id]);
  process.env.PLAN_IR = "v2";
  await plan.handlePlan(job(m.id));
  const s = await mig(m.id);
  assert.equal(s.status, "failed");
  assert.equal(s.failure_code, "NEEDS_HUMAN");
  assert.equal(await savedPlan(m.id), null);
});

test("사전 점검 v2 대조: 깃발 off 면 빈 목록, on 이면 출처 줄, 남의 회사면 빈 목록", { skip }, async () => {
  const m = await importedPlanning("gcp");
  const row = { id: m.id, status: "prechecking", sourceEnvId: randomUUID(), targetEnvId: m.dst } as never;
  assert.deepEqual(await pre.v2PrecheckFor(T, row, {}), []);
  const on = await pre.v2PrecheckFor(T, row, { PLAN_IR: "v2" });
  assert.equal(on[0]!.id, "PC-V2-SOURCE");
  assert.match(on[0]!.message, /spec_v2/);
  assert.deepEqual(await pre.v2PrecheckFor(OTHER, row, { PLAN_IR: "v2" }), []);
});

// 찾은 버그 재현: spec_v2 칸은 ImportResultV2({ spec, fieldMeta, … }) 라 AppSpecV2 로 바로 parse 하면 늘 실패 → 승인 행이 늘 빈 목록이었다
test("PA4 확인 항목: v2 판의 승인 행(runtime_change)을 읽는다 (spec_v2->'spec')", { skip }, async () => {
  const m = await importedPlanning("gcp");
  const r = await owner.query(`SELECT spec_v2 FROM spec_versions WHERE migration_id=$1 AND version=1`, [m.id]);
  const iv2 = r.rows[0].spec_v2 as { spec: { components: Array<{ id: string; kind: string; props: Record<string, unknown> }> } };
  const svc = iv2.spec.components.find((c) => c.kind === "service")!;
  const from = (svc.props.origin as { runtime: string }).runtime;
  svc.props.runtime = from === "k8s" ? "managedContainer" : "k8s";
  await owner.query(`UPDATE spec_versions SET spec_v2=$2 WHERE migration_id=$1 AND version=1`, [m.id, JSON.stringify(iv2)]);
  const ex = await core.withTenant(T, (tx) => plan.loadPlanSpecExtras(tx, m.id));
  assert.equal(ex.specVersion, 1);
  assert.deepEqual(ex.v2Approvals.map((a) => `${a.kind}:${a.subject}`), [`runtime_change:${svc.id}`]);
  // 남의 회사에선 판이 안 보인다
  const other = await core.withTenant(OTHER, (tx) => plan.loadPlanSpecExtras(tx, m.id));
  assert.deepEqual(other, { v2Approvals: [] });
});
