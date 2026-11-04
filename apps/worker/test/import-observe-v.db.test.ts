// 검증 묶음 VL5: L5 추가 시험 (빌린 자격의 범위·반납·거부·동시 배달). aws·kubectl 은 PATH 앞 가짜 스크립트 (실제 호출 0)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let owner: pg.Client;
const T = randomUUID();
const bin = mkdtempSync(join(tmpdir(), "vl5-bin-"));
const myTmp = mkdtempSync(join(tmpdir(), "vl5-tmp-"));
const log = join(bin, "calls.log"), mode = join(bin, "mode");
const saved = { TMPDIR: process.env.TMPDIR, PATH: process.env.PATH, MOCK_SEED: process.env.MOCK_SEED, AWS_PROFILE: process.env.AWS_PROFILE, EKS: process.env.IMPORT_AWS_EKS_CLUSTER };
const setMode = (m: string) => writeFileSync(mode, m);
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const resetLog = () => writeFileSync(log, "");

before(async () => {
  if (skip) return;
  writeFileSync(log, "");
  // 가짜 aws. mode 파일: ok | denied(assume-role AccessDenied) | net(assume-role 네트워크 오류) | listfail(eks list-clusters 네트워크 오류)
  writeFileSync(join(bin, "aws"), `#!/bin/sh
M=$(cat ${mode} 2>/dev/null || echo ok)
if [ "$1 $2" = "sts assume-role" ]; then
  [ "$M" = denied ] && { echo "An error occurred (AccessDenied) when calling the AssumeRole operation: not authorized" >&2; exit 254; }
  [ "$M" = net ] && { echo "Could not connect to the endpoint URL: https://sts.ap-northeast-2.amazonaws.com/" >&2; exit 255; }
  echo '${JSON.stringify({ Credentials: { AccessKeyId: "ASIAVL5KEY", SecretAccessKey: "vl5-secret-xyz", SessionToken: "vl5-tok", Expiration: "2099-01-01T00:00:00Z" } })}'
  exit 0
fi
echo "aws $1 $2 $3 $4 key=$AWS_ACCESS_KEY_ID profile=\${AWS_PROFILE:-none} dprofile=\${AWS_DEFAULT_PROFILE:-none}" >> ${log}
case "$1 $2" in
  "sts get-caller-identity") echo '{"Account":"111122223333"}' ;;
  "eks list-clusters") [ "$M" = listfail ] && { echo "Could not connect to the endpoint URL" >&2; exit 255; }; echo '{"clusters":["c1","c2"]}' ;;
  "eks describe-cluster") echo '{"cluster":{"version":"1.30","resourcesVpcConfig":{"vpcId":"vpc-1"}}}' ;;
  "eks update-kubeconfig") : ;;
  *) echo '{}' ;;
esac
`);
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh
echo "kubectl $1 $2 key=$AWS_ACCESS_KEY_ID profile=\${AWS_PROFILE:-none} dprofile=\${AWS_DEFAULT_PROFILE:-none} kc=\${KUBECONFIG:-none}" >> ${log}
echo "forbidden" >&2; exit 1
`);
  chmodSync(join(bin, "aws"), 0o755); chmodSync(join(bin, "kubectl"), 0o755);
  setMode("ok");
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.TMPDIR = myTmp;   // os.tmpdir() 는 부를 때마다 TMPDIR 를 읽는다
  process.env.REAL_STS = "1";
  process.env.AWS_PROFILE = "worker-own-profile";
  delete process.env.MOCK_SEED;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vl5')", [T]);
});
after(async () => {
  if (skip) return;
  if (saved.TMPDIR !== undefined) process.env.TMPDIR = saved.TMPDIR; else delete process.env.TMPDIR;
  process.env.PATH = saved.PATH; delete process.env.REAL_STS;
  if (saved.MOCK_SEED !== undefined) process.env.MOCK_SEED = saved.MOCK_SEED;
  if (saved.AWS_PROFILE !== undefined) process.env.AWS_PROFILE = saved.AWS_PROFILE; else delete process.env.AWS_PROFILE;
  if (saved.EKS !== undefined) process.env.IMPORT_AWS_EKS_CLUSTER = saved.EKS; else delete process.env.IMPORT_AWS_EKS_CLUSTER;
  await core.pool.end(); await owner.end(); rmSync(bin, { recursive: true, force: true }); rmSync(myTmp, { recursive: true, force: true });
});

async function seed(status: string, extId: string | null = "auto") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region) VALUES
    ($1,$3,'aws','s',$4,'111122223333',$5,'ap-northeast-2'), ($2,$3,'gcp','d','connected','vl5-project',NULL,NULL)`,
    [src, dst, T, status, extId === "auto" ? `ext-${src}` : extId]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
const job = (id: string, tenantId = T) => ({ tenantId, requestId: `r-vl5-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const creds = async (id: string) => (await owner.query("SELECT status, stub, revoke_reason FROM temp_credentials WHERE migration_id=$1", [id])).rows;
// FLAKY 고침: 임시 폴더 검사는 이 파일 전용 TMPDIR 안에서만 본다. 예전엔 시스템 tmp 전체에서 svc-import- 를 세서,
//   test:db 가 동시에 도는 다른 파일(import-observe, 가져오기를 부르는 시험)의 진행 중 폴더가 잡혀 가끔 실패했다
const kubeDirs = () => readdirSync(myTmp).filter((n) => n.startsWith("svc-import-"));

test("빌린 자격은 aws·kubectl 자식 모두에 들어가고(AWS_PROFILE 없음), 끝나면 반납(import_done), 비밀은 장부·감사 어디에도 없다", { skip }, async () => {
  setMode("ok"); resetLog();
  const id = await seed("connected");
  await imp.handleImport(job(id));
  const c = calls();
  assert.ok(c.some((l) => l.startsWith("kubectl")), "kubectl 까지 가야 함: " + c.join("\n"));
  for (const l of c) { assert.match(l, /key=ASIAVL5KEY/, l); assert.match(l, /profile=none dprofile=none/, l); }
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" });   // kubectl 403 = 사람이 고칠 일
  assert.deepEqual(await creds(id), [{ status: "revoked", stub: false, revoke_reason: "import_done" }]);
  const dump = JSON.stringify([(await owner.query("SELECT * FROM temp_credentials WHERE migration_id=$1", [id])).rows,
    (await owner.query("SELECT detail FROM audit_events WHERE target=$1", [id])).rows]);
  for (const s of ["vl5-secret-xyz", "vl5-tok"]) assert.ok(!dump.includes(s), `${s} 가 장부·감사에 남음`);
});

test("IMPORT_AWS_EKS_CLUSTER 가 빌린 env 경로에서도 먹는다 (c2 선택)", { skip }, async () => {
  setMode("ok"); resetLog(); process.env.IMPORT_AWS_EKS_CLUSTER = "c2";
  try { await imp.handleImport(job(await seed("connected"))); } finally { delete process.env.IMPORT_AWS_EKS_CLUSTER; }
  const d = calls().find((l) => l.startsWith("aws eks describe-cluster"))!;
  assert.match(d, /--name c2/);
});

test("읽기 호출은 전부 IMPORT_OBSERVE_ACTIONS 안이고 쓰기 동작은 없다 (discover 소스 대조)", () => {
  const src = readFileSync(new URL("../../../packages/adapters/src/discover/index.ts", import.meta.url), "utf8");
  const svc: Record<string, string> = { sts: "sts", eks: "eks", rds: "rds", ec2: "ec2", elbv2: "elasticloadbalancing", ecr: "ecr", secretsmanager: "secretsmanager" };
  const camel = (s: string) => s.split("-").map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
  const used = new Set<string>();
  for (const m of src.matchAll(/run(?:Json|Text)\(d, "aws", \["([a-z0-9]+)", "([a-z-]+)"/g)) {
    const [, s, op] = m as unknown as [string, string, string];
    used.add(`${svc[s] ?? s}:${op === "update-kubeconfig" ? "DescribeCluster" : camel(op === "list-secrets" ? "list-secrets" : op)}`);
  }
  assert.ok(used.size >= 8, [...used].join(","));
  const allowed = new Set(["sts:GetCallerIdentity", "eks:ListClusters", "eks:DescribeCluster", "rds:DescribeDBInstances", "rds:DescribeDBParameters", "ec2:DescribeVpcs",
    "elasticloadbalancing:DescribeLoadBalancers", "ecr:DescribeRepositories", "secretsmanager:ListSecrets",
    "ec2:DescribeSecurityGroups"]);   // FM-IR-02: RDS 보안 그룹 (발급 목록엔 EC2_OBSERVE_ACTIONS 로 이미 들어감)
  const allowedLower = new Set([...allowed].map((a) => a.toLowerCase()));   // CLI 이름(describe-db-instances)과 IAM 이름(DescribeDBInstances)의 대소문자 차이
  for (const a of used) assert.ok(allowedLower.has(a.toLowerCase()), `발급 동작 목록에 없는 호출: ${a}`);
  assert.ok(!src.includes("GetSecretValue") || src.includes("부르지 않는다"));
  // 고객 관찰 역할 템플릿(L3)과 대조: 템플릿 인라인에 있는 것 말고는 ViewOnlyAccess 몫 → 읽기 동사뿐이어야 함 【미확인: ViewOnlyAccess 실제 포함 범위】
  const tpl = JSON.parse(readFileSync(new URL("../../../infra/onboarding/aws-connect.json", import.meta.url), "utf8"));
  const extra: string[] = tpl.Resources.ObserveRole.Properties.Policies[0].PolicyDocument.Statement.flatMap((s: { Action: string[] }) => s.Action);
  for (const a of allowed) if (!extra.includes(a) && a !== "sts:GetCallerIdentity") assert.match(a, /:(Describe|List)/, a);
  assert.ok(extra.includes("eks:DescribeCluster"));
});

test("연결 상태별: unstable 은 읽고, 그 밖(draft·failed·verifying·expired·disconnected)은 역할 빌리기 전에 영구 실패", { skip }, async () => {
  setMode("ok"); resetLog();
  const u = await seed("unstable");
  await imp.handleImport(job(u));
  assert.equal((await creds(u)).length, 1, "unstable 은 빌림");
  for (const st of ["draft", "failed", "verifying", "expired", "disconnected"]) {
    resetLog();
    const id = await seed(st);
    await imp.handleImport(job(id));
    assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" }, st);
    assert.equal((await creds(id)).length, 0, st);
    assert.equal(calls().length, 0, st);
  }
});

test("역할 거부(AccessDenied): 재시도 없이 영구 실패, discover 호출 0, 반납할 장부 없음/정리됨", { skip }, async () => {
  setMode("denied"); resetLog();
  const id = await seed("connected");
  await imp.handleImport(job(id));   // 던지지 않고 failed
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" });
  assert.equal(calls().length, 0);
  assert.ok((await creds(id)).every((c) => c.status !== "active"), "active 장부가 남음");
  const f = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed'", [id])).rows[0];
  assert.equal(f.detail.permanent, true); assert.equal(f.detail.attempts, 1);
  setMode("ok");
});

test("네트워크 오류로 역할 못 빌림: 영구 실패가 아니라 다시 던진다(재시도), 상태는 importing 그대로", { skip }, async () => {
  setMode("net"); resetLog();
  const id = await seed("connected");
  await assert.rejects(() => imp.handleImport(job(id)));
  assert.equal((await row(id)).status, "importing");
  setMode("ok");
});

test("읽는 도중 일시 오류: 자격은 반납되고(import_done) 재시도로 던진다", { skip }, async () => {
  setMode("listfail"); resetLog();
  const id = await seed("connected");
  let threw = false;
  try { await imp.handleImport(job(id)); } catch { threw = true; }
  const r = await row(id);
  // 영구(UNAVAILABLE) 로 분류되면 failed, 아니면 던짐. 어느 쪽이든 자격은 남으면 안 됨
  assert.ok(threw || r.status === "failed", JSON.stringify(r));
  const cs = await creds(id);
  assert.ok(cs.length >= 1 && cs.every((c) => c.status === "revoked" && c.revoke_reason === "import_done"), JSON.stringify(cs));
  setMode("ok");
});

test("external_id 없는 aws 환경(REAL_STS=1): 빌리지 않고 가짜 발급기(stub) → 워커 자기 자격 그대로", { skip }, async () => {
  setMode("ok"); resetLog();
  const id = await seed("connected", null);
  await imp.handleImport(job(id));
  const cs = await creds(id);
  assert.equal(cs.length, 1); assert.equal(cs[0]!.stub, true);
  assert.ok(calls().every((l) => !l.includes("key=ASIAVL5KEY")), "빌린 키가 쓰이면 안 됨");
});

test("남의 회사 작업: 아무것도 안 빌리고 안 바꾼다", { skip }, async () => {
  setMode("ok"); resetLog();
  const id = await seed("connected");
  const other = randomUUID();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vl5-other')", [other]);
  await imp.handleImport(job(id, other));
  assert.equal((await row(id)).status, "importing");
  assert.equal((await creds(id)).length, 0);
  assert.equal(calls().length, 0);
});

test("두 번 동시 배달: 둘 다 끝나면 active 자격이 남지 않는다", { skip }, async () => {
  setMode("ok"); resetLog();
  const id = await seed("connected");
  await Promise.all([imp.handleImport(job(id)), imp.handleImport(job(id))]);
  const cs = await creds(id);
  assert.ok(cs.length >= 1 && cs.every((c) => c.status === "revoked"), JSON.stringify(cs));
  assert.equal(kubeDirs().length, 0, "임시 kubeconfig 폴더가 남음");
});
