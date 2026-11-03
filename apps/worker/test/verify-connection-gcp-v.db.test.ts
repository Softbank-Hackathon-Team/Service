// 검증 묶음 VL7i: GCP 연결 확인 — 회사별 위임 SA, 요청 SA 무시, 번호 고정, 토큰 비노출, 시드(stub) 환경, 오류→사유
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { CliError, type Exec } from "@svc/adapters";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let security: typeof import("@svc/security");
let job: typeof import("../src/jobs/verify-connection.js");
let platform: typeof import("../src/platform.js");
let ledgerMod: typeof import("../src/temp-cred-ledger.js");
let owner: pg.Client;
const T = randomUUID(), T2 = randomUUID();
const PROJ = "cust-proj-123";
const TOKEN = "ya29.SECRETTOKENVALUE" + "x".repeat(30);
let number = "123456789012";
let describeId = PROJ;
let fail: { re: RegExp; stderr: string } | null = null;
let calls: { line: string; env: NodeJS.ProcessEnv }[] = [];
let issueArgs: string[][] = [];
let issueEnvs: NodeJS.ProcessEnv[] = [];
let platformSaOverride: ((t: string) => Promise<string | undefined>) | null = null;

const exec: Exec = async (cmd, args, o) => {
  const line = `${cmd} ${args.join(" ")}`;
  calls.push({ line, env: (o as { env?: NodeJS.ProcessEnv } | undefined)?.env ?? {} });
  if (fail && fail.re.test(line)) throw new CliError(cmd, args, 1, fail.stderr);
  const out = (o2: unknown) => ({ code: 0, stdout: JSON.stringify(o2), stderr: "", ms: 1 });
  if (/^gcloud projects describe/.test(line)) return out({ projectId: describeId, projectNumber: number });
  if (/^gcloud container clusters list/.test(line)) return out([{ name: "shop", location: "asia-northeast3" }]);
  // GKE can-i: 임시 KUBECONFIG 만들기 + 쿠버네티스 읽기 확인 (verify/gcp.ts 5단계)
  if (/^gcloud container clusters get-credentials /.test(line)) return { code: 0, stdout: "", stderr: "", ms: 1 };
  if (/^kubectl .* auth can-i list deployments/.test(line)) return { code: 0, stdout: "yes\n", stderr: "", ms: 1 };
  return out([]);
};
const run: import("@svc/security").GcloudRun = async (args, env) => { issueArgs.push(args); issueEnvs.push(env); return { code: 0, stdout: TOKEN, stderr: "" }; };

