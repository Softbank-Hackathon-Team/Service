// VL4fix: 시드(가짜 자격) 환경에서 사용자가 누른 연결 확인 → CLI 0번 호출, connected + verify_detail.mock=true
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
let core: typeof import("@svc/core");
let security: typeof import("@svc/security");
let job: typeof import("../src/jobs/verify-connection.js");
let ledgerMod: typeof import("../src/temp-cred-ledger.js");
let owner: pg.Client;
const T = randomUUID(), T2 = randomUUID();
let calls = 0;
const exec = async () => { calls++; return { code: 0, stdout: "{}", stderr: "", ms: 1 }; };

const broker = () => security.createTempRoleBroker({ issuers: { aws: security.mockIssuer("aws") }, ledger: ledgerMod.pgLedger(),
  resolveEnv: async () => ({ roleRef: "arn:aws:iam::000000000000:role/svc-observe" }),
  audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)) });
async function seedEnv(tenant: string, status: string, extId: string | null = null) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, region, cluster_name, external_id)
    VALUES ($1,$2,'aws',$3,$4,'ap-northeast-2','shop',$5)`, [id, tenant, `e-${id.slice(0, 6)}`, status, extId]);
  return id;
}
const row = async (id: string) => (await owner.query("SELECT connection_status, failure_reason, verify_detail, last_verified_at FROM environments WHERE id=$1", [id])).rows[0];
const creds = async (id: string) => (await owner.query("SELECT status, revoke_reason, stub FROM temp_credentials WHERE env_id=$1", [id])).rows;
const run = (id: string, reason: "user" | "periodic", tenant = T) =>
  job.handleVerifyConnection({ tenantId: tenant, envId: id, requestId: randomUUID(), reason }, { roles: broker(), cli: { exec, env: {} } });

before(async () => {
  if (skip) return;
  core = await import("@svc/core"); security = await import("@svc/security");
  ledgerMod = await import("../src/temp-cred-ledger.js"); job = await import("../src/jobs/verify-connection.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vl4fix'), ($2,'test-vl4fix-other')", [T, T2]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("시드 환경 사용자 확인: CLI 0번, verifying → connected, verify_detail.mock=true, 가짜 자격은 회수", { skip }, async () => {
  calls = 0;
  const id = await seedEnv(T, "verifying");
  const r = await run(id, "user");
  assert.equal(r.status, "connected");
  assert.equal(calls, 0);
  const e = await row(id);
  assert.equal(e.connection_status, "connected"); assert.equal(e.failure_reason, null); assert.ok(e.last_verified_at);
  assert.equal(e.verify_detail.mock, true); assert.deepEqual(e.verify_detail.clusters, []);
  const c = await creds(id);
  assert.equal(c.length, 1); assert.equal(c[0].stub, true); assert.equal(c[0].status, "revoked"); assert.equal(c[0].revoke_reason, "verify_done");
  const a = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='env.verified'", [id])).rows;
  assert.equal(a.length, 1); assert.equal(a[0].detail.mock, true);
});

test("시드 환경 주기 훑기: 상태·실패 수 그대로, CLI 0번 (unstable 도 건드리지 않음)", { skip }, async () => {
  calls = 0;
  for (const st of ["connected", "unstable"]) {
    const id = await seedEnv(T, st);
    const r = await run(id, "periodic");
    assert.equal(r.skipped, "stub_credentials");
    assert.equal((await row(id)).connection_status, st);
  }
  assert.equal(calls, 0);
});

test("거부: 이미 verifying 이 아닌 시드 환경의 user 작업(중복)은 발급도 없이 끝", { skip }, async () => {
  calls = 0;
  const id = await seedEnv(T, "connected");
  assert.equal((await run(id, "user")).skipped, "not_verifying");
  assert.equal((await creds(id)).length, 0); assert.equal(calls, 0);
});

test("거부: 남의 회사 시드 환경 → 아무것도 안 바뀜", { skip }, async () => {
  const id = await seedEnv(T2, "verifying");
  assert.equal((await run(id, "user", T)).skipped, "env_not_found");
  assert.equal((await row(id)).connection_status, "verifying"); assert.equal((await creds(id)).length, 0);
});

test("멱등: 같은 user 작업이 두 번 와도 두 번째는 not_verifying 으로 끝 (connected 유지, 감사 1줄)", { skip }, async () => {
  const id = await seedEnv(T, "verifying");
  await run(id, "user");
  assert.equal((await run(id, "user")).skipped, "not_verifying");
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE target=$1 AND action='env.verified'", [id])).rows[0].n, 1);
});
