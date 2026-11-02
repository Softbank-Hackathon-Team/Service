// SECAUDIT DB 시험: 가짜 비밀값을 심고 감사 테이블 전체를 grep 한다
//   ① 도착 자원 출력(InfraReady.tfOutputs) 값은 infra_ready 표에만, 감사엔 이름만
//   ② 어떤 경로든 writeAudit 에 들어온 주소·계정 ID·토큰·비밀번호는 저장 전에 가려지고, 해시 체인은 가린 값 기준으로 맞다
//   ③ apply(흉내) 한 바퀴 뒤 감사에 출력 값이 하나도 없다. 배포가 읽는 loadInfraReady 는 값 그대로
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
const T = randomUUID(), OTHER = randomUUID();
const prev = { PLAN_IR: process.env.PLAN_IR, IMPORT_IR: process.env.IMPORT_IR, MOCK_IAC: process.env.MOCK_IAC };

// 심는 가짜 비밀값 (진짜 값 아님)
const ACCT = "210987654321";
const PLANT = {
  rds: "plant-db.c0ffee12.ap-northeast-2.rds.amazonaws.com",
  cache: "plant-redis.c0ffee.0001.apn2.cache.amazonaws.com",
  password: "Pl4nt-S3cr3t-pw",
  akia: "AKIAPLANTPLANT123456",
  anthropic: "sk-ant-api03-PLANTplantPLANT",
  ghp: "ghp_PLANTplantPLANTplantPLANT01",
  ip: "10.77.66.55",
};
const PLANTED = [ACCT, ...Object.values(PLANT)];

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  plan = await import("../src/jobs/plan.js");
  apply = await import("../src/jobs/apply.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-secaudit'), ($2, 'test-secaudit-other')", [T, OTHER]);
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

async function migration(status = "importing", provider: "aws" | "gcp" = "gcp") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,$4,'s','connected'), ($2,$3,'gcp','d','connected')`, [src, dst, T, provider]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, status]);
  return { id, src, dst };
}
// 감사 테이블 전체(이 회사 + 전체)에서 심은 값 찾기
async function leaks(where = "tenant_id = $1", args: unknown[] = [T]) {
  const r = await owner.query(`SELECT action, target, detail::text AS d FROM audit_events WHERE ${where}`, args);
  const hits: string[] = [];
  for (const row of r.rows) for (const p of PLANTED)
    if (`${row.target} ${row.d}`.includes(p)) hits.push(`${row.action}: ${p}`);
  return hits;
}

test("정상: InfraReady 출력 값은 infra_ready 표에만, 감사엔 출력 이름만. 읽기는 값 그대로, 다른 회사는 못 봄", { skip }, async () => {
  const m = await migration("provisioning");
  const tfOutputs = { db_address: PLANT.rds, db_endpoint: `${PLANT.rds}:5432`, db_private_ip: PLANT.ip,
    db_master_secret_arn: `arn:aws:secretsmanager:ap-northeast-2:${ACCT}:secret:db-x`, cache_host: PLANT.cache,
    app_role_arn: `arn:aws:iam::${ACCT}:role/app`, cluster_name: "c1" };
  const planId = randomUUID();
  await core.withTenant(T, (tx) => core.saveInfraReady(tx, { tenantId: T, migrationId: m.id, planId, tfOutputs, helmValuesKey: "k" }));
  assert.deepEqual(await leaks(), []);
  const a = (await owner.query(`SELECT detail FROM audit_events WHERE action='infra.ready' AND target=$1`, [m.id])).rows[0].detail;
  assert.deepEqual(a, { planId, outputs: Object.keys(tfOutputs).sort() });
  const back = (await core.withTenant(T, (tx) => core.loadInfraReady(tx, m.id)))!;
  assert.deepEqual(back.tfOutputs, tfOutputs);
  assert.equal(back.planId, planId);
  assert.equal(await core.withTenant(OTHER, (tx) => core.loadInfraReady(tx, m.id)), null);
});

test("옛 줄: infra_ready 표가 없던 때 감사 detail.infraReady 로 남은 이전도 읽힌다 (배포 재개)", { skip }, async () => {
  const m = await migration("deploying");
  const old = { tenantId: T, migrationId: m.id, planId: randomUUID(), tfOutputs: { db_address: "old.internal" }, helmValuesKey: "k" };
  await owner.query(`INSERT INTO audit_events (tenant_id, actor, action, target, result, detail, prev_hash, hash)
    VALUES ($1,'worker','infra.ready',$2,'ok',$3,'genesis',$4)`, [T, m.id, { infraReady: old }, "x".repeat(64)]);
  const back = (await core.withTenant(T, (tx) => core.loadInfraReady(tx, m.id)))!;
  assert.deepEqual(back.tfOutputs, { db_address: "old.internal" });
  await owner.query(`DELETE FROM audit_events WHERE target=$1`, [m.id]);   // 손으로 넣은 체인 밖 줄은 지운다
});

test("정상: 어떤 경로의 오류 문구·detail 이든 저장 전에 가린다, 해시는 저장된 값 기준으로 맞다, 읽는 쪽 칸은 그대로", { skip }, async () => {
  const m = await migration("provisioning");
  const detail = {
    error: `connect ECONNREFUSED ${PLANT.ip}:5432 (${PLANT.rds}) postgres://app:${PLANT.password}@${PLANT.rds}/app`,
    deploy: { reason: `push failed: https://x:${PLANT.ghp}@github.com/o/r.git` },
    issuer: { assumedRoleArn: `arn:aws:sts::${ACCT}:assumed-role/op/s1`, roleRef: `arn:aws:iam::${ACCT}:role/op` },
    env: { AWS_ACCESS_KEY_ID: PLANT.akia, ANTHROPIC_API_KEY: PLANT.anthropic },
    nested: [{ password: PLANT.password }, `Bearer ${PLANT.anthropic}`, `redis ${PLANT.cache}`],
    queue: `https://sqs.ap-northeast-2.amazonaws.com/${ACCT}/q`,
    // 읽는 쪽이 쓰는 칸 (env-inventory·shift·_step·plan·report)
    jobId: "job-1", from: "terraform", to: "runner", reachedPct: 50, removed: 2,
    precheck: [{ id: "PC-NET-01", level: "warn", message: "CIDR 10.0.0.0/16 겹침" }],
  };
  await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "migration.failed",
    target: m.id, result: "error", detail }));
  assert.deepEqual(await leaks(), []);
  const row = (await owner.query(`SELECT actor, action, target, result, detail, prev_hash, hash FROM audit_events
    WHERE target=$1 ORDER BY seq DESC LIMIT 1`, [m.id])).rows[0];
  const d = row.detail;
  assert.equal(d.jobId, "job-1"); assert.equal(d.from, "terraform"); assert.equal(d.reachedPct, 50);
  assert.equal(d.precheck[0].message, "CIDR 10.0.0.0/16 겹침");
  assert.equal(d.issuer.roleRef, "arn:aws:iam::<account>:role/op");
  assert.equal(d.env.AWS_ACCESS_KEY_ID, core.AUDIT_REDACTED);
  const body = { actor: row.actor, action: row.action, target: row.target, result: row.result, detail: d, tenantId: T, prevHash: row.prev_hash };
  assert.equal(core.sha256(core.canonical(body)), row.hash);
});

