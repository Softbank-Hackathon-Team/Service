// 실환경(진짜 발급기, REAL_STS 0 아님)에서 고객 임시 역할을 못 빌리면 단계를 멈춘다.
// 예전엔 거부(temp_role.denied)를 적고 그대로 일을 이어 가서, 빌린 자격이 없는 채 terraform 이 워커 자기 자격으로 돌 수 있었다.
// 거부는 최소 권한 파일이 없게 만들어 낸다 (PERMISSIONS_DIR = 빈 폴더 → 실행 역할 거부). 고객 CLI 호출 없음. DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let roles: typeof import("../src/jobs/_roles.js");
let apply: typeof import("../src/jobs/apply.js");
let security: typeof import("@svc/security");
let owner: pg.Client;
const T = randomUUID(), SRC = randomUUID(), DST = randomUUID();
const EXPIRES = new Date(Date.now() + 2 * 3600_000).toISOString();
const saved = { REAL_STS: process.env.REAL_STS, PERMISSIONS_DIR: process.env.PERMISSIONS_DIR };
const restore = (k: keyof typeof saved) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; };

before(async () => {
  if (skip) return;
  process.env.PERMISSIONS_DIR = mkdtempSync(join(tmpdir(), "no-perms-"));
  process.env.REAL_STS = "1";
  core = await import("@svc/core");
  roles = await import("../src/jobs/_roles.js");
  apply = await import("../src/jobs/apply.js");
  security = await import("@svc/security");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-temp-role-fail-closed')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id) VALUES
    ($1,$3,'gcp','src','connected','src-project',NULL), ($2,$3,'aws','dst','connected','111122223333',$4)`, [SRC, DST, T, `ext-${DST}`]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  restore("REAL_STS"); restore("PERMISSIONS_DIR");
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function migration(status: string) {
  const id = randomUUID();
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`, [id, T, SRC, DST, status]);
  return { id, status: status as "provisioning", sourceEnvId: SRC, targetEnvId: DST };
}

test("실환경: 도착 실행 역할이 거부되면 단계 일을 시작하지 않고 TempRoleDenied 로 멈춘다 (워커 자기 자격으로 넘어가지 않음)", { skip }, async () => {
  const m = await migration("provisioning");
  let ran = false;
  await assert.rejects(roles.withStepRoles("apply", { tenantId: T, migrationId: m.id }, m, async () => { ran = true; }),
    (e) => e instanceof security.TempRoleDenied);
  assert.equal(ran, false, "빌린 자격 없이 일(terraform)을 시작하면 안 된다");
});

test("실환경 apply: 역할 거부 → provisioning → failed(TEMP_ROLE_DENIED), 도착 자원을 만들지 않음", { skip }, async () => {
  const { id } = await migration("provisioning");
  const planId = randomUUID();
  const { ONE } = await import("./demo-one.js");
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}','{}',$3)`,
    [T, id, JSON.stringify({ spec: ONE, fieldMeta: {}, unmapped: [], ids: {} })]);
  const doc = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 }, tfPlanHash: "tf", helmValuesHash: "hv", planHash: "hp", expiresAt: EXPIRES };
  await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at) VALUES ($1,$2,$3,$4,'hp',$5)`,
    [planId, T, id, JSON.stringify(doc), EXPIRES]);
  await owner.query(`INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash) VALUES ($1,$2,$3,'approve','user:dev','hp')`,
    [T, planId, id]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [SRC, DST, T, id]);

  assert.equal(await apply.handleApply({ tenantId: T, requestId: `r-${id.slice(0, 8)}`, migrationId: id, planId, planHash: "hp" }), "advanced");
  const row = (await owner.query("SELECT status, failure_code, failed_at_status FROM migrations WHERE id=$1", [id])).rows[0];
  assert.deepEqual(row, { status: "failed", failure_code: "TEMP_ROLE_DENIED", failed_at_status: "provisioning" });
  const ready = (await owner.query("SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='apply.deploying'", [id])).rows[0].n;
  assert.equal(ready, 0);
});

test("로컬·시험(REAL_STS=0): 거부는 기록만 하고 단계는 이어 간다 (흉내 발급기는 원래 프로세스 자격으로 돈다)", { skip }, async () => {
  process.env.REAL_STS = "0";
  try {
    const m = await migration("provisioning");
    const r = await roles.withStepRoles("apply", { tenantId: T, migrationId: m.id }, m, async (x) => x);
    assert.equal(r.denied.length, 1);
    assert.equal(r.awsEnv, undefined);
  } finally { process.env.REAL_STS = "1"; }
});
