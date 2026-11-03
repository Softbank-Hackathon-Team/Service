// L4 DB 시험: 연결 확인 작업. 발급기·CLI 는 가짜 주입 (실제 AWS 호출 없음). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Exec } from "@svc/adapters";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let security: typeof import("@svc/security");
let job: typeof import("../src/jobs/verify-connection.js");
let ledgerMod: typeof import("../src/temp-cred-ledger.js");
let owner: pg.Client;
const T = randomUUID(), T2 = randomUUID();
const req = () => randomUUID();

// 가짜 STS: mode 로 응답을 바꾼다
let stsMode: "ok" | "denied" = "ok";
const fakeSts = { assumeRole: async () => {
  if (stsMode === "denied") { const { StsCliError } = security; throw new StsCliError(254, "AccessDenied"); }
  return { Credentials: { AccessKeyId: "ASIAFAKE", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(Date.now() + 900_000) } };
} };
// 가짜 CLI: canI 로 쿠버네티스 결과를 바꾼다
let canI = "yes";
const TRUST = JSON.stringify({ Statement: [{ Effect: "Allow", Condition: { StringEquals: { "sts:ExternalId": "x" } } }] });
const exec: Exec = async (cmd, args) => {
  const line = `${cmd} ${args.join(" ")}`;
  const out = (o: unknown, code = 0) => ({ code, stdout: typeof o === "string" ? o : JSON.stringify(o), stderr: "", ms: 1 });
  if (/^aws eks list-clusters/.test(line)) return out({ clusters: ["shop"] });
  if (/^aws iam get-role/.test(line)) return out({ Role: { AssumeRolePolicyDocument: TRUST } });
  if (/auth can-i/.test(line)) return out(`${canI}\n`, canI === "yes" ? 0 : 1);
  return out({});
};

