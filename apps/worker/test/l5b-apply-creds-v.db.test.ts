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
const T = randomUUID(), SRC = randomUUID(), REAL = randomUUID(), SEED = randomUUID(), NOREG = randomUUID();
const M1 = randomUUID(), M2 = randomUUID(), M3 = randomUUID(), M4 = randomUUID();
const mig = (id: string, targetEnvId: string) => ({ id, status: "provisioning" as const, sourceEnvId: SRC, targetEnvId });
const bin = mkdtempSync(join(tmpdir(), "l5bv-bin-"));
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-l5b-v')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region) VALUES
    ($1,$4,'gcp','src','connected','l5b-project',NULL,NULL), ($2,$4,'aws','real','connected','111122223333',$5,'us-west-2'),
    ($3,$4,'aws','seed','connected','111122223333',NULL,NULL), ($6,$4,'aws','noreg','connected','111122223333',$7,NULL)`,
    [SRC, REAL, SEED, T, `ext-${REAL}`, NOREG, `ext-${NOREG}`]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES
    ($1,$3,$4,$5,'provisioning'), ($2,$3,$4,$6,'provisioning'), ($7,$3,$4,$8,'provisioning'), ($9,$3,$4,$5,'provisioning')`,
    [M1, M2, T, SRC, REAL, SEED, M3, NOREG, M4]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = oldPath; delete process.env.REAL_STS;
  await core.pool.end(); await owner.end();
});


test("경계: 환경에 리전이 없으면 서울(ap-northeast-2)로, 설정 파일에도 같은 리전", { skip }, async () => {
  await roles.withStepRoles("apply", { tenantId: T, migrationId: M3 }, mig(M3, NOREG), async (x) => {
    const env = x.awsEnv!.target!;
    assert.equal(env.AWS_REGION, "ap-northeast-2");
    assert.match(readFileSync(env.AWS_CONFIG_FILE!, "utf8"), /^\[default\]\nregion = ap-northeast-2\n/);
  });
});

test("거부: 일이 예외로 끝나도 자격 파일은 지워지고 자격은 revoked, 예외는 그대로 전달", { skip }, async () => {
  let file = "";
  await assert.rejects(roles.withStepRoles("apply", { tenantId: T, migrationId: M4 }, mig(M4, REAL), async (x) => {
    file = join(x.awsEnv!.target!.AWS_CONFIG_FILE!, "..", "process.json");
    assert.equal(existsSync(file), true);
    throw new Error("boom");
  }), /boom/);
  assert.equal(existsSync(file), false);
  const rows = (await owner.query("SELECT status FROM temp_credentials WHERE migration_id=$1", [M4])).rows;
  assert.deepEqual(rows, [{ status: "revoked" }]);
});

test("동시성: 같은 환경으로 두 단계를 동시에 돌려도 자격 파일 폴더가 서로 다르고 서로 안 지운다", { skip }, async () => {
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const run = (mid: string) => roles.withStepRoles("apply", { tenantId: T, migrationId: mid }, mig(mid, REAL), async (x) => {
    seen.push(x.awsEnv!.target!.AWS_CONFIG_FILE!);
    await gate;
    return existsSync(x.awsEnv!.target!.AWS_CONFIG_FILE!);
  });
  const a = run(M1), b = run(M4);
  while (seen.length < 2) await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(seen[0], seen[1]);
  release();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(existsSync(seen[0]!), false); assert.equal(existsSync(seen[1]!), false);
});
