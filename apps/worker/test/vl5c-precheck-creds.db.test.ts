// VL5c DB 시험: L5c 검증 — 단계가 끝나면 빌린 자격 파일이 지워지고, 실패해도 회수되고, 남의 회사 환경은 빌리지 않는다.
// aws CLI 는 PATH 앞의 가짜 스크립트 (실제 AWS 호출 없음). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let roles: typeof import("../src/jobs/_roles.js");
let precheck: typeof import("../src/jobs/precheck.js");
let owner: pg.Client;
const T = randomUUID(), T2 = randomUUID(), S = randomUUID(), G = randomUUID(), OTHER = randomUUID(), M = randomUUID();
const bin = mkdtempSync(join(tmpdir(), "vl5c-bin-"));
const oldPath = process.env.PATH;
const SECRET = "vl5c-secret", KEY = "ASIAVL5CKEY";

before(async () => {
  if (skip) return;
  writeFileSync(join(bin, "aws"), `#!/bin/sh\ncat <<'J'\n${JSON.stringify({ Credentials: {
    AccessKeyId: KEY, SecretAccessKey: SECRET, SessionToken: "vl5c-token", Expiration: "2099-01-01T00:00:00Z" } })}\nJ\n`);
  chmodSync(join(bin, "aws"), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.REAL_STS = "1";
  core = await import("@svc/core");
  roles = await import("../src/jobs/_roles.js");
  precheck = await import("../src/jobs/precheck.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vl5c'), ($2, 'test-vl5c-other')", [T, T2]);
  for (const [id, tenant, name, acct] of [[S, T, "real-src", "111122223333"], [G, T, "real-tgt", "222233334444"], [OTHER, T2, "other", "333344445555"]] as const)
    await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id) VALUES ($1,$2,'aws',$3,'connected',$4,$5)`,
      [id, tenant, name, acct, `ext-${id}`]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'prechecking')`, [M, T, S, G]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = oldPath; delete process.env.REAL_STS;
  await core.pool.end(); await owner.end();
});

const mig = (id: string, s: string, t: string) => ({ id, status: "prechecking" as const, sourceEnvId: s, targetEnvId: t });

test("정상: 양쪽 다 진짜 발급기면 쪽마다 다른 자격 파일, env 에 키 값 없음(경로만), 단계 끝나면 파일이 지워지고 장부 revoked", { skip }, async () => {
  let paths: string[] = [];
  const side = await roles.withStepRoles("precheck", { tenantId: T, migrationId: M }, mig(M, S, G), async (r) => {
    const se = precheck.precheckSideEnv(r, { PATH: "/bin" })!;
    paths = [se.source!.AWS_CONFIG_FILE!, se.target!.AWS_CONFIG_FILE!];
    assert.notEqual(paths[0], paths[1], "쪽마다 다른 파일");
    for (const p of paths) assert.ok(existsSync(p), "단계 안에서는 있음");
    for (const e of [se.source!, se.target!]) {
      const all = JSON.stringify(e);
      assert.ok(!all.includes(SECRET) && !all.includes(KEY), "env 에 키 값이 직접 들어가지 않는다");
    }
    return se;
  });
  assert.ok(side);
  for (const p of paths) assert.equal(existsSync(p), false, "단계 뒤 자격 파일 삭제");
  const rows = (await owner.query("SELECT status, stub, revoke_reason FROM temp_credentials WHERE migration_id=$1", [M])).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.status === "revoked" && x.stub === false && x.revoke_reason === "precheck_done"));
});

test("거부: 단계 안에서 예외가 나도 자격 파일은 지워지고 장부는 revoked, 예외는 그대로 나간다", { skip }, async () => {
  let file = "";
  await assert.rejects(roles.withStepRoles("precheck", { tenantId: T, migrationId: M }, mig(M, S, G), async (r) => {
    file = precheck.precheckSideEnv(r, {})!.target!.AWS_CONFIG_FILE!;
    throw new Error("점검 중 오류");
  }), /점검 중 오류/);
  assert.equal(existsSync(file), false);
  const open = (await owner.query("SELECT count(*)::int AS n FROM temp_credentials WHERE migration_id=$1 AND status <> 'revoked'", [M])).rows[0].n;
  assert.equal(open, 0);
});

test("남의 회사: 다른 회사 번호로 이 회사 이전의 환경을 빌리려 하면 아무것도 안 빌린다 (환경이 안 보여 skipped)", { skip }, async () => {
  const before_ = (await owner.query("SELECT count(*)::int AS n FROM temp_credentials WHERE tenant_id=$1", [T2])).rows[0].n;
  const r = await roles.borrowStepRoles("precheck", { tenantId: T2, migrationId: M }, mig(M, S, G));
  assert.equal(r.creds.length, 0);
  assert.ok(r.skipped.length >= 1 && r.skipped.every((x) => x.reason === "env_not_found"));
  assert.equal(r.awsEnv, undefined);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM temp_credentials WHERE tenant_id=$1", [T2])).rows[0].n, before_);
});