test("한 바퀴: v2 가져오기 → 계획 → apply(흉내) 뒤 감사에 tfOutputs 값이 하나도 없다, 배포가 읽을 값은 표에 있다", { skip }, async () => {
  const m = await migration("importing");
  process.env.IMPORT_IR = "v2";
  await imp.handleImport({ tenantId: T, requestId: `r-sa-i-${m.id.slice(0, 8)}`, migrationId: m.id });
  await owner.query(`UPDATE migrations SET status='planning' WHERE id=$1`, [m.id]);
  process.env.PLAN_IR = "v2";
  const planId = randomUUID();
  await plan.handlePlan({ tenantId: T, requestId: `r-sa-p-${m.id.slice(0, 8)}`, migrationId: m.id, planId });
  const p = (await core.withTenant(T, (tx) => core.loadLatestPlan(tx, m.id)))!;
  await owner.query(`INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash)
    VALUES ($1,$2,$3,'approve','user:dev',$4)`, [T, planId, m.id, p.planHash]);
  await owner.query(`UPDATE migrations SET status='provisioning' WHERE id=$1`, [m.id]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [m.src, m.dst, T, m.id]);
  process.env.MOCK_IAC = "1";
  await apply.handleApply({ tenantId: T, requestId: `r-sa-a-${m.id.slice(0, 8)}`, migrationId: m.id, planId, planHash: p.planHash });
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [m.id])).rows[0].status, "deploying");
  const infra = (await core.withTenant(T, (tx) => core.loadInfraReady(tx, m.id)))!;
  // 주소·IP·ARN·비밀 이름처럼 보이는 출력 값 (점·콜론·@ 포함)
  const values = [...new Set(Object.values(infra.tfOutputs).filter((v) => /[.:@]/.test(v)))];
  assert.ok(values.length >= 3);
  const text = (await owner.query(`SELECT string_agg(detail::text, '\n') AS t FROM audit_events WHERE target=$1`, [m.id])).rows[0].t as string;
  for (const v of values) assert.equal(text.includes(v), false, `감사에 출력 값 남음: ${v}`);
  const tr = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND detail ? 'iac'`, [m.id])).rows[0];
  assert.deepEqual(tr?.detail.outputs, Object.keys(infra.tfOutputs).sort());
  assert.equal(tr?.detail.tfOutputs, undefined);
});

test("전체 grep: 시험 DB 감사 테이블 어디에도 심은 값이 없다", { skip }, async () => {
  assert.deepEqual(await leaks("true", []), []);
});