function broker(roleRef = `svc-observe@${PROJ}.iam.gserviceaccount.com`) {
  const real = security.gcpCliIssuer({ platformSa: (t) => (platformSaOverride ?? platform.gcpPlatformSa)(t), platformProject: "svc-platform", run, env: { CLOUDSDK_AUTH_ACCESS_TOKEN: "OWNTOKEN", PATH: "/bin" } });
  return security.createTempRoleBroker({
    issuers: { gcp: security.perEnvGcpIssuer(real, security.mockIssuer("gcp")) },
    ledger: ledgerMod.pgLedger(),
    resolveEnv: async () => ({ roleRef }),
    audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)),
  });
}
async function env(tenant: string, o: { status?: string; account?: string; cluster?: string | null; number?: string | null } = {}) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, region, cluster_name, gcp_project_number)
    VALUES ($1,$2,'gcp',$3,$4,$5,'asia-northeast3',$6,$7)`, [id, tenant, `g-${id.slice(0, 6)}`, o.status ?? "verifying", o.account ?? PROJ,
    o.cluster === undefined ? "shop" : o.cluster, o.number ?? null]);
  return id;
}
const row = async (id: string) => (await owner.query("SELECT connection_status, failure_reason, gcp_project_number, verify_detail, verify_failures FROM environments WHERE id=$1", [id])).rows[0];
const run1 = (id: string, tenant = T, reason: "user" | "periodic" = "user", roleRef?: string) =>
  job.handleVerifyConnection({ tenantId: tenant, envId: id, requestId: randomUUID(), reason }, { roles: broker(roleRef), cli: { exec, env: { GOOGLE_APPLICATION_CREDENTIALS: "/own.json", CLOUDSDK_AUTH_ACCESS_TOKEN: "OWNTOKEN", PATH: "/bin" } } });
const reset = () => { calls = []; issueArgs = []; issueEnvs = []; fail = null; number = "123456789012"; describeId = PROJ; platformSaOverride = null; };

before(async () => {
  if (skip) return;
  core = await import("@svc/core"); security = await import("@svc/security"); platform = await import("../src/platform.js");
  ledgerMod = await import("../src/temp-cred-ledger.js"); job = await import("../src/jobs/verify-connection.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vl7i'), ($2,'test-vl7i-other')", [T, T2]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("회사마다 다른 위임 SA: 두 회사가 같은 프로젝트 이름의 환경을 확인해도 --delegates 는 각자 DB 값", { skip }, async () => {
  reset();
  await run1(await env(T)); await run1(await env(T2), T2);
  const sas = (await owner.query("SELECT id, gcp_platform_sa FROM tenants WHERE id = ANY($1)", [[T, T2]])).rows;
  const sa = (id: string) => sas.find((r) => r.id === id).gcp_platform_sa;
  assert.deepEqual(issueArgs.map((a) => a.find((x) => x.startsWith("--delegates="))),
    [`--delegates=${sa(T)}@svc-platform.iam.gserviceaccount.com`, `--delegates=${sa(T2)}@svc-platform.iam.gserviceaccount.com`]);
  assert.notEqual(sa(T), sa(T2));
});

test("요청 SA 무시: 고객 SA 모양이 아닌 roleRef(다른 SA·대문자·이메일 두 개)는 gcloud 를 부르지 않고 ROLE_NOT_FOUND", { skip }, async () => {
  for (const bad of [`admin@${PROJ}.iam.gserviceaccount.com`, `svc-admin@${PROJ}.iam.gserviceaccount.com`,
    `svc-observe@${PROJ}.iam.gserviceaccount.com,owner@x.iam.gserviceaccount.com`, `SVC-OBSERVE@${PROJ}.iam.gserviceaccount.com`,
    `svc-observe@${PROJ}.evil.com`]) {
    reset();
    const issuer = security.gcpCliIssuer({ platformSa: async () => "t-" + "a".repeat(28), platformProject: "svc-platform", run });
    await assert.rejects(issuer.issue({ roleRef: bad, now: new Date(), req: { tenantId: T, ttlSec: 900 } } as never),
      (e: Error & { reason?: string }) => e.reason === "ROLE_NOT_FOUND", bad);
    assert.equal(issueArgs.length, 0, bad);
  }
});

test("플랫폼 SA 값이 DB 에 없거나 모양이 틀리면 던진다(재시도) — gcloud 는 안 부름, env 는 verifying 그대로, 고객 실패로 기록 안 함", { skip }, async () => {
  for (const sa of [undefined, "t-short", "../../etc", "T-" + "A".repeat(28)]) {
    reset(); platformSaOverride = async () => sa;
    const id = await env(T);
    await assert.rejects(run1(id), /PLATFORM_SA_MISSING/);
    assert.equal(issueArgs.length, 0); assert.equal(calls.length, 0);
    const e = await row(id);
    assert.equal(e.connection_status, "verifying"); assert.equal(e.failure_reason, null);
  }
});

test("토큰은 환경변수로만: verify CLI 호출 인자·감사·장부·verify_detail 어디에도 없고, 워커 자기 자격(GOOGLE_APPLICATION_CREDENTIALS 등)은 지워진다", { skip }, async () => {
  reset();
  const id = await env(T);
  assert.equal((await run1(id)).status, "connected");
  assert.ok(calls.length >= 4);
  for (const c of calls) {
    assert.ok(!c.line.includes("SECRETTOKEN"), c.line);
    assert.equal(c.env.CLOUDSDK_AUTH_ACCESS_TOKEN, TOKEN);
    assert.equal(c.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(c.env.CLOUDSDK_CORE_PROJECT, PROJ);
  }
  assert.equal(issueEnvs[0]!.CLOUDSDK_AUTH_ACCESS_TOKEN, undefined, "발급 호출은 워커 자기 토큰을 안 씀");
  const dump = JSON.stringify([
    (await owner.query("SELECT detail FROM audit_events WHERE target = ANY($1)", [[id]])).rows,
    (await owner.query("SELECT * FROM temp_credentials WHERE env_id=$1", [id])).rows,
    (await row(id)).verify_detail,
  ]);
  assert.ok(!dump.includes("SECRETTOKEN"), "토큰이 DB 에 남음");
});

test("프로젝트 번호: 첫 성공에 고정, 같은 번호는 통과, 다른 번호·프로젝트 ID 불일치는 ACCOUNT_MISMATCH, 숫자 아닌/짧은 번호도 던지지 않고 ACCOUNT_MISMATCH", { skip }, async () => {
  reset();
  const a = await env(T); await run1(a);
  assert.equal((await row(a)).gcp_project_number, "123456789012");
  const same = await env(T, { number: "123456789012" });
  assert.equal((await run1(same)).status, "connected");
  number = "555555555555";
  const diff = await env(T, { number: "123456789012" });
  assert.deepEqual(await run1(diff), { status: "failed", reason: "ACCOUNT_MISMATCH" });
  assert.equal((await row(diff)).gcp_project_number, "123456789012");       // 고정값은 안 바뀜
  number = "123456789012"; describeId = "someone-elses-proj";
  assert.deepEqual(await run1(await env(T)), { status: "failed", reason: "ACCOUNT_MISMATCH" });
  describeId = PROJ;
  for (const bad of ["12345", "abc123456789", ""]) {
    number = bad;
    const id = await env(T);
    const r = await run1(id);                                               // 던지면 CHECK 위반(트랜잭션 통째 실패)
    assert.deepEqual(r, { status: "failed", reason: "ACCOUNT_MISMATCH" }, `번호 "${bad}"`);
    assert.equal((await row(id)).gcp_project_number, null);
  }
});

test("오류→사유: describe 권한 없음 / 조직 정책 / 클러스터 목록에 없음 / 실행 SA 없음 — 모두 던지지 않고 failed, 알 수 없는 오류는 던짐", { skip }, async () => {
  const cases: [string, RegExp, string, string][] = [
    ["describe 권한", /^gcloud projects describe/, "ERROR: (gcloud.projects.describe) PERMISSION_DENIED: The caller does not have permission", "PERMISSION_MISSING:resourcemanager.projects.get"],
    ["조직 정책", /^gcloud container clusters list/, "Request is prohibited by organization's policy. constraints/gcp.resourceLocations", "ORG_POLICY_BLOCKED"],
    ["VPC-SC", /^gcloud sql instances list/, "VPC_SERVICE_CONTROLS violation 403", "ORG_POLICY_BLOCKED"],
    ["sql 권한", /^gcloud sql instances list/, "403 Forbidden", "PERMISSION_MISSING:cloudsql.instances.list"],
    ["실행 SA 없음", /^gcloud iam service-accounts describe/, "NOT_FOUND: Unknown service account", "ROLE_NOT_FOUND"],
  ];
  for (const [name, re, stderr, want] of cases) {
    reset(); fail = { re, stderr };
    const r = await run1(await env(T));
    assert.deepEqual(r, { status: "failed", reason: want }, name);
  }
  reset(); fail = { re: /^gcloud container clusters list/, stderr: "ERROR: some weird backend error 500" };
  const id = await env(T);
  await assert.rejects(run1(id), CliError);
  assert.equal((await row(id)).connection_status, "verifying");
  reset();
  const noCluster = await env(T, { cluster: "other-cluster" });
  assert.equal((await run1(noCluster)).reason, "K8S_ACCESS_MISSING");
  const anyCluster = await env(T, { cluster: null });
  assert.equal((await run1(anyCluster)).status, "connected");
});

test("시드(stub) GCP 환경: 프로젝트가 stub 모양이면 mock 발급 → CLI 0번, 사용자 확인은 connected(mock), 주기는 그대로", { skip }, async () => {
  reset();
  const u = await env(T, { account: "stub" });
  const r = await run1(u, T, "user", "svc-observe@stub");
  assert.equal(r.status, "connected"); assert.equal(calls.length, 0); assert.equal(issueArgs.length, 0);
  assert.equal((await row(u)).verify_detail.mock, true);
  const p = await env(T, { account: "stub", status: "connected" });
  assert.equal((await run1(p, T, "periodic", "svc-observe@stub")).skipped, "stub_credentials");
  assert.equal(calls.length, 0);
});

test("남의 회사 GCP env 작업 → 발급도 CLI 도 없고 상태 그대로", { skip }, async () => {
  reset();
  const id = await env(T2);
  assert.equal((await run1(id, T)).skipped, "env_not_found");
  assert.equal(calls.length, 0); assert.equal(issueArgs.length, 0);
  assert.equal((await row(id)).connection_status, "verifying");
});
