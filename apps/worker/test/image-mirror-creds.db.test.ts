// 리허설 이미지 복사 DB 시험: 출발 관찰 역할을 image_mirror 단계로 빌리고(ECR 받기 3동작·AR 받기 1권한), 출발 토큰만 그 자격을 쓰고, 끝나면 회수된다.
// assume-role 은 PATH 앞 가짜 aws, SA 가장은 PATH 앞 가짜 gcloud, ECR·crane 은 가짜 exec (실제 클라우드·레지스트리 호출 없음). DB 없으면 건너뛴다
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
const GSRC = randomUUID(), GSEED = randomUUID(), GM = randomUUID(), GM2 = randomUUID();
const D = `sha256:${"d".repeat(64)}`;
const PLATFORM = "999999999999.dkr.ecr.ap-northeast-2.amazonaws.com", AR = "asia-northeast3-docker.pkg.dev";
const GCP_TOKEN = "ya29.db-borrowed-observe-token-0123456789";
const bin = mkdtempSync(join(tmpdir(), "mirror-bin-"));
const oldPath = process.env.PATH;

before(async () => {
  if (skip) return;
  writeFileSync(join(bin, "aws"), `#!/bin/sh\ncat <<'J'\n${JSON.stringify({ Credentials: {
    AccessKeyId: "ASIAMIRROR", SecretAccessKey: "mirror-secret", SessionToken: "mirror-token", Expiration: "2099-01-01T00:00:00Z" },
    AssumedRoleUser: { Arn: "arn:aws:sts::111122223333:assumed-role/svc-observe/x" } })}\nJ\n`);
  chmodSync(join(bin, "aws"), 0o755);
  writeFileSync(join(bin, "gcloud"), `#!/bin/sh\ncase "$*" in *svc-observe@cust-prj01.iam.gserviceaccount.com*) echo ${GCP_TOKEN} ;; *) echo "unexpected $*" >&2; exit 1 ;; esac\n`);
  chmodSync(join(bin, "gcloud"), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.REAL_STS = "1";
  process.env.GCP_PLATFORM_PROJECT = "platform-prj01";
  core = await import("@svc/core");
  mirror = await import("../src/rehearsal/image-mirror.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-mirror')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region) VALUES
    ($1,$3,'aws','src','connected','111122223333',$4,'us-west-2'), ($2,$3,'aws','dst','connected','222233334444',NULL,NULL),
    ($5,$3,'gcp','gsrc','connected','cust-prj01',NULL,'asia-northeast3'), ($6,$3,'gcp','gseed','connected',NULL,NULL,NULL)`, [SRC, DST, T, `ext-${SRC}`, GSRC, GSEED]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'deploying'), ($5,$2,$6,$4,'deploying'), ($7,$2,$8,$4,'deploying')`,
    [M, T, SRC, DST, GM, GSRC, GM2, GSEED]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = oldPath; delete process.env.REAL_STS; delete process.env.GCP_PLATFORM_PROJECT;
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

const ledger = async (migrationId: string) => (await owner.query(
  "SELECT env_id, purpose, step, actions_count, stub, status, revoke_reason FROM temp_credentials WHERE migration_id=$1", [migrationId])).rows;
const env = () => ({ ...process.env, SANDBOX_IMAGE_REGISTRY: `${PLATFORM}/sandbox`, MOCK_SANDBOX: "" });

test("GCP 출발: image_mirror 로 출발 관찰 SA 를 AR 받기 1권한으로 빌려 그 토큰을 crane 설정 파일에만, 끝나면 장부 revoked", { skip }, async () => {
  let auth: string | null = null;
  const stored = new Map<string, string>();
  const exec: Exec = async (cmd, args, o) => {
    const r = (code: number, stdout = "") => ({ code, stdout, stderr: "", ms: 1 });
    assert.ok(!JSON.stringify([args, o.env]).includes(GCP_TOKEN), "토큰이 명령 인자·환경에 없음");
    if (cmd === "aws") { assert.equal(o.env.AWS_CONFIG_FILE, undefined, "플랫폼 쪽은 빌린 자격 없음"); return r(0, "tok"); }
    auth ??= JSON.parse(readFileSync(join(o.env.DOCKER_CONFIG!, "config.json"), "utf8")).auths[AR].auth;
    if (args[0] === "digest") return stored.has(args[1]!) ? r(0, stored.get(args[1]!)) : r(1);
    stored.set(args[2]!, D);
    return r(0);
  };
  const out = await mirror.mirrorImages({ tenantId: T, migrationId: GM }, { id: GM, status: "deploying", sourceEnvId: GSRC, targetEnvId: DST },
    [{ ref: `x/web@${D}`, source: `${AR}/cust-prj01/shop/web@${D}` }], { exec, env: env() });
  assert.deepEqual(out, { ok: true, images: [{ ref: `x/web@${D}`, sandboxRef: `${PLATFORM}/sandbox/${T}/web@${D}` }] });
  assert.equal(Buffer.from(auth!, "base64").toString(), `oauth2accesstoken:${GCP_TOKEN}`);
  assert.deepEqual(await ledger(GM), [{ env_id: GSRC, purpose: "observe", step: "image_mirror", actions_count: 1, stub: false, status: "revoked", revoke_reason: "image_mirror_done" }]);
});

test("GCP 출발 시드 환경(흉내 자격): 진짜 발급기 모드면 워커 자기 계정으로 AR 을 읽지 않고 role_denied, 빌린 것은 회수", { skip }, async () => {
  const exec: Exec = async (cmd, args) => { throw new Error(`명령을 부르면 안 됨: ${cmd} ${args.join(" ")}`); };
  const out = await mirror.mirrorImages({ tenantId: T, migrationId: GM2 }, { id: GM2, status: "deploying", sourceEnvId: GSEED, targetEnvId: DST },
    [{ ref: `x/web@${D}`, source: `${AR}/cust-prj01/shop/web@${D}` }], { exec, env: env() });
  assert.equal(!out.ok && out.reason, "role_denied");
  assert.deepEqual(await ledger(GM2), [{ env_id: GSEED, purpose: "observe", step: "image_mirror", actions_count: 1, stub: true, status: "revoked", revoke_reason: "image_mirror_done" }]);
});
