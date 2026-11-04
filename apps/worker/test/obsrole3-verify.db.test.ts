// OBSROLE3 DB 시험: GCP 연결 확인이 관찰 역할의 빠진 선택 권한을 사람이 할 일(needsHuman)로 남긴다. 발급기·CLI 는 가짜. DB 없으면 건너뛴다
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
let denied = new Set<string>();
const lines: string[] = [];
const delegates: string[] = [];

const exec: Exec = async (cmd, args) => {
  const line = `${cmd} ${args.join(" ")}`;
  const out = (o: unknown, code = 0, err = "") => ({ code, stdout: JSON.stringify(o), stderr: err, ms: 1 });
  lines.push(line);
  for (const d of denied) if (new RegExp(`^gcloud ${d}`).test(line)) return out(null, 1, "ERROR: (gcloud) PERMISSION_DENIED: Permission denied");
  if (/^gcloud projects describe/.test(line)) return out({ projectId: P, projectNumber: number });
  if (/^gcloud container clusters list/.test(line)) return out([{ name: "shop", location: "asia-northeast3" }]);
  // GKE can-i: 임시 KUBECONFIG 만들기 + 쿠버네티스 읽기 확인 (verify/gcp.ts 5단계)
  if (/^gcloud container clusters get-credentials /.test(line)) return { code: 0, stdout: "", stderr: "", ms: 1 };
  if (/^kubectl .* auth can-i list deployments/.test(line)) return { code: 0, stdout: "yes\n", stderr: "", ms: 1 };
  if (/^gcloud sql instances list/.test(line)) return denySql ? out(null, 1, "PERMISSION_DENIED") : out([]);
  return out({});
};
const run: import("@svc/security").GcloudRun = async (args) => { delegates.push(args.find((a) => a.startsWith("--impersonate-service-account="))!.split("=")[1]!.split(",")[0]!); return { code: 0, stdout: "ya29." + "x".repeat(40), stderr: "" }; };

