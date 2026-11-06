// #242 DB 시험: inventory-refresh 작업이 관찰 역할을 빌려 그 자격으로만 읽고 결과를 저장하는가. aws CLI 는 PATH 앞 가짜 스크립트 (실제 AWS 호출 없음). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let inv: typeof import("../src/jobs/inventory-refresh.js");
let security: typeof import("@svc/security");
let owner: pg.Client;
const T = randomUUID();
const bin = mkdtempSync(join(tmpdir(), "inv-bin-"));
const envLog = join(bin, "env.log");
const saved = { PATH: process.env.PATH, AWS_PROFILE: process.env.AWS_PROFILE, REAL_STS: process.env.REAL_STS };
const VPC = "vpc-0aaa1111bbbb2222c";
const DESCRIBED = { cluster: { name: "customer-eks", status: "ACTIVE", resourcesVpcConfig: { vpcId: VPC, subnetIds: ["subnet-0a1a1a1a1a1a1a1a1", "subnet-0c3c3c3c3c3c3c3c3"] } } };
const SUBNETS = { Subnets: [
  { SubnetId: "subnet-0a1a1a1a1a1a1a1a1", AvailabilityZone: "ap-northeast-2a", VpcId: VPC, MapPublicIpOnLaunch: false },
  { SubnetId: "subnet-0c3c3c3c3c3c3c3c3", AvailabilityZone: "ap-northeast-2c", VpcId: VPC, MapPublicIpOnLaunch: false },
] };

