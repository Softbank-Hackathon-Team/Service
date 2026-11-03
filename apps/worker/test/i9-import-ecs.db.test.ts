// DB 시험(I9): aws(ECS) 출발 + IMPORT_IR=v2 → spec_v2 저장 (예전엔 v1 으로 되돌아감). 처리기를 직접 부른다. MOCK_SEED=1 데모 원본
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-i9')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  delete process.env.IMPORT_IR;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','d','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-i9-${id.slice(0, 8)}`, migrationId: id });

test("정상: aws ECS 데모 + IMPORT_IR=v2 → spec_v2(관리형 컨테이너 3개 + DB) 와 v1 투영(shop-api) 저장, 감사 ir=v2", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const id = await seed();
  await imp.handleImport(job(id));
  const m = (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0];
  assert.equal(m.status, "spec_review");
  const [v] = (await owner.query("SELECT spec, spec_v2 FROM spec_versions WHERE migration_id=$1", [id])).rows;
  assert.equal(v.spec.app.name, "shop-api");
  assert.equal(v.spec.service.port, 8080);
  assert.deepEqual(v.spec_v2.spec.components.map((c: { id: string }) => c.id), ["shop-api", "shop-db", "shop-web", "shop-worker"]);
  assert.ok(v.spec_v2.spec.components.filter((c: { kind: string }) => c.kind === "service").every((c: { props: { runtime: string } }) => c.props.runtime === "managedContainer"));
  const a = await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review'", [id]);
  assert.equal(a.rows[0]?.detail?.ir, "v2");
  // 감사에 남긴 원본은 ECS env 값을 지운다 (이름만)
  const ecs = (a.rows[0]?.detail?.sourceInventory?.items ?? []).filter((i: { kind: string }) => i.kind === "ecs.service");
  assert.equal(ecs.length, 3);
  for (const i of ecs) for (const c of i.taskDefinition.containerDefinitions)
    for (const e of c.environment ?? []) assert.deepEqual(Object.keys(e), ["name"]);
});

test("관찰 권한: v2 만 ECS·ALB 규칙·Auto Scaling 읽기를 더한다 (v1 목록은 그대로)", { skip }, async () => {
  delete process.env.IMPORT_IR;
  assert.deepEqual(imp.importObserveActions(), imp.IMPORT_OBSERVE_ACTIONS);
  process.env.IMPORT_IR = "v2";
  const v2 = imp.importObserveActions();
  for (const a of ["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "elasticloadbalancing:DescribeRules", "application-autoscaling:DescribeScalableTargets"])
    assert.ok(v2.includes(a), a);
  assert.equal(new Set(v2).size, v2.length, "겹침 없음");
  assert.equal(v2.some((a) => !/:(List|Describe|Get)/.test(a)), false, "읽기 동작만");
});
