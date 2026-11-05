// #241 DB 시험: 시드 환경처럼 연결 링크를 안 거친 환경은 흉내 자격을 받는다. 실환경 모드에서 그 자격으로 가져오기를 하면 워커 자기 권한으로 플랫폼 계정을 읽게 되므로 멈춰야 한다.
// aws·gcloud 는 PATH 앞 가짜 스크립트 (실제 호출 없음). MOCK_SEED 를 끄고 진짜 discover 길을 탄다. DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let owner: pg.Client;
const T = randomUUID();
const bin = mkdtempSync(join(tmpdir(), "m241-bin-"));
const callLog = join(bin, "calls.log");
const OWN_ENV = ["GCP_PROJECT", "GCP_PLATFORM_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CORE_ACCOUNT", "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT"] as const;
const saved = { PATH: process.env.PATH, MOCK_SEED: process.env.MOCK_SEED, REAL_STS: process.env.REAL_STS,
  own: Object.fromEntries(OWN_ENV.map((k) => [k, process.env[k]])) as Record<string, string | undefined> };
const BORROWED = "borrowed-gcp-token-241-abcdef";

before(async () => {
  if (skip) return;
  writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "aws $*" >> ${callLog}\ncase "$1 $2" in\n  "eks list-clusters") echo '{"clusters":[]}' ;;\n  *) echo '{}' ;;\nesac\n`);
  // 가짜 gcloud: 어떤 자격으로 불렸는지 남긴다. 토큰 발급(impersonate)은 워커 자기 자격으로 부르고 토큰을 찍어 준다
  writeFileSync(join(bin, "gcloud"), `#!/bin/sh
echo "gcloud $* token=\${CLOUDSDK_AUTH_ACCESS_TOKEN:-none} project=\${CLOUDSDK_CORE_PROJECT:-none} sa_file=\${GOOGLE_APPLICATION_CREDENTIALS:-none} account=\${CLOUDSDK_CORE_ACCOUNT:-none} impersonate=\${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:-none}" >> ${callLog}
case "$1 $2" in
  "auth print-access-token") echo '${BORROWED}' ;;
  "projects describe") echo '{}' ;;
  *) echo '[]' ;;
esac
`);
  chmodSync(join(bin, "aws"), 0o755); chmodSync(join(bin, "gcloud"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  delete process.env.MOCK_SEED;
  process.env.GCP_PLATFORM_PROJECT = "svc-platform";   // 발급기는 첫 사용 때 한 번 만들어지므로 시험 시작 전에 정한다
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-241')", [T]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = saved.PATH;
  if (saved.MOCK_SEED !== undefined) process.env.MOCK_SEED = saved.MOCK_SEED;
  if (saved.REAL_STS !== undefined) process.env.REAL_STS = saved.REAL_STS; else delete process.env.REAL_STS;
  for (const k of OWN_ENV) { if (saved.own[k] !== undefined) process.env[k] = saved.own[k]; else delete process.env[k]; }
  await core.pool.end(); await owner.end(); rmSync(bin, { recursive: true, force: true });
});

// 시드 환경 모양: external_id 없음. GCP 는 프로젝트 "stub" = 고객 SA 모양이 아니라 흉내 발급기로 간다
async function seed(provider: "aws" | "gcp") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region) VALUES
    ($1,$3,$4,'s','connected',$5,NULL,NULL), ($2,$3,'onprem','d','connected',NULL,NULL,NULL)`, [src, dst, T, provider, provider === "aws" ? "111122223333" : "stub"]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