before(async () => {
  if (skip) return;
  writeFileSync(join(bin, "aws"), `#!/bin/sh
if [ "$1 $2" = "sts assume-role" ]; then
cat <<'J'
${JSON.stringify({ Credentials: { AccessKeyId: "ASIAINVENTORY", SecretAccessKey: "inv-secret", SessionToken: "inv-tok", Expiration: "2099-01-01T00:00:00Z" } })}
J
exit 0
fi
echo "$1 $2 key=$AWS_ACCESS_KEY_ID region=$AWS_REGION profile=\${AWS_PROFILE:-none}" >> ${envLog}
case "$1 $2" in
  "sts get-caller-identity") echo '{"Account":"111122223333"}' ;;
  "eks list-clusters") echo '{"clusters":["customer-eks"]}' ;;
  "eks describe-cluster") echo '${JSON.stringify(DESCRIBED)}' ;;
  "ec2 describe-subnets") echo '${JSON.stringify(SUBNETS)}' ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(join(bin, "aws"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.REAL_STS = "1";
  process.env.AWS_PROFILE = "worker-own-profile";
  core = await import("@svc/core");
  security = await import("@svc/security");
  inv = await import("../src/jobs/inventory-refresh.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-inventory-refresh')", [T]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = saved.PATH;
  if (saved.REAL_STS !== undefined) process.env.REAL_STS = saved.REAL_STS; else delete process.env.REAL_STS;
  if (saved.AWS_PROFILE !== undefined) process.env.AWS_PROFILE = saved.AWS_PROFILE; else delete process.env.AWS_PROFILE;
  await core.pool.end(); await owner.end();
});

async function seed(provider: string, o: { status?: string; account?: string | null; external?: string | null; region?: string | null; cluster?: string } = {}) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region, cluster_name) VALUES ($1,$2,$3,'e',$4,$5,$6,$7,$8)`,
    [id, T, provider, o.status ?? "connected", o.account === undefined ? "111122223333" : o.account, o.external ?? null, o.region ?? null, o.cluster ?? null]);
  return id;
}
const job = (envId: string, tenantId = T) => ({ tenantId, requestId: `r-inv-${envId.slice(0, 8)}`, envId });
const saved1 = async (envId: string) => (await owner.query(`SELECT result, checked_at FROM environment_inventory WHERE environment_id=$1`, [envId])).rows;
const creds = async (envId: string) => (await owner.query("SELECT status, stub, purpose, step, revoke_reason FROM temp_credentials WHERE env_id=$1", [envId])).rows;
const logText = () => existsSync(envLog) ? readFileSync(envLog, "utf8") : "";
const OK_EXEC = () => Promise.resolve({ code: 0, stdout: "[]", stderr: "" });

test("inventory-refresh 정상: 빌린 관찰 키로만 읽고 저장, AWS_PROFILE 없음, 장부 revoked(inventory_done), 비밀 안 남음", { skip }, async () => {
  const id = await seed("aws", { external: `ext-${randomUUID()}`, region: "us-east-1" });
  const before = logText();
  assert.equal(await inv.handleInventoryRefresh(job(id)), "saved");
  const lines = logText().slice(before.length).trim().split("\n");
  assert.ok(lines.some((l) => l.startsWith("eks list-clusters")), lines.join("\n"));
  for (const l of lines) assert.match(l, /key=ASIAINVENTORY region=us-east-1 profile=none/);
  const [row] = await saved1(id);
  assert.ok(row.checked_at);
  assert.equal(row.result.groups.find((g: { category: string }) => g.category === "cluster").items[0].name, "customer-eks");
  assert.ok(!JSON.stringify(row.result).includes("inv-secret"));
  assert.ok(!row.result.scope.includes("worker-own-profile"), row.result.scope);
  assert.deepEqual(await creds(id), [{ status: "revoked", stub: false, purpose: "observe", step: "inventory", revoke_reason: "inventory_done" }]);
});

test("inventory-refresh AWS 도착 사실: 연결 때 적은 EKS 를 같은 빌린 키로 읽어 targetFacts 로 두고, 계획·apply 의 읽기가 그 값을 쓴다", { skip }, async () => {
  const envLayer = await import("../src/env-layer.js");
  const id = await seed("aws", { external: `ext-${randomUUID()}`, region: "ap-northeast-2", cluster: "customer-eks" });
  const before = logText();
  assert.equal(await inv.handleInventoryRefresh(job(id)), "saved");
  const lines = logText().slice(before.length).trim().split("\n");
  for (const c of ["eks describe-cluster", "ec2 describe-subnets"])
    assert.ok(lines.some((l) => l.startsWith(c) && l.includes("key=ASIAINVENTORY region=ap-northeast-2 profile=none")), `${c}: ${lines.join("\n")}`);
  const [row] = await saved1(id);
  assert.equal(row.result.targetFacts.ok, true, JSON.stringify(row.result.targetFacts));
  const facts = { clusterName: "customer-eks", vpcId: VPC, dbSubnetIdsJson: '["subnet-0a1a1a1a1a1a1a1a1","subnet-0c3c3c3c3c3c3c3c3"]' };
  assert.deepEqual(await core.withTenant(T, (tx) => envLayer.readInventoryFacts(tx, id)), { ok: true, facts });
  // 연결 때 적은 클러스터가 바뀌면 예전 읽기는 쓰지 않는다
  await owner.query("UPDATE environments SET cluster_name = 'other-eks' WHERE id = $1", [id]);
  const stale = await core.withTenant(T, (tx) => envLayer.readInventoryFacts(tx, id));
  assert.ok(!stale.ok && /other-eks/.test(stale.reason));
});

test("inventory-refresh 거부: 진짜 발급기인데 가짜 자격(시드 환경)이면 CLI 안 부르고 MOCK_CREDENTIALS 저장, 장부 회수", { skip }, async () => {
  const id = await seed("aws", { external: null });
  const before = logText();
  assert.equal(await inv.handleInventoryRefresh(job(id)), "saved");
  assert.equal(logText(), before, "자식 CLI 를 부르면 안 된다");
  const [row] = await saved1(id);
  assert.equal(row.result.status, "unavailable");
  assert.match(row.result.reason, /MOCK_CREDENTIALS/);
  assert.deepEqual(await creds(id), [{ status: "revoked", stub: true, purpose: "observe", step: "inventory", revoke_reason: "inventory_done" }]);
});

test("inventory-refresh GCP: 빌린 토큰이 CLOUDSDK_AUTH_ACCESS_TOKEN 으로, 프로젝트는 환경 값(워커 GCP_PROJECT 무시), 워커 자기 자격 지움", { skip }, async () => {
  const id = await seed("gcp", { account: "customer-project", region: "asia-northeast1" });
  const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const revoked: string[] = [];
  const roles = {
    issue: async () => ({ credentialRef: "ref-gcp", stub: false, expiresAt: "2099-01-01T00:00:00Z" }),
    use: () => ({ kind: "bearer", token: "borrowed-token" }),
    revoke: async (_r: string, _t: string, why: string) => { revoked.push(why); },
  } as never;
  const exec = (async (_b: string, args: string[], o: { env: NodeJS.ProcessEnv }) => { seen.push({ args, env: o.env }); return { code: 0, stdout: "[]", stderr: "" }; }) as never;
  const env = { GCP_PROJECT: "platform-project", GOOGLE_APPLICATION_CREDENTIALS: "/worker/own.json", CLOUDSDK_CORE_ACCOUNT: "worker@x" };
  assert.equal(await inv.handleInventoryRefresh(job(id), { roles, realSts: true, read: { exec }, env }), "saved");
  assert.ok(seen.length >= 5);
  for (const s of seen) {
    assert.equal(s.env.CLOUDSDK_AUTH_ACCESS_TOKEN, "borrowed-token");
    assert.equal(s.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(s.env.CLOUDSDK_CORE_ACCOUNT, undefined);
    assert.ok(s.args.includes("customer-project") && !s.args.includes("platform-project"), s.args.join(" "));
  }
  const [row] = await saved1(id);
  assert.equal(row.result.scope, "프로젝트 customer-project");
  assert.equal(row.result.region, "asia-northeast1");
  assert.ok(!JSON.stringify(row.result).includes("borrowed-token"));
  assert.deepEqual(revoked, ["inventory_done"]);
});

test("inventory-refresh 거부: 연결 안 된 환경은 역할 안 빌리고 이유 저장", { skip }, async () => {
  const id = await seed("aws", { status: "awaiting_customer", external: `ext-${randomUUID()}` });
  const before = logText();
  await inv.handleInventoryRefresh(job(id));
  assert.equal(logText(), before);
  assert.match((await saved1(id))[0].result.reason, /연결 상태가 아님 \(awaiting_customer\)/);
  assert.equal((await creds(id)).length, 0);
});

test("inventory-refresh 거부: 역할을 못 빌리면 던지지 않고 사유 저장", { skip }, async () => {
  const id = await seed("aws", { external: `ext-${randomUUID()}` });
  const roles = { issue: async () => { throw new security.TempRoleDenied("ROLE_NO_EXTERNAL_ID", "no"); }, use: () => null, revoke: async () => undefined } as never;
  assert.equal(await inv.handleInventoryRefresh(job(id), { roles, realSts: true }), "saved");
  assert.match((await saved1(id))[0].result.reason, /관찰 역할을 못 빌림 \(ROLE_NO_EXTERNAL_ID\)/);
});

test("inventory-refresh: 환경당 1줄 덮어쓰기, 다른 회사 작업은 건너뜀, 큐 내용 모양이 틀리면 던짐", { skip }, async () => {
  const id = await seed("aws", { external: `ext-${randomUUID()}` });
  await inv.handleInventoryRefresh(job(id));
  const first = (await saved1(id))[0].checked_at;
  await new Promise((r) => setTimeout(r, 5));
  await inv.handleInventoryRefresh(job(id));
  const rows = await saved1(id);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].checked_at > first);

  const other = await seed("aws", { external: `ext-${randomUUID()}` });
  const O = randomUUID();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-inventory-other')", [O]);
  assert.equal(await inv.handleInventoryRefresh(job(other, O)), "skipped");
  assert.equal((await saved1(other)).length, 0);

  await assert.rejects(inv.handleInventoryRefresh({ tenantId: T, envId: id }));
});

test("inventory-refresh: 온프레 pull·Azure Mock 은 저장 안 함, INVENTORY_CLI=0 은 CLI 안 부름", { skip }, async () => {
  const on = await seed("onprem", { account: null }), az = await seed("azure_mock", { account: null });
  assert.equal(await inv.handleInventoryRefresh(job(on), { env: {} }), "skipped");
  assert.equal(await inv.handleInventoryRefresh(job(az)), "skipped");
  assert.equal((await saved1(on)).length + (await saved1(az)).length, 0);
  const off = await seed("aws", { external: `ext-${randomUUID()}` });
  await inv.handleInventoryRefresh(job(off), { env: { INVENTORY_CLI: "0" }, read: { exec: OK_EXEC as never } });
  assert.match((await saved1(off))[0].result.reason, /INVENTORY_CLI=0/);
  assert.equal((await creds(off)).length, 0);
});
