// 검증 묶음 VL4: 연결 확인 작업을 실제 DB 로. 프로필 제거 · 오류→사유 3종 · 사유 있는 실패는 던지지 않음 · 키·계정 번호 로그 없음 · 시드 환경 mock
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import pg from "pg";
import { CliError, type Exec } from "@svc/adapters";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let security: typeof import("@svc/security");
let job: typeof import("../src/jobs/verify-connection.js");
let ledgerMod: typeof import("../src/temp-cred-ledger.js");
let owner: pg.Client;
const T = randomUUID(), T2 = randomUUID();
const ACCT = "111122223333";
// 새면 안 되는 글자들
const SECRETS = ["ASIAFAKEKEY", "FAKESECRETVALUE", "FAKESESSIONTOKEN", ACCT];

const fakeSts = { assumeRole: async () => ({
  Credentials: { AccessKeyId: "ASIAFAKEKEY", SecretAccessKey: "FAKESECRETVALUE", SessionToken: "FAKESESSIONTOKEN", Expiration: new Date(Date.now() + 900_000) } }) };
const TRUST = JSON.stringify({ Statement: [{ Effect: "Allow", Condition: { StringEquals: { "sts:ExternalId": "x" } } }] });
type Call = { line: string; env: NodeJS.ProcessEnv; args: string[] };
let calls: Call[] = [];
let failAt: { re: RegExp; stderr: string } | null = null;
const exec: Exec = async (cmd, args, o) => {
  const line = `${cmd} ${args.join(" ")}`;
  calls.push({ line, env: (o as { env?: NodeJS.ProcessEnv } | undefined)?.env ?? {}, args });
  if (failAt && failAt.re.test(line)) throw new CliError(cmd, args, 254, failAt.stderr);
  const out = (o2: unknown) => ({ code: 0, stdout: typeof o2 === "string" ? o2 : JSON.stringify(o2), stderr: "", ms: 1 });
  if (/^aws eks list-clusters/.test(line)) return out({ clusters: ["shop"] });
  if (/^aws iam get-role/.test(line)) return out({ Role: { AssumeRolePolicyDocument: TRUST } });
  if (/auth can-i/.test(line)) return out("yes\n");
  return out({});
};