function broker() {
  return security.createTempRoleBroker({
    issuers: { aws: security.awsStsIssuer({ sts: fakeSts }) },
    ledger: ledgerMod.pgLedger(),
    resolveEnv: async (_t, envId) => ({ roleRef: `arn:aws:iam::111122223333:role/svc-observe`, externalId: `ext-${envId.slice(0, 8)}` }),
    audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)),
  });
}
const deps = () => ({ roles: broker(), cli: { exec, env: {} } });
async function env(tenant: string, status: string, extra: { failures?: number } = {}) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region, cluster_name, verify_failures)
    VALUES ($1,$2,'aws',$3,$4,'111122223333',$5,'ap-northeast-2','shop',$6)`, [id, tenant, `e-${id.slice(0, 6)}`, status, `ext-${id}`, extra.failures ?? 0]);
  return id;
}
const row = async (id: string) => (await owner.query("SELECT connection_status, failure_reason, verify_failures, verify_detail, last_verified_at FROM environments WHERE id=$1", [id])).rows[0];
const creds = async (id: string) => (await owner.query("SELECT status, revoke_reason, purpose, step FROM temp_credentials WHERE env_id=$1", [id])).rows;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  security = await import("@svc/security");
  ledgerMod = await import("../src/temp-cred-ledger.js");
  job = await import("../src/jobs/verify-connection.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-l4'), ($2, 'test-l4-other')", [T, T2]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("정상: verifying → connected, verify_detail 저장, 장부 issued → revoked(verify_done), 감사 env.verified", { skip }, async () => {
  stsMode = "ok"; canI = "yes";
  const id = await env(T, "verifying");
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: req(), reason: "user" }, deps());
  assert.equal(r.status, "connected");
  const e = await row(id);
  assert.equal(e.connection_status, "connected");
  assert.equal(e.failure_reason, null);
  assert.deepEqual(e.verify_detail.clusters, ["shop"]);
  assert.ok(e.last_verified_at);
  const c = await creds(id);
  assert.equal(c.length, 1);
  assert.equal(c[0].status, "revoked"); assert.equal(c[0].revoke_reason, "verify_done"); assert.equal(c[0].purpose, "observe"); assert.equal(c[0].step, "verify");
  const a = (await owner.query("SELECT detail FROM audit_events WHERE tenant_id=$1 AND target=$2 AND action='env.verified'", [T, id])).rows;
  assert.equal(a.length, 1);
  assert.ok(!JSON.stringify(a[0].detail).includes("ext-") && !JSON.stringify(a[0].detail).includes("ASIAFAKE"));
});

test("거부: STS AccessDenied → failed + ROLE_ASSUME_DENIED, 작업은 예외 없이 끝남", { skip }, async () => {
  stsMode = "denied";
  const id = await env(T, "verifying");
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: req(), reason: "user" }, deps());
  assert.deepEqual(r, { status: "failed", reason: "ROLE_ASSUME_DENIED" });
  const e = await row(id);
  assert.equal(e.connection_status, "failed"); assert.equal(e.failure_reason, "ROLE_ASSUME_DENIED");
  assert.equal((await creds(id)).length, 0);
  stsMode = "ok";
});

test("거부: 쿠버네티스 can-i no → failed + K8S_ACCESS_MISSING, 빌린 자격은 회수됨", { skip }, async () => {
  stsMode = "ok"; canI = "no";
  const id = await env(T, "verifying");
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: req(), reason: "user" }, deps());
  assert.equal(r.reason, "K8S_ACCESS_MISSING");
  assert.equal((await creds(id))[0].status, "revoked");
  canI = "yes";
});

test("거부: 남의 회사 envId 작업 → 아무것도 안 바뀜 (발급도 없음)", { skip }, async () => {
  const id = await env(T2, "verifying");
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: req(), reason: "user" }, deps());
  assert.equal(r.skipped, "env_not_found");
  assert.equal((await row(id)).connection_status, "verifying");
  assert.equal((await creds(id)).length, 0);
});

test("주기 재확인: 실패 3번 → unstable (verifying 으로 안 감), 성공 → connected + 실패 수 0", { skip }, async () => {
  canI = "no";
  const id = await env(T, "connected");
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: req(), reason: "periodic" }, deps());
    seen.push(r.status);
  }
  assert.deepEqual(seen, ["connected", "connected", "unstable"]);
  let e = await row(id);
  assert.equal(e.connection_status, "unstable"); assert.equal(e.verify_failures, 3); assert.equal(e.failure_reason, "K8S_ACCESS_MISSING");
  canI = "yes";
  const ok = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: req(), reason: "periodic" }, deps());
  assert.equal(ok.status, "connected");
  e = await row(id);
  assert.equal(e.verify_failures, 0); assert.equal(e.failure_reason, null);
});

test("user 작업인데 이미 verifying 이 아님 → 그냥 끝 (중복 작업)", { skip }, async () => {
  const id = await env(T, "connected");
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: req(), reason: "user" }, deps());
  assert.equal(r.skipped, "not_verifying");
  assert.equal((await creds(id)).length, 0);
});

test("REAL_STS=1 이어도 external_id 없는 환경(시드)은 mock 발급기로 감 (platform awsIssuer)", { skip }, async () => {
  const platform = await import("../src/platform.js");
  assert.equal(platform.awsIssuer({ REAL_STS: "0" }).mock, true);
  const w = platform.awsIssuer({ REAL_STS: "1" });
  assert.equal(w.mock, false);
  assert.equal(w.mockFor?.({}), true);
  assert.equal(w.mockFor?.({ externalId: "ext" }), false);
  // broker 도 시드 환경을 ROLE_NO_EXTERNAL_ID 로 거부하지 않는다 (stub=true 로 발급)
  const b = security.createTempRoleBroker({ issuers: { aws: w }, resolveEnv: async () => ({ roleRef: "arn:aws:iam::000000000000:role/svc-observe" }),
    audit: async () => {} });
  const c = await b.issue({ tenantId: T, envId: randomUUID(), provider: "aws", purpose: "observe", actions: ["eks:DescribeCluster"], ttlSec: 900 });
  assert.equal(c.stub, true);
});

test("가짜 발급기 자격(stub)이면 고객 CLI 를 안 부르고 상태 그대로 (주기 훑기가 시드 환경에 와도 안전)", { skip }, async () => {
  const id = await env(T, "connected");
  let calls = 0;
  const b = security.createTempRoleBroker({ issuers: { aws: security.mockIssuer("aws") }, ledger: ledgerMod.pgLedger(),
    resolveEnv: async () => ({ roleRef: "arn:aws:iam::000000000000:role/svc-observe" }),
    audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)) });
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: req(), reason: "periodic" },
    { roles: b, cli: { exec: async () => { calls++; return { code: 0, stdout: "{}", stderr: "", ms: 1 }; }, env: {} } });
  assert.equal(r.skipped, "stub_credentials");
  assert.equal(calls, 0);
  const e = await row(id);
  assert.equal(e.connection_status, "connected"); assert.equal(e.verify_failures, 0);
  assert.equal((await creds(id))[0].status, "revoked");
});
