// Z70: 진짜 terraform 길이 apply 작업에 붙었는지 (DB 시험). terraform 대신 가짜 TF_BIN 셸 스크립트만 부른다
//   - 승인 지문과 다른 Terraform 입력 → failed(TF_PLAN_DRIFT), 가짜 terraform 도 안 부름
//   - apply 단계 실패 → failed(TF_APPLY_FAILED), 잠금 해제, 감사 detail 에 파기 명령·작업 폴더
// 성공 경로는 Z53 과 같은 이유로 뺐다 (deploy 작업이 큐에 남아 다음 시험 파일 워커가 집는다). 성공 모양은 z70-apply-real.test.ts
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let apply: typeof import("../src/jobs/apply.js");
let step: typeof import("../src/jobs/_step.js");
let owner: pg.Client;
const T = randomUUID();
const TSLUG = "t-" + T.replace(/-/g, "").slice(0, 8).toLowerCase();   // gitops tenantSlug 와 같은 규칙
const EXPIRES = new Date(Date.now() + 2 * 3600_000).toISOString();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  apply = await import("../src/jobs/apply.js");
  step = await import("../src/jobs/_step.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z70-real')", [T]);
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


const work = mkdtempSync(join(tmpdir(), "z70db-"));
const FAKE_TF = join(work, "fake-terraform.sh");
writeFileSync(FAKE_TF, `#!/bin/sh\necho "$@" >> "${join(work, "calls.log")}"\nsub="$1"; case "$1" in -chdir=*) sub="$2";; esac\ncase "$sub" in apply) echo "Error: fake quota" >&2; exit 1;; *) echo ok;; esac\n`);
chmodSync(FAKE_TF, 0o755);
// Z89: test:db 는 MOCK_IAC=1 로 돈다 → 이 파일만 진짜 길(MOCK_IAC=0)로 바꾸고 terraform 은 가짜 셸
const REAL = { MOCK_IAC: "0", TF_BIN: FAKE_TF, TF_WORK_DIR: work,
  TF_FACT_VPC_ID: "vpc-1", TF_FACT_DB_SUBNET_IDS_JSON: '["subnet-a"]', TF_FACT_CLUSTER_NAME: "finals-eks" };

async function seed(goodHash: boolean) {
  const id = randomUUID(), planId = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id) VALUES
    ($1,$3,'onprem','s','connected',null), ($2,$3,'aws','dst','connected','111122223333')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'provisioning')`, [id, T, src, dst]);
  const { ONE: spec } = await import("./demo-one.js");
  const { tfCallV2 } = await import("../src/jobs/plan-v2.js");
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
    VALUES ($1,$2,1,'{}','{}',$3)`, [T, id, JSON.stringify({ spec, fieldMeta: {}, unmapped: [], ids: {} })]);
  const tfPlanHash = goodHash
    ? step.stableHash(tfCallV2(spec, { envId: dst, provider: "aws", region: "default", migrationId: id }, {})) : "tf";   // G8-1: 계획 처리기와 같은 대상(이전 번호 seed)
  const doc = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash, helmValuesHash: "hv", planHash: "hp", expiresAt: EXPIRES };
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
  ({ tenantId: T, requestId: `r-z70-${id.slice(0, 8)}`, migrationId: id, planId, planHash: "hp" });
const calls = () => (existsSync(join(work, "calls.log")) ? readFileSync(join(work, "calls.log"), "utf8").trim().split("\n") : []);

test("Z70 승인 지문과 다른 Terraform 입력 → failed(TF_PLAN_DRIFT), terraform 안 부름", { skip }, async (t) => {
  withEnv(t, REAL);
  const m = await seed(false);
  assert.equal(await apply.handleApply(job(m.id, m.planId)), "advanced");
  assert.deepEqual(await st(m.id), { status: "failed", failure_code: "TF_PLAN_DRIFT", failed_at_status: "provisioning" });
  assert.equal(await lockCount(m.id), 0);
  assert.equal(existsSync(join(work, m.id)), false);
  assert.equal(existsSync(join(work, TSLUG, m.id)), false);
});

test("Z70 terraform apply 실패 → failed(TF_APPLY_FAILED), 잠금 해제, 감사에 파기 명령·작업 폴더", { skip }, async (t) => {
  withEnv(t, REAL);
  const m = await seed(true);
  assert.equal(await apply.handleApply(job(m.id, m.planId)), "advanced");
  assert.deepEqual(await st(m.id), { status: "failed", failure_code: "TF_APPLY_FAILED", failed_at_status: "provisioning" });
  assert.equal(await lockCount(m.id), 0);
  // Z89: apply 실패 → 같은 state 로 바로 destroy (만들다 만 자원 정리)
  assert.deepEqual(calls().map((l) => l.split(" ").find((a) => !a.startsWith("-"))), ["init", "plan", "apply", "destroy"]);
  // Z89: state 폴더는 회사별
  const vars = JSON.parse(readFileSync(join(work, TSLUG, m.id, "terraform.tfvars.json"), "utf8"));
  assert.equal(vars.expected_account_id, "111122223333", "환경 표 account_id 로 자리표시를 채움");
  assert.equal(JSON.stringify(vars).includes("<env:"), false);
  const a = await owner.query(`SELECT detail FROM audit_events WHERE target=$1 ORDER BY seq`, [m.id]);
  const text = JSON.stringify(a.rows);
  assert.match(text, /"destroyedAfterFail":\{[^}]*"ok":true/); // jsonb 는 키를 길이·글자 순으로 저장 ("ms" 가 "ok" 앞)
  assert.doesNotMatch(text, /npm run tf:real -- destroy/, "자동 destroy 성공 → 사람 정리 명령 안 남김");
  assert.match(text, /fake quota/);
});