function broker(resolveExt = true) {
  return security.createTempRoleBroker({
    issuers: { aws: security.awsStsIssuer({ sts: fakeSts }) },
    ledger: ledgerMod.pgLedger(),
    resolveEnv: async (_t, envId) => ({ roleRef: `arn:aws:iam::${ACCT}:role/svc-observe`, ...(resolveExt ? { externalId: `ext-${envId.slice(0, 8)}` } : {}) }),
    audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)),
  });
}
async function env(tenant: string, status = "verifying") {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region, cluster_name)
    VALUES ($1,$2,'aws',$3,$4,$5,$6,'ap-northeast-2','shop')`, [id, tenant, `e-${id.slice(0, 6)}`, status, ACCT, `ext-${id}`]);
  return id;
}
const row = async (id: string) => (await owner.query("SELECT connection_status, failure_reason FROM environments WHERE id=$1", [id])).rows[0];
const creds = async (id: string) => (await owner.query("SELECT status, revoke_reason, stub FROM temp_credentials WHERE env_id=$1", [id])).rows;
const run = (id: string, tenant = T, cli?: { exec: Exec; env?: NodeJS.ProcessEnv }) =>
  job.handleVerifyConnection({ tenantId: tenant, envId: id, requestId: randomUUID(), reason: "user" }, { roles: broker(), cli: cli ?? { exec } });

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  security = await import("@svc/security");
  ledgerMod = await import("../src/temp-cred-ledger.js");
  job = await import("../src/jobs/verify-connection.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vl4'), ($2, 'test-vl4-other')", [T, T2]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("프로필 제거: 워커 환경에 AWS_PROFILE·장기 키가 있어도 모든 호출(kubeconfig·kubectl 포함)에 안 간다, 빌린 키만, --profile 없음, 임시 kubeconfig 지움", { skip }, async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { AWS_PROFILE: "platform", AWS_DEFAULT_PROFILE: "p2", AWS_ACCESS_KEY_ID: "AKIAOWNLONGLIVED", AWS_SECRET_ACCESS_KEY: "own", AWS_SESSION_TOKEN: "own" });
  try {
    calls = []; failAt = null;
    const id = await env(T);
    const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "user" }, { roles: broker(), cli: { exec } });
    assert.equal(r.status, "connected");
    assert.ok(calls.length >= 7, String(calls.length));
    for (const c of calls) {
      assert.equal(c.env.AWS_PROFILE, undefined, c.line);
      assert.equal(c.env.AWS_DEFAULT_PROFILE, undefined, c.line);
      assert.equal(c.env.AWS_ACCESS_KEY_ID, "ASIAFAKEKEY", c.line);
      assert.equal(c.env.AWS_SESSION_TOKEN, "FAKESESSIONTOKEN", c.line);
      assert.ok(!c.args.includes("--profile"), c.line);
    }
    const kc = calls.find((c) => c.args[1] === "update-kubeconfig")!;
    const path = kc.args[kc.args.indexOf("--kubeconfig") + 1]!;
    assert.equal(existsSync(path), false, "임시 kubeconfig 가 남음");
    assert.equal(existsSync(path.replace(/\/kubeconfig$/, "")), false, "임시 폴더가 남음");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

const CASES: [string, RegExp, string, string][] = [
  ["AccessDenied(rds)", /^aws rds describe-db-instances/, "An error occurred (AccessDenied) when calling the DescribeDBInstances operation: User: arn:aws:sts::111122223333:assumed-role/svc-observe/x", "PERMISSION_MISSING:rds:DescribeDBInstances"],
  ["서비스 제어 정책", /^aws eks describe-cluster/, "An error occurred (AccessDenied) when calling the DescribeCluster operation: ... with an explicit deny in a service control policy", "ORG_POLICY_BLOCKED"],
  ["NoSuchEntity(iam)", /^aws iam get-role/, "An error occurred (NoSuchEntity) when calling the GetRole operation: The role with name svc-operate cannot be found.", "ROLE_NOT_FOUND"],
];
for (const [name, re, stderr, want] of CASES) {
  test(`오류→사유: ${name} → ${want}. 작업은 던지지 않고 끝나고(재시도 없음) env=failed, 빌린 자격 회수`, { skip }, async () => {
    calls = []; failAt = { re, stderr };
    const id = await env(T);
    const r = await run(id);                       // 던지면 여기서 시험이 깨진다
    failAt = null;
    assert.deepEqual(r, { status: "failed", reason: want });
    const e = await row(id);
    assert.equal(e.connection_status, "failed"); assert.equal(e.failure_reason, want);
    const c = await creds(id);
    assert.equal(c.length, 1); assert.equal(c[0].status, "revoked");
    const a = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='env.verify_failed'", [id])).rows;
    assert.equal(a.length, 1);
    for (const s of SECRETS) assert.ok(!JSON.stringify(a[0].detail).includes(s), `감사에 ${s}`);
  });
}

test("정해지지 않은 오류(InvalidClientTokenId)는 던진다(=작업 재시도) — env 는 verifying 그대로, 그래도 자격은 회수", { skip }, async () => {
  calls = []; failAt = { re: /^aws eks list-clusters/, stderr: "An error occurred (InvalidClientTokenId) when calling the ListClusters operation: bad token" };
  const id = await env(T);
  await assert.rejects(run(id), CliError);
  failAt = null;
  assert.equal((await row(id)).connection_status, "verifying");
  const c = await creds(id);
  assert.equal(c.length, 1); assert.equal(c[0].status, "revoked"); assert.equal(c[0].revoke_reason, "verify_done");
});

test("남의 회사 envId: 발급도 CLI 호출도 없고 상태 그대로", { skip }, async () => {
  calls = []; failAt = null;
  const id = await env(T2);
  const r = await run(id, T);
  assert.equal(r.skipped, "env_not_found");
  assert.equal(calls.length, 0);
  assert.equal((await creds(id)).length, 0);
  assert.equal((await row(id)).connection_status, "verifying");
});

test("REAL_STS=1 래퍼 + 장부: external_id 있는 환경 = 진짜(stub=false), 없는 시드 환경 = mock(stub=true) 이고 회수도 된다", { skip }, async () => {
  const { StsCliError: _x, ...rest } = security as unknown as Record<string, unknown>;
  void _x; void rest;
  const w = security.perEnvAwsIssuer(security.awsStsIssuer({ sts: fakeSts }), security.mockIssuer("aws"));
  for (const withExt of [true, false]) {
    const b = security.createTempRoleBroker({ issuers: { aws: w }, ledger: ledgerMod.pgLedger(),
      resolveEnv: async () => ({ roleRef: `arn:aws:iam::${ACCT}:role/svc-observe`, ...(withExt ? { externalId: "ext-1" } : {}) }),
      audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)) });
    const id = await env(T, "connected");
    const c = await b.issue({ tenantId: T, envId: id, provider: "aws", purpose: "observe", actions: ["eks:DescribeCluster"], ttlSec: 900 }, { step: "verify" });
    assert.equal(c.stub, !withExt);
    const m = b.use(c.credentialRef, T);
    assert.equal(m.kind, "aws");
    if (m.kind === "aws") assert.equal(m.accessKeyId.startsWith("ASIAMOCK"), !withExt);
    await b.revoke(c.credentialRef, T, "verify_done");
    const l = await creds(id);
    assert.equal(l.length, 1); assert.equal(l[0].stub, !withExt); assert.equal(l[0].status, "revoked");
  }
});

// 맨 끝: 표준출력을 잠깐 가로채므로 다른 시험 결과 출력과 겹치지 않게 마지막에 둔다
test("출력 키 로그 없음: 성공·실패·던짐 세 경로에서 stdout/stderr/console 어디에도 키·토큰·계정 번호가 없다", { skip }, async () => {
  await new Promise((r) => setTimeout(r, 200));   // 앞 시험 결과 출력이 끝난 뒤에 가로챈다
  const seen: string[] = [];
  const o = { out: process.stdout.write, err: process.stderr.write, log: console.log, warn: console.warn, error: console.error, info: console.info };
  const grab = (...a: unknown[]) => { seen.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? `${x.message}\n${x.stack}` : JSON.stringify(x))).join(" ")); return true; };
  Object.assign(process.stdout, { write: grab }); Object.assign(process.stderr, { write: grab });
  console.log = grab; console.warn = grab; console.error = grab; console.info = grab;
  let thrown = "";
  try {
    console.log("CAPTURE-CHECK");
    failAt = null; calls = [];
    await run(await env(T));
    failAt = CASES[0]![1] && { re: CASES[0]![1], stderr: CASES[0]![2] };
    await run(await env(T));
    failAt = { re: /^aws eks list-clusters/, stderr: "An error occurred (InvalidClientTokenId) when calling: arn:aws:iam::111122223333:role/x" };
    try { await run(await env(T)); } catch (e) { thrown = `${(e as Error).message}`; }
  } finally {
    failAt = null;
    process.stdout.write = o.out; process.stderr.write = o.err;
    console.log = o.log; console.warn = o.warn; console.error = o.error; console.info = o.info;
  }
  await new Promise((r) => setTimeout(r, 50));
  const text = seen.join("\n");
  assert.ok(text.includes("CAPTURE-CHECK"), "가로채기가 안 먹으면 이 시험은 아무것도 못 본다");
  for (const s of ["ASIAFAKEKEY", "FAKESECRETVALUE", "FAKESESSIONTOKEN"]) assert.ok(!text.includes(s), `로그에 ${s}`);
  // 던진 오류 메시지는 계정 번호를 가린다 (CliError scrubAccountIds)
  assert.ok(!thrown.includes(ACCT), `던진 메시지에 계정 번호: ${thrown}`);
});
