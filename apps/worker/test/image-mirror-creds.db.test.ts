// 리허설 이미지 복사 DB 시험: 출발 관찰 역할을 image_mirror 단계로 빌리고(ECR 받기 3동작), 출발 토큰 명령만 그 자격을 쓰고, 끝나면 회수된다.
// assume-role 은 PATH 앞 가짜 aws, ECR·crane 은 가짜 exec (실제 AWS·레지스트리 호출 없음). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { Exec } from "@svc/adapters";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let mirror: typeof import("../src/rehearsal/image-mirror.js");
let owner: pg.Client;
const T = randomUUID(), SRC = randomUUID(), DST = randomUUID(), M = randomUUID();
const D = `sha256:${"d".repeat(64)}`;
const bin = mkdtempSync(join(tmpdir(), "mirror-bin-"));
const oldPath = process.env.PATH;

before(async () => {
  if (skip) return;
  writeFileSync(join(bin, "aws"), `#!/bin/sh\ncat <<'J'\n${JSON.stringify({ Credentials: {
    AccessKeyId: "ASIAMIRROR", SecretAccessKey: "mirror-secret", SessionToken: "mirror-token", Expiration: "2099-01-01T00:00:00Z" },
    AssumedRoleUser: { Arn: "arn:aws:sts::111122223333:assumed-role/svc-observe/x" } })}\nJ\n`);
  chmodSync(join(bin, "aws"), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.REAL_STS = "1";
  core = await import("@svc/core");
  mirror = await import("../src/rehearsal/image-mirror.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-mirror')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region) VALUES
    ($1,$3,'aws','src','connected','111122223333',$4,'us-west-2'), ($2,$3,'aws','dst','connected','222233334444',NULL,NULL)`, [SRC, DST, T, `ext-${SRC}`]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'deploying')`, [M, T, SRC, DST]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = oldPath; delete process.env.REAL_STS;
  await core.pool.end(); await owner.end();
});

test("정상: image_mirror 로 출발 관찰 역할을 빌려 출발 토큰만 그 자격으로, 끝나면 자격 파일 삭제·장부 revoked", { skip }, async () => {
  let borrowedFile: string | null = null;
  const stored = new Map<string, string>();
  const exec: Exec = async (cmd, args, o) => {
    const r = (code: number, stdout = "") => ({ code, stdout, stderr: "", ms: 1 });
    if (cmd === "aws" && args[1] === "get-login-password" && args[3] === "us-west-2") {
      borrowedFile = join(o.env.AWS_CONFIG_FILE!, "..", "process.json");
      assert.equal(JSON.parse(readFileSync(borrowedFile, "utf8")).AccessKeyId, "ASIAMIRROR", "빌린 키가 자격 파일에");
      return r(0, "tok");
    }
    if (cmd === "aws") { assert.equal(o.env.AWS_CONFIG_FILE, undefined, "플랫폼 쪽은 빌린 자격 없음"); return r(0, "tok"); }
    if (args[0] === "digest") return stored.has(args[1]!) ? r(0, stored.get(args[1]!)) : r(1);
    stored.set(args[2]!, D);
    return r(0);
  };
  const out = await mirror.mirrorImages({ tenantId: T, migrationId: M }, { id: M, status: "deploying", sourceEnvId: SRC, targetEnvId: DST },
    [{ ref: `x/api@${D}`, source: `111122223333.dkr.ecr.us-west-2.amazonaws.com/shop/api@${D}` }],
    { exec, env: { ...process.env, SANDBOX_IMAGE_REGISTRY: "999999999999.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox", MOCK_SANDBOX: "" } });
  assert.deepEqual(out, { ok: true, images: [{ ref: `x/api@${D}`, sandboxRef: `999999999999.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox/${T}/api@${D}` }] });
  assert.ok(borrowedFile && !existsSync(borrowedFile), "단계 끝에 자격 파일 삭제");
  const rows = (await owner.query("SELECT env_id, purpose, step, actions_count, stub, status, revoke_reason FROM temp_credentials WHERE migration_id=$1", [M])).rows;
  assert.deepEqual(rows, [{ env_id: SRC, purpose: "observe", step: "image_mirror", actions_count: 3, stub: false, status: "revoked", revoke_reason: "image_mirror_done" }]);
});