const run = (id: string) => imp.handleImport({ tenantId: T, requestId: `r-241-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const creds = async (id: string) => (await owner.query("SELECT status, stub, revoke_reason FROM temp_credentials WHERE migration_id=$1", [id])).rows;
const calls = () => (existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean) : []);
const REVOKED = [{ status: "revoked", stub: true, revoke_reason: "import_done" }];

for (const provider of ["aws", "gcp"] as const) {
  test(`MOCK_CREDENTIALS 거부: REAL_STS 켜짐 + ${provider} 흉내 자격 → discover 안 부르고 IMPORT_SOURCE_UNAVAILABLE, 장부는 회수됨`, { skip }, async () => {
    process.env.REAL_STS = "1"; rmSync(callLog, { force: true });
    const id = await seed(provider);
    assert.equal(await run(id), "advanced");
    assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" });
    assert.deepEqual(calls(), [], "CLI 를 한 번도 부르면 안 됨");
    assert.deepEqual(await creds(id), REVOKED);
    const audit = (await owner.query("SELECT detail FROM audit_events WHERE tenant_id=$1 AND target=$2 AND action='migration.failed'", [T, id])).rows;
    assert.match(JSON.stringify(audit), /MOCK_CREDENTIALS/);
  });
}

test("MOCK_CREDENTIALS 정상: REAL_STS 꺼짐 + aws 흉내 자격 → 지금처럼 프로세스 자격으로 discover 진행, 장부는 회수됨", { skip }, async () => {
  process.env.REAL_STS = "0"; rmSync(callLog, { force: true });
  const id = await seed("aws");
  await run(id);
  assert.ok(calls().some((l) => l.startsWith("aws eks list-clusters")), calls().join("\n"));
  // 가짜 aws 엔 클러스터가 없다 → 재료 없음으로 멈춤 = 막히지 않고 끝까지 읽었다는 뜻
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_INCOMPLETE" });
  assert.deepEqual(await creds(id), REVOKED);
});

// GCP 토큰 버그: 진짜 발급기가 준 토큰이 discover 자식 CLI 에 들어가야 한다. 안 그러면 고객 환경을 워커 자기 계정으로 읽는다
test("GCP 빌린 토큰: discover 의 gcloud 는 전부 빌린 토큰 + 고객 프로젝트로 불리고, 워커 자기 자격은 안 섞이며, 토큰은 장부·감사에 안 남는다", { skip }, async () => {
  process.env.REAL_STS = "1"; rmSync(callLog, { force: true });
  process.env.GCP_PROJECT = "worker-own-project";
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "/worker/own-sa.json";
  process.env.CLOUDSDK_CORE_ACCOUNT = "worker-own@example.test";
  process.env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT = "worker-own-delegate@example.test";
  await owner.query("UPDATE tenants SET gcp_platform_sa=$2 WHERE id=$1", [T, "t-" + "a".repeat(28)]);
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region) VALUES
    ($1,$3,'gcp','s','connected','cust-proj-241',NULL,NULL), ($2,$3,'onprem','d','connected',NULL,NULL,NULL)`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);

  await run(id);

  const reads = calls().filter((l) => !l.startsWith("gcloud auth print-access-token"));
  assert.ok(calls().some((l) => l.startsWith("gcloud auth print-access-token") && l.includes("svc-observe@cust-proj-241.iam.gserviceaccount.com")), calls().join("\n"));
  assert.ok(reads.some((l) => l.startsWith("gcloud projects describe cust-proj-241 ")), "고객 프로젝트를 읽어야 함: " + reads.join("\n"));
  for (const l of reads) {
    assert.ok(l.includes(`token=${BORROWED} project=cust-proj-241 `), "빌린 토큰으로만: " + l);
    assert.ok(l.includes("sa_file=none account=none impersonate=none"), "워커 자기 자격이 섞이면 안 됨: " + l);
    assert.ok(!l.includes("worker-own-project"), "워커 프로젝트를 읽으면 안 됨: " + l);
  }
  // 가짜 gcloud 엔 자원이 없다 → 재료 없음으로 멈춤 = 끝까지 읽었다는 뜻
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_INCOMPLETE" });
  assert.deepEqual(await creds(id), [{ status: "revoked", stub: false, revoke_reason: "import_done" }]);
  const stored = JSON.stringify([(await owner.query("SELECT * FROM temp_credentials WHERE migration_id=$1", [id])).rows,
    (await owner.query("SELECT detail FROM audit_events WHERE tenant_id=$1 AND target=$2", [T, id])).rows]);
  assert.ok(!stored.includes(BORROWED), "토큰이 저장되면 안 됨");
});
