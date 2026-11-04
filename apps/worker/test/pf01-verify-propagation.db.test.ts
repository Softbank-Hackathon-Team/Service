// PF01 (실검증 사전 점검 connect·verify AWS 1회차): 막 만든 역할 전파 대기 다시 보기, 플랫폼 자격 만료·재시도 소진 때 verifying 에 안 남음
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
let step: typeof import("../src/jobs/_step.js");
let ledgerMod: typeof import("../src/temp-cred-ledger.js");
let owner: pg.Client;
const T = randomUUID();

// 가짜 STS: 앞의 n 번은 정해진 오류, 그 뒤 성공
let fails: Array<{ code: number; aws: string | null }> = [];
let calls = 0;
const fakeSts = { assumeRole: async () => {
  calls++;
  const f = fails.shift();
  if (f) throw new security.StsCliError(f.code, f.aws);
  return { Credentials: { AccessKeyId: "ASIAFAKE", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(Date.now() + 900_000) } };
} };
let canISeq: string[] = [];
let gdDenied = false;
const TRUST = JSON.stringify({ Statement: [{ Effect: "Allow", Condition: { StringEquals: { "sts:ExternalId": "x" } } }] });
const exec: Exec = async (cmd, args) => {
  const line = `${cmd} ${args.join(" ")}`;
  const out = (o: unknown, code = 0) => ({ code, stdout: typeof o === "string" ? o : JSON.stringify(o), stderr: "", ms: 1 });
  if (/^aws eks list-clusters/.test(line)) return out({ clusters: ["shop"] });
  if (/^aws iam get-role/.test(line)) return out({ Role: { AssumeRolePolicyDocument: TRUST } });
  if (gdDenied && /^aws guardduty/.test(line)) return { code: 254, stdout: "", stderr: "An error occurred (AccessDeniedException) when calling the ListDetectors operation: denied", ms: 1 };
  if (/auth can-i/.test(line)) { const c = canISeq.shift() ?? "yes"; return out(`${c}\n`, c === "yes" ? 0 : 1); }
  return out({});
};
const broker = () => security.createTempRoleBroker({
  issuers: { aws: security.awsStsIssuer({ sts: fakeSts }) },
  ledger: ledgerMod.pgLedger(),
  resolveEnv: async (_t, envId) => ({ roleRef: "arn:aws:iam::111122223333:role/svc-observe", externalId: `ext-${envId.slice(0, 8)}` }),
  audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)),
});
const deps = (delaysMs = [0, 0, 0]) => ({ roles: broker(), cli: { exec, env: {} }, delaysMs });
async function env() {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region, cluster_name)
    VALUES ($1,$2,'aws',$3,'verifying','111122223333',$4,'ap-northeast-2','shop')`, [id, T, `e-${id.slice(0, 6)}`, `ext-${id}`]);
  return id;
}
const row = async (id: string) => (await owner.query("SELECT connection_status, failure_reason FROM environments WHERE id=$1", [id])).rows[0];
const leftIssued = async (id: string) => Number((await owner.query("SELECT count(*) FROM temp_credentials WHERE env_id=$1 AND status='issued'", [id])).rows[0].count);
const run = (id: string, d = deps()) => job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "user" }, d);

before(async () => {
  if (skip) return;
  core = await import("@svc/core"); security = await import("@svc/security");
  ledgerMod = await import("../src/temp-cred-ledger.js"); job = await import("../src/jobs/verify-connection.js"); step = await import("../src/jobs/_step.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-pf01')", [T]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("FM-CLD-06: 막 만든 역할이라 처음 두 번 AssumeRole AccessDenied → 다시 봐서 connected, 빌린 자격은 전부 회수", { skip }, async () => {
  fails = [{ code: 254, aws: "AccessDenied" }, { code: 254, aws: "AccessDenied" }]; calls = 0; canISeq = [];
  const id = await env();
  assert.equal((await run(id)).status, "connected");
  assert.equal(calls, 3);
  assert.equal(await leftIssued(id), 0);
});

test("FM-CLD-06: EKS 접근 항목 전파 전 can-i no → 다시 봐서 connected", { skip }, async () => {
  fails = []; canISeq = ["no", "yes"];
  const id = await env();
  assert.equal((await run(id)).status, "connected");
  assert.equal(await leftIssued(id), 0);
});

test("거부: 계속 AccessDenied 면 간격 수만큼만 다시 보고 failed ROLE_ASSUME_DENIED (끝없이 돌지 않음)", { skip }, async () => {
  fails = Array.from({ length: 10 }, () => ({ code: 254, aws: "AccessDenied" })); calls = 0;
  const id = await env();
  assert.deepEqual(await run(id), { status: "failed", reason: "ROLE_ASSUME_DENIED" });
  assert.equal(calls, 4);   // 처음 1 + 다시 3
  fails = [];
});

test("거부: 다시 보지 않는 사유(권한 없음)는 바로 failed — 기다리지 않음", { skip }, async () => {
  fails = [{ code: 254, aws: "NoSuchEntity" }]; calls = 0;
  const id = await env();
  assert.deepEqual(await run(id, deps([60_000])), { status: "failed", reason: "ROLE_NOT_FOUND" });
  assert.equal(calls, 1);
});

test("FM-ENV-04: 플랫폼 자기 자격 만료(ExpiredToken) → 재시도 없이 failed PLATFORM_CREDENTIALS_INVALID (verifying 에 안 남아 다시 확인 가능)", { skip }, async () => {
  fails = [{ code: 254, aws: "ExpiredToken" }];
  const id = await env();
  assert.deepEqual(await run(id), { status: "failed", reason: "PLATFORM_CREDENTIALS_INVALID" });
  assert.equal((await row(id)).failure_reason, "PLATFORM_CREDENTIALS_INVALID");
  const a = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='env.verify_failed'", [id])).rows;
  assert.equal(a.length, 1);
  assert.ok(!JSON.stringify(a[0].detail).includes("111122223333"), "감사에 계정 번호 없음");
});

test("FM-ENV-04: 알 수 없는 오류는 마지막 시도 전엔 던짐(재시도), 마지막 시도면 failed PLATFORM_ERROR", { skip }, async () => {
  fails = [{ code: 1, aws: "Throttling" }];
  const id = await env();
  await assert.rejects(step.jobAttempt.run({ queue: "verify-connection", retryCount: 0, retryLimit: 3 }, () => run(id)));
  assert.equal((await row(id)).connection_status, "verifying");
  fails = [{ code: 1, aws: "Throttling" }];
  const r = await step.jobAttempt.run({ queue: "verify-connection", retryCount: 3, retryLimit: 3 }, () => run(id));
  assert.deepEqual(r, { status: "failed", reason: "PLATFORM_ERROR" });
  assert.equal((await row(id)).connection_status, "failed");
});

test("PF02 FM-CLD-02: AWS GuardDuty 읽기 권한만 없으면 connected + 사람이 할 일(AWS 문구, gcp-connect.sh 아님)", { skip }, async () => {
  fails = []; canISeq = []; gdDenied = true;
  const id = await env();
  assert.equal((await run(id)).status, "connected");
  const d = (await owner.query("SELECT verify_detail FROM environments WHERE id=$1", [id])).rows[0].verify_detail;
  assert.deepEqual(d.missingPermissions, ["guardduty:ListDetectors"]);
  assert.match(d.needsHuman[0], /연결 스택/); assert.ok(!d.needsHuman[0].includes("gcp-connect"));
  gdDenied = false;
});
