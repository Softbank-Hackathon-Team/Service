// L5b DB 시험: apply 단계 실행 역할이 진짜 발급기(REAL_STS=1 + external_id)면 terraform 용 자격 파일이 생기고, 단계 끝에 지워진다.
// aws CLI 는 PATH 앞에 둔 가짜 스크립트 (실제 AWS 호출 없음). DB 없으면 건너뛴다
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
let roles: typeof import("../src/jobs/_roles.js");
let adapters: typeof import("@svc/adapters");
let owner: pg.Client;
const T = randomUUID(), SRC = randomUUID(), REAL = randomUUID(), SEED = randomUUID();
const M1 = randomUUID(), M2 = randomUUID();
const mig = (id: string, targetEnvId: string) => ({ id, status: "provisioning" as const, sourceEnvId: SRC, targetEnvId });
const bin = mkdtempSync(join(tmpdir(), "l5b-bin-"));
const argsLog = join(bin, "args.log");
const oldPath = process.env.PATH;

before(async () => {
  if (skip) return;
  // 가짜 aws: assume-role 응답만. 받은 인자를 적어 둔다 (--profile 이 없는지 본다)
  writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "$@" >> ${argsLog}\ncat <<'J'\n${JSON.stringify({ Credentials: {
    AccessKeyId: "ASIAL5BREAL", SecretAccessKey: "l5b-secret", SessionToken: "l5b-token", Expiration: "2099-01-01T00:00:00Z" },
    AssumedRoleUser: { Arn: "arn:aws:sts::111122223333:assumed-role/svc-operate/x" } })}\nJ\n`);
  chmodSync(join(bin, "aws"), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.REAL_STS = "1";
  core = await import("@svc/core");
  roles = await import("../src/jobs/_roles.js");
  adapters = await import("@svc/adapters");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-l5b')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region) VALUES
    ($1,$4,'gcp','src','connected','l5b-project',NULL,NULL), ($2,$4,'aws','real','connected','111122223333',$5,'us-west-2'),
    ($3,$4,'aws','seed','connected','111122223333',NULL,NULL)`, [SRC, REAL, SEED, T, `ext-${REAL}`]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES
    ($1,$3,$4,$5,'provisioning'), ($2,$3,$4,$6,'provisioning')`, [M1, M2, T, SRC, REAL, SEED]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = oldPath; delete process.env.REAL_STS;
  await core.pool.end(); await owner.end();
});

test("정상: external_id 있는 aws 도착 → 진짜 발급(가짜 CLI), terraform env = 자격 파일만(프로필·키 없음), 단계 끝에 파일·자격 회수", { skip }, async () => {
  let seen: { env: Record<string, string>; file: string; childEnv: NodeJS.ProcessEnv } | null = null;
  const r = await roles.withStepRoles("apply", { tenantId: T, migrationId: M1 }, mig(M1, REAL), async (x) => {
    const env = x.awsEnv?.target;
    assert.ok(env, "awsEnv.target 이 있어야 함");
    const childEnv = adapters.childEnv(adapters.envFor(env, { PATH: "/bin", AWS_PROFILE: "finals", AWS_ACCESS_KEY_ID: "AKIAOWN" }));
    seen = { env, file: join(env.AWS_CONFIG_FILE!, "..", "process.json"), childEnv };
    assert.equal(JSON.parse(readFileSync(seen.file, "utf8")).AccessKeyId, "ASIAL5BREAL");
    return x;
  });
  assert.equal(r.creds[0]!.stub, false);
  assert.equal(seen!.env.AWS_REGION, "us-west-2");
  assert.equal(seen!.childEnv.AWS_PROFILE, undefined);
  assert.equal(seen!.childEnv.AWS_ACCESS_KEY_ID, undefined);
  assert.ok(!JSON.stringify(seen!.childEnv).includes("l5b-secret"));
  assert.equal(existsSync(seen!.file), false, "단계 끝에 자격 파일 삭제");
  const args = readFileSync(argsLog, "utf8");
  assert.match(args, /sts assume-role .*--external-id ext-/);
  assert.ok(!args.includes("--profile"));
  const rows = (await owner.query("SELECT status, stub, revoke_reason FROM temp_credentials WHERE migration_id=$1", [M1])).rows;
  assert.deepEqual(rows, [{ status: "revoked", stub: false, revoke_reason: "apply_done" }]);
});

test("거부: external_id 없는 aws 도착(시드)은 mock 발급 → 자격 파일 없음 (지금처럼 프로세스 자격)", { skip }, async () => {
  const r = await roles.withStepRoles("apply", { tenantId: T, migrationId: M2 }, mig(M2, SEED), async (x) => x);
  assert.equal(r.creds[0]!.stub, true);
  assert.equal(r.awsEnv, undefined);
});