function broker() {
  return security.createTempRoleBroker({
    issuers: { gcp: security.gcpCliIssuer({ platformSa: platform.gcpPlatformSa, platformProject: "svc-platform", run }) },
    ledger: ledgerMod.pgLedger(),
    resolveEnv: async () => ({ roleRef: `svc-observe@${P}.iam.gserviceaccount.com` }),
    audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)),
  });
}
const deps = () => ({ roles: broker(), cli: { exec, env: {} } });
async function env(tenant: string, extra: { number?: string; status?: string } = {}) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, region, cluster_name, gcp_project_number)
    VALUES ($1,$2,'gcp',$3,$6,$4,'asia-northeast3','shop',$5)`, [id, tenant, `g-${id.slice(0, 6)}`, P, extra.number ?? null, extra.status ?? "verifying"]);
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-obsrole3'), ($2, 'test-obsrole3-other')", [T, T2]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

const PROBE = /^gcloud (projects get-iam-policy|services list|compute |artifacts |secrets list|storage buckets list|pubsub |redis )/;
const auditOf = async (id: string, action: string) => (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action=$2 ORDER BY seq DESC LIMIT 1", [id, action])).rows[0];
const reset = () => { denied = new Set(); denySql = false; lines.length = 0; delegates.length = 0; number = "123456789012"; };

test("정상: 선택 권한이 다 있으면 connected, verify_detail 에 missingPermissions·needsHuman 없음", { skip }, async () => {
  reset();
  const id = await env(T);
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "user" }, deps());
  assert.equal(r.status, "connected");
  const e = await row(id);
  assert.deepEqual(Object.keys(e.verify_detail).sort(), ["checkedAt", "clusters"]);
  assert.ok(lines.filter((l) => PROBE.test(l)).length >= 11, "사용자 확인에서는 선택 권한을 찔러 봄");
});

test("선택 권한이 빠진 관찰 역할: 실패로 바꾸지 않고 connected + 빠진 권한·할 일(needsHuman)·감사에 남김", { skip }, async () => {
  reset(); denied = new Set(["secrets list", "redis instances list", "compute forwarding-rules list"]);
  const id = await env(T);
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "user" }, deps());
  assert.equal(r.status, "connected");
  const e = await row(id);
  assert.equal(e.connection_status, "connected");
  assert.equal(e.failure_reason, null);
  assert.deepEqual(e.verify_detail.missingPermissions, ["compute.forwardingRules.list", "compute.globalForwardingRules.list", "redis.instances.list", "secretmanager.secrets.list"]);
  assert.equal(e.verify_detail.needsHuman.length, 1);
  assert.match(e.verify_detail.needsHuman[0], /gcp-connect\.sh/);
  assert.match(e.verify_detail.needsHuman[0], /secretmanager\.secrets\.list/);
  assert.equal(e.verify_detail.needsHuman[0], job.needsHumanText(e.verify_detail.missingPermissions));
  assert.deepEqual((await auditOf(id, "env.verified")).detail.missingPermissions, e.verify_detail.missingPermissions);
});

test("거부: 필수 권한(sql)이 없으면 선택 권한 여부와 상관없이 failed, 선택 찌르기는 안 함", { skip }, async () => {
  reset(); denySql = true; denied = new Set(["secrets list"]);
  const id = await env(T);
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "user" }, deps());
  assert.equal(r.status, "failed");
  assert.equal((await row(id)).failure_reason, "PERMISSION_MISSING:cloudsql.instances.list");
  assert.equal(lines.filter((l) => PROBE.test(l)).length, 0);
});

test("주기 재확인(periodic)은 선택 권한을 찌르지 않는다 (호출 수 그대로)", { skip }, async () => {
  reset(); denied = new Set(["secrets list"]);
  const id = await env(T, { status: "connected", number: "123456789012" });
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "periodic" }, deps());
  assert.equal(r.status, "connected");
  assert.equal(lines.filter((l) => PROBE.test(l)).length, 0);
  assert.equal((await row(id)).verify_detail.missingPermissions, undefined);
});

// ---- VOBSROLE3: 알림 수명·멱등 ----
const userVerify = async (id: string) => {
  await owner.query("UPDATE environments SET connection_status='verifying' WHERE id=$1", [id]);   // 화면의 "확인" 버튼 (시험 준비라 owner 로)
  return job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "user" }, deps());
};

test("VOBSROLE3: 고객이 스크립트를 다시 돌려 권한을 채우면 다음 사용자 확인에서 빠진 권한·할 일이 사라진다 (connected 그대로)", { skip }, async () => {
  reset(); denied = new Set(["secrets list", "redis instances list"]);
  const id = await env(T);
  await userVerify(id);
  assert.deepEqual((await row(id)).verify_detail.missingPermissions, ["redis.instances.list", "secretmanager.secrets.list"]);
  denied = new Set();
  const r = await userVerify(id);
  assert.equal(r.status, "connected");
  const e = await row(id);
  assert.equal(e.connection_status, "connected");
  assert.equal(e.verify_detail.missingPermissions, undefined);
  assert.equal(e.verify_detail.needsHuman, undefined);
  assert.equal((await auditOf(id, "env.verified")).detail.missingPermissions, undefined);
});

test("VOBSROLE3: 주기 재확인(찌르지 않음)은 지난 사용자 확인의 빠진 권한·할 일을 지우지 않는다 (찾은 버그)", { skip }, async () => {
  reset(); denied = new Set(["secrets list"]);
  const id = await env(T);
  await userVerify(id);
  const before = (await row(id)).verify_detail;
  assert.deepEqual(before.missingPermissions, ["secretmanager.secrets.list"]);
  const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "periodic" }, deps());
  assert.equal(r.status, "connected");
  const after = (await row(id)).verify_detail;
  assert.deepEqual(after.missingPermissions, before.missingPermissions);
  assert.deepEqual(after.needsHuman, before.needsHuman);
  assert.notEqual(after.checkedAt, undefined);
  // 빠진 게 없던 환경은 주기 재확인 뒤에도 키가 안 생김
  reset();
  const ok = await env(T, { status: "connected", number: "123456789012" });
  await job.handleVerifyConnection({ tenantId: T, envId: ok, requestId: randomUUID(), reason: "periodic" }, deps());
  assert.deepEqual(Object.keys((await row(ok)).verify_detail).sort(), ["checkedAt", "clusters"]);
});

test("VOBSROLE3 멱등: 같은 빠진 권한으로 두 번 확인해도 상세는 같고(시각 빼고), 감사는 확인마다 한 줄", { skip }, async () => {
  reset(); denied = new Set(["services list", "secrets list"]);
  const id = await env(T);
  await userVerify(id);
  const a = (await row(id)).verify_detail;
  await userVerify(id);
  const b = (await row(id)).verify_detail;
  delete a.checkedAt; delete b.checkedAt;
  assert.deepEqual(a, b);
  const n = (await owner.query("SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='env.verified'", [id])).rows[0].n;
  assert.equal(n, 2);
});

test("VOBSROLE3 거부: 다른 회사 작업으로는 남의 환경을 확인하지 못하고 상태·상세가 안 바뀐다", { skip }, async () => {
  reset(); denied = new Set(["secrets list"]);
  const id = await env(T);
  const before = await row(id);
  await job.handleVerifyConnection({ tenantId: T2, envId: id, requestId: randomUUID(), reason: "user" }, deps()).catch(() => null);
  assert.deepEqual(await row(id), before);
});

test("VVERIFYAPI SSE: 빠진 권한으로 끝난 연결 확인은 이전 화면 신호(migration_events)를 하나도 안 보낸다 (환경 신호는 TODO(human))", { skip }, async () => {
  reset(); denied = new Set(["secrets list"]);
  const id = await env(T);
  const l = new pg.Client({ connectionString: OWNER }); await l.connect();
  const got: string[] = [];
  l.on("notification", (n) => { if (n.channel === "migration_events") got.push(n.payload ?? ""); });
  await l.query("LISTEN migration_events");
  try {
    const r = await job.handleVerifyConnection({ tenantId: T, envId: id, requestId: randomUUID(), reason: "user" }, deps());
    assert.equal(r.status, "connected");
    assert.deepEqual((await row(id)).verify_detail.missingPermissions, ["secretmanager.secrets.list"]);
    await l.query("SELECT 1");
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(got.filter((p) => p.includes(id)), [], "환경 id 로 나간 신호 없음");
  } finally { await l.end(); }
});
