// FM-GCP-03 DB 시험: 고객이 gcp-connect.sh 를 막 끝낸 직후(IAM 전파 전) 사용자가 누른 GCP 확인은 같은 작업 안에서 몇 번 다시 본다
//   가짜 gcloud 만 (실제 호출 없음). DB 없으면 건너뛴다
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
let platform: typeof import("../src/platform.js");
let ledgerMod: typeof import("../src/temp-cred-ledger.js");
let owner: pg.Client;
const T = randomUUID();
const P = "cust-proj-456";
let failFirst = 0, calls = 0;
const DENY = "ERROR: (gcloud.auth.print-access-token) Failed to impersonate [svc-observe@cust-proj-456.iam.gserviceaccount.com]. Make sure the account that's trying to impersonate it has access";

const exec: Exec = async (cmd, args) => {
  const line = `${cmd} ${args.join(" ")}`;
  const out = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "", ms: 1 });
  if (/^gcloud projects describe/.test(line)) return out({ projectId: P, projectNumber: "123456789099" });
  if (/^gcloud container clusters list/.test(line)) return out([{ name: "shop", location: "asia-northeast3" }]);
  if (/^gcloud container clusters get-credentials /.test(line)) return { code: 0, stdout: "", stderr: "", ms: 1 };
  if (/^kubectl .* auth can-i list deployments/.test(line)) return { code: 0, stdout: "yes\n", stderr: "", ms: 1 };
  if (/^gcloud sql instances list/.test(line)) return out([]);
  return out({});
};
const run: import("@svc/security").GcloudRun = async () => {
  calls++;
  return calls <= failFirst ? { code: 1, stdout: "", stderr: DENY } : { code: 0, stdout: "ya29." + "x".repeat(40), stderr: "" };
};
function broker() {
  return security.createTempRoleBroker({
    issuers: { gcp: security.gcpCliIssuer({ platformSa: platform.gcpPlatformSa, platformProject: "svc-platform", run }) },
    ledger: ledgerMod.pgLedger(),
    resolveEnv: async () => ({ roleRef: `svc-observe@${P}.iam.gserviceaccount.com` }),
    audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)),
  });
}
async function env(status = "verifying") {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, region, cluster_name)
    VALUES ($1,$2,'gcp',$3,$4,$5,'asia-northeast3','shop')`, [id, T, `p-${id.slice(0, 6)}`, status, P]);
  return id;
}
const row = async (id: string) => (await owner.query("SELECT connection_status, failure_reason FROM environments WHERE id=$1", [id])).rows[0];

before(async () => {
  if (skip) return;
  process.env.GCP_VERIFY_RETRY_MS = "0";
  core = await import("@svc/core");
  security = await import("@svc/security");
  platform = await import("../src/platform.js");
  ledgerMod = await import("../src/temp-cred-ledger.js");
  job = await import("../src/jobs/verify-connection.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-fm-gcp-03')", [T]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("FM-GCP-03: 전파 전 거부 2번 뒤 성공 → 같은 작업에서 connected (사람이 verify 를 다시 안 쳐도 됨)", { skip }, async () => {
  failFirst = 2; calls = 0;
  const id = await env();
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "user" }, { roles: broker(), cli: { exec, env: {} } });
  assert.equal(r.status, "connected");
  assert.equal(calls, 3);
  assert.equal((await row(id)).connection_status, "connected");
});

test("FM-GCP-03 거부: 계속 거부면 GCP_VERIFY_ATTEMPTS(4)번 뒤 failed ROLE_ASSUME_DENIED, 더 안 부름", { skip }, async () => {
  failFirst = 100; calls = 0;
  const id = await env();
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "user" }, { roles: broker(), cli: { exec, env: {} } });
  assert.equal(r.status, "failed");
  assert.equal(calls, 4);
  assert.equal((await row(id)).failure_reason, "ROLE_ASSUME_DENIED");
});

test("FM-GCP-03: 주기 훑기(periodic)는 다시 보지 않는다 (한 번만 부름)", { skip }, async () => {
  failFirst = 100; calls = 0;
  const id = await env("connected");
  await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "periodic" }, { roles: broker(), cli: { exec, env: {} } });
  assert.equal(calls, 1);
});
