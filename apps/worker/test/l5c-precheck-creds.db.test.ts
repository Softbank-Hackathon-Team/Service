// L5c DB 시험: precheck 단계 관찰 역할이 진짜 발급기(REAL_STS=1 + external_id)면 쪽마다 CLI env 가 빌린 자격 파일로 바뀐다.
// aws CLI 는 PATH 앞에 둔 가짜 스크립트 (실제 AWS 호출 없음). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let roles: typeof import("../src/jobs/_roles.js");
let precheck: typeof import("../src/jobs/precheck.js");
let owner: pg.Client;
const T = randomUUID(), REAL = randomUUID(), SEED = randomUUID(), M = randomUUID();
const bin = mkdtempSync(join(tmpdir(), "l5c-bin-"));
const oldPath = process.env.PATH;

before(async () => {
  if (skip) return;
  writeFileSync(join(bin, "aws"), `#!/bin/sh\ncat <<'J'\n${JSON.stringify({ Credentials: {
    AccessKeyId: "ASIAL5COBS", SecretAccessKey: "l5c-secret", SessionToken: "l5c-token", Expiration: "2099-01-01T00:00:00Z" } })}\nJ\n`);
  chmodSync(join(bin, "aws"), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.REAL_STS = "1";
  core = await import("@svc/core");
  roles = await import("../src/jobs/_roles.js");
  precheck = await import("../src/jobs/precheck.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-l5c')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id) VALUES
    ($1,$3,'aws','seed-src','connected','111122223333',NULL), ($2,$3,'aws','real-tgt','connected','222233334444',$4)`, [SEED, REAL, T, `ext-${REAL}`]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'prechecking')`, [M, T, SEED, REAL]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = oldPath; delete process.env.REAL_STS;
  await core.pool.end(); await owner.end();
});

test("정상: 도착(external_id 있음)만 빌린 자격 env, 출발(시드)은 프로세스 env 그대로 / 단계 끝 장부 revoked", { skip }, async () => {
  const side = await roles.withStepRoles("precheck", { tenantId: T, migrationId: M },
    { id: M, status: "prechecking" as const, sourceEnvId: SEED, targetEnvId: REAL },
    async (r) => precheck.precheckSideEnv(r, { AWS_PROFILE: "finals", AWS_ACCESS_KEY_ID: "AKIAOWN", PATH: "/bin" }));
  assert.ok(side?.target);
  assert.equal(side!.source, undefined);
  assert.equal(side!.target!.AWS_PROFILE, undefined);
  assert.equal(side!.target!.AWS_ACCESS_KEY_ID, undefined);
  assert.match(side!.target!.AWS_CONFIG_FILE!, /svc-aws-/);
  const rows = (await owner.query("SELECT status, stub, revoke_reason FROM temp_credentials WHERE migration_id=$1 ORDER BY stub", [M])).rows;
  assert.deepEqual(rows.map((x) => [x.status, x.stub, x.revoke_reason]), [["revoked", false, "precheck_done"], ["revoked", true, "precheck_done"]]);
});

test("거부: 빌린 자격이 없으면(가짜 발급기) sideEnv 없음 → 지금처럼", { skip }, () => {
  assert.equal(precheck.precheckSideEnv(undefined, {}), undefined);
  assert.equal(precheck.precheckSideEnv({ awsEnv: {} }, {}), undefined);
});
