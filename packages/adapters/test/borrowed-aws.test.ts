// L5b: 빌린 AWS 실행 자격 → terraform 자식 env. 가짜 exec 만 (terraform·aws 안 부름)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { borrowedAwsCreds, createRealTerraformRunner, envFor, type Exec } from "../src/index.js";

const MID = "4a8c0000-0000-4000-8000-0000000000bb";
const K = { accessKeyId: "ASIABORROWED1", secretAccessKey: "sec-1-do-not-log", sessionToken: "tok-1" };

test("정상: apply 실행기 env 에 빌린 자격 파일만, AWS_PROFILE·워커 키 없음, 키 값은 env 에 없음", async () => {
  const f = borrowedAwsCreds(K, new Date("2026-11-03T00:15:00Z"), { region: "ap-northeast-2" });
  try {
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const exec: Exec = async (cmd, args, o) => {
      calls.push({ cmd, args, env: o.env });
      return { code: 0, stdout: args[0] === "output" ? "{}" : "ok", stderr: "", ms: 1 };
    };
    const base = { PATH: "/bin", HOME: "/h", AWS_PROFILE: "finals", AWS_DEFAULT_PROFILE: "x", AWS_ACCESS_KEY_ID: "AKIAOWN", AWS_SECRET_ACCESS_KEY: "own", AWS_SESSION_TOKEN: "own" };
    const root = mkdtempSync(join(tmpdir(), "l5b-"));
    const r = await createRealTerraformRunner({ exec, workRoot: root, env: { ...envFor(f.env, base), TF_FETCH_DB_SECRET: "0" } })
      .apply("aws", MID, { app_name: "shop" });
    assert.equal(r.ok, true);
    const tf = calls.filter((c) => c.cmd === "terraform");
    assert.ok(tf.length >= 3);
    for (const c of tf) {
      assert.equal(c.env.AWS_PROFILE, undefined);
      assert.equal(c.env.AWS_DEFAULT_PROFILE, undefined);
      assert.equal(c.env.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(c.env.AWS_CONFIG_FILE, f.env.AWS_CONFIG_FILE);
      assert.equal(c.env.AWS_SHARED_CREDENTIALS_FILE, f.env.AWS_SHARED_CREDENTIALS_FILE);
      assert.ok(!JSON.stringify(c.env).includes("sec-1-do-not-log"));
    }
    // 설정 파일: [default] + credential_process, 프로필 이름 없음. 자격 파일은 0600, credential_process 모양
    const cfg = readFileSync(f.env.AWS_CONFIG_FILE!, "utf8");
    assert.match(cfg, /^\[default\]\nregion = ap-northeast-2\ncredential_process = cat \S+process\.json\n$/);
    const pj = join(f.dir, "process.json");
    assert.equal(statSync(pj).mode & 0o777, 0o600);
    assert.equal(statSync(f.dir).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(pj, "utf8")), { Version: 1, AccessKeyId: "ASIABORROWED1", SecretAccessKey: "sec-1-do-not-log",
      SessionToken: "tok-1", Expiration: "2026-11-03T00:15:00.000Z" });
  } finally { f.dispose(); }
});

test("재발급: update 가 파일을 새 키로 바꿈 / dispose 뒤 폴더 없음", () => {
  const f = borrowedAwsCreds(K, new Date("2026-11-03T00:15:00Z"), { region: "us-east-1" });
  f.update({ accessKeyId: "ASIABORROWED2", secretAccessKey: "s2", sessionToken: "t2" }, new Date("2026-11-03T00:25:00Z"));
  const j = JSON.parse(readFileSync(join(f.dir, "process.json"), "utf8"));
  assert.equal(j.AccessKeyId, "ASIABORROWED2"); assert.equal(j.Expiration, "2026-11-03T00:25:00.000Z");
  assert.ok(!existsSync(join(f.dir, "process.json.tmp")));
  f.dispose();
  assert.equal(existsSync(f.dir), false);
});
