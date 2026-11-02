// L5 DB 시험: 가져오기가 출발 환경 관찰 역할을 빌려 그 자격으로만 읽는가. aws CLI 는 PATH 앞 가짜 스크립트 (실제 AWS 호출 없음).
// MOCK_SEED 를 끄고 진짜 discover 길을 탄다 (가짜 aws 가 클러스터 0개라 IMPORT_SOURCE_INCOMPLETE 로 끝나는 게 정상). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let owner: pg.Client;
const T = randomUUID();
const bin = mkdtempSync(join(tmpdir(), "l5-bin-"));
const envLog = join(bin, "env.log");
const saved = { PATH: process.env.PATH, MOCK_SEED: process.env.MOCK_SEED, AWS_PROFILE: process.env.AWS_PROFILE };

before(async () => {
  if (skip) return;
  // 가짜 aws: assume-role → 빌린 키 / 그 밖 명령 → 부른 env 를 적고 빈 결과
  writeFileSync(join(bin, "aws"), `#!/bin/sh
if [ "$1 $2" = "sts assume-role" ]; then
cat <<'J'
${JSON.stringify({ Credentials: { AccessKeyId: "ASIAL5IMPORT", SecretAccessKey: "l5-import-secret", SessionToken: "l5-tok", Expiration: "2099-01-01T00:00:00Z" } })}
J
exit 0
fi
echo "$1 $2 key=$AWS_ACCESS_KEY_ID profile=\${AWS_PROFILE:-none} dprofile=\${AWS_DEFAULT_PROFILE:-none}" >> ${envLog}
case "$1 $2" in
  "sts get-caller-identity") echo '{"Account":"111122223333"}' ;;
  "eks list-clusters") echo '{"clusters":[]}' ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(join(bin, "aws"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.REAL_STS = "1";
  process.env.AWS_PROFILE = "worker-own-profile";
  delete process.env.MOCK_SEED;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-l5')", [T]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = saved.PATH; delete process.env.REAL_STS;
  if (saved.MOCK_SEED !== undefined) process.env.MOCK_SEED = saved.MOCK_SEED;
  if (saved.AWS_PROFILE !== undefined) process.env.AWS_PROFILE = saved.AWS_PROFILE; else delete process.env.AWS_PROFILE;
  await core.pool.end(); await owner.end();
});

async function seed(status: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region) VALUES
    ($1,$3,'aws','s',$4,'111122223333',$5,'ap-northeast-2'), ($2,$3,'gcp','d','connected','l5-project',NULL,NULL)`, [src, dst, T, status, `ext-${src}`]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-l5-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const creds = async (id: string) => (await owner.query("SELECT status, stub, purpose, step, revoke_reason FROM temp_credentials WHERE migration_id=$1", [id])).rows;

test("정상: 빌린 관찰 키가 discover 자식 env 에 들어가고 AWS_PROFILE 없음, 끝나면 장부 revoked(import_done)", { skip }, async () => {
  const id = await seed("connected");
  await imp.handleImport(job(id));
  const log = readFileSync(envLog, "utf8").trim().split("\n");
  assert.ok(log.length >= 2, log.join("\n"));
  for (const l of log) {
    assert.match(l, /key=ASIAL5IMPORT/);
    assert.match(l, /profile=none dprofile=none/);
  }
  assert.ok(log.some((l) => l.startsWith("sts get-caller-identity")));
  // 가짜 aws 엔 클러스터가 없다 → 재료 없음으로 멈춤 (가짜 값 없이)
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_INCOMPLETE" });
  assert.deepEqual(await creds(id), [{ status: "revoked", stub: false, purpose: "observe", step: "import", revoke_reason: "import_done" }]);
  const audit = (await owner.query("SELECT detail FROM audit_events WHERE tenant_id=$1 AND target=$2", [T, id])).rows;
  assert.ok(!JSON.stringify(audit).includes("l5-import-secret"));
});

test("거부: 출발 환경이 연결 상태가 아니면 import 시작 안 함 → failed(IMPORT_SOURCE_UNAVAILABLE), 역할 안 빌림", { skip }, async () => {
  const before = existsSync(envLog) ? readFileSync(envLog, "utf8") : "";
  const id = await seed("awaiting_customer");
  await imp.handleImport(job(id));
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" });
  assert.equal((await creds(id)).length, 0);
  assert.equal(existsSync(envLog) ? readFileSync(envLog, "utf8") : "", before);
});
