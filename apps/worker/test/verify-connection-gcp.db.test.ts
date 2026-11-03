// L7i DB 시험: GCP 연결 확인. 발급기·CLI 는 가짜 (실제 gcloud 호출 없음). DB 없으면 건너뛴다
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
const T = randomUUID(), T2 = randomUUID();
const P = "cust-proj-123";
let number = "123456789012";
let denySql = false;
const delegates: string[] = [];

const exec: Exec = async (cmd, args) => {
  const line = `${cmd} ${args.join(" ")}`;
  const out = (o: unknown, code = 0, err = "") => ({ code, stdout: JSON.stringify(o), stderr: err, ms: 1 });
  if (/^gcloud projects describe/.test(line)) return out({ projectId: P, projectNumber: number });
  if (/^gcloud container clusters list/.test(line)) return out([{ name: "shop", location: "asia-northeast3" }]);
  // GKE can-i: 임시 KUBECONFIG 만들기 + 쿠버네티스 읽기 확인 (verify/gcp.ts 5단계)
  if (/^gcloud container clusters get-credentials /.test(line)) return { code: 0, stdout: "", stderr: "", ms: 1 };
  if (/^kubectl .* auth can-i list deployments/.test(line)) return { code: 0, stdout: "yes\n", stderr: "", ms: 1 };
  if (/^gcloud sql instances list/.test(line)) return denySql ? out(null, 1, "PERMISSION_DENIED") : out([]);
  return out({});
};
const run: import("@svc/security").GcloudRun = async (args) => { delegates.push(args.find((a) => a.startsWith("--delegates="))!); return { code: 0, stdout: "ya29." + "x".repeat(40), stderr: "" }; };

function broker() {
  return security.createTempRoleBroker({
    issuers: { gcp: security.gcpCliIssuer({ platformSa: platform.gcpPlatformSa, platformProject: "svc-platform", run }) },
    ledger: ledgerMod.pgLedger(),
    resolveEnv: async () => ({ roleRef: `svc-observe@${P}.iam.gserviceaccount.com` }),
    audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)),
  });
}
const deps = () => ({ roles: broker(), cli: { exec, env: {} } });
async function env(tenant: string, extra: { number?: string } = {}) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, region, cluster_name, gcp_project_number)
    VALUES ($1,$2,'gcp',$3,'verifying',$4,'asia-northeast3','shop',$5)`, [id, tenant, `g-${id.slice(0, 6)}`, P, extra.number ?? null]);
  return id;
}
const row = async (id: string) => (await owner.query("SELECT connection_status, failure_reason, gcp_project_number, verify_detail FROM environments WHERE id=$1", [id])).rows[0];

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  security = await import("@svc/security");
  platform = await import("../src/platform.js");
  ledgerMod = await import("../src/temp-cred-ledger.js");
  job = await import("../src/jobs/verify-connection.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-l7i'), ($2, 'test-l7i-other')", [T, T2]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("새 회사는 t-<16진 28자> 플랫폼 SA 를 자동으로 받는다 (회사마다 다름)", { skip }, async () => {
  const q = await owner.query("SELECT id, gcp_platform_sa FROM tenants WHERE id = ANY($1)", [[T, T2]]);
  const sas = q.rows.map((r) => r.gcp_platform_sa);
  for (const r of q.rows) assert.match(r.gcp_platform_sa, /^t-[0-9a-f]{28}$/);
  assert.notEqual(sas[0], sas[1]);
});

test("정상: verifying → connected, 프로젝트 번호 고정, 위임 SA 는 이 회사 것, 장부 revoked", { skip }, async () => {
  number = "123456789012"; delegates.length = 0;
  const id = await env(T);
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "user" }, deps());
  assert.equal(r.status, "connected");
  const e = await row(id);
  assert.equal(e.gcp_project_number, "123456789012");
  assert.deepEqual(e.verify_detail.clusters, ["shop"]);
  const sa = (await owner.query("SELECT gcp_platform_sa FROM tenants WHERE id=$1", [T])).rows[0].gcp_platform_sa;
  assert.deepEqual(delegates, [`--delegates=${sa}@svc-platform.iam.gserviceaccount.com`]);
  const c = (await owner.query("SELECT status, revoke_reason FROM temp_credentials WHERE env_id=$1", [id])).rows;
  assert.equal(c.length, 1); assert.equal(c[0].status, "revoked");
});

test("거부: 고정된 프로젝트 번호와 다르면 failed ACCOUNT_MISMATCH, 읽기 권한 없으면 PERMISSION_MISSING, 남의 회사 env 는 건드리지 않음", { skip }, async () => {
  number = "999999999999"; denySql = false;
  const a = await env(T, { number: "123456789012" });
  assert.deepEqual(await job.handleVerifyConnection({ tenantId: T, envId: a, requestId: randomUUID(), reason: "user" }, deps()), { status: "failed", reason: "ACCOUNT_MISMATCH" });
  number = "123456789012"; denySql = true;
  const b = await env(T);
  assert.equal((await job.handleVerifyConnection({ tenantId: T, envId: b, requestId: randomUUID(), reason: "user" }, deps())).reason, "PERMISSION_MISSING:cloudsql.instances.list");
  assert.equal((await row(b)).gcp_project_number, null);
  denySql = false;
  const other = await env(T2);
  const r = await job.handleVerifyConnection({ tenantId: T, envId: other, requestId: randomUUID(), reason: "user" }, deps());
  assert.equal(r.skipped, "env_not_found");
  assert.equal((await row(other)).connection_status, "verifying");
});
