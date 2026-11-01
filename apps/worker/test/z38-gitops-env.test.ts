// Z38-6: gitops 자식 프로세스에 비밀 환경변수가 안 넘어가는지
import { test } from "node:test";
import assert from "node:assert/strict";
import { childEnv } from "../src/gitops/repo.js";

test("Z38-6: 자식 프로세스 환경 = 경로·프록시·GIT_ 만. 토큰·키·DB 주소는 빠진다", () => {
  const env = childEnv({
    PATH: "/usr/bin", HOME: "/h", HTTPS_PROXY: "http://p:1", GIT_SSH_COMMAND: "ssh",
    ANTHROPIC_API_KEY: "k", CLOUDFLARE_API_TOKEN: "t", GITOPS_WRITE_TOKEN: "w", GITOPS_READ_TOKEN: "r",
    REPL_SOURCE_URL: "postgres://u:pw@h/db", DATABASE_URL: "postgres://app_user:app_pw@h/p", AWS_PROFILE: "finals",
    GCP_BILLING_API_KEY: "g",
  });
  assert.deepEqual(Object.keys(env).sort(), ["GIT_SSH_COMMAND", "HOME", "HTTPS_PROXY", "PATH"]);
});

// Z38 REVIEW-6 R6-2: WITH_GIT=0 이미지 + GitOps 켬 → 뜰 때 이유를 돌려준다. GitOps 꺼짐이면 git 을 찾지도 않는다
test("gitopsPreflight: GitOps 켰는데 git 없음이면 이유, 꺼졌으면 null, git 있으면 null", async () => {
  const { gitopsPreflight } = await import("../src/gitops/repo.js");
  const enoent = async () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); };
  let called = 0;
  const ok = async () => { called++; return {}; };
  assert.match((await gitopsPreflight({ GITOPS_REPO_URL: "https://example.invalid/g.git" }, enoent))!, /WITH_GIT=1/);
  assert.equal(await gitopsPreflight({}, enoent), null);
  assert.equal(await gitopsPreflight({ GITOPS_REPO_URL: "x", GITOPS_DISABLE: "1" }, enoent), null);
  assert.equal(await gitopsPreflight({ GITOPS_REPO_DIR: "/tmp/g" }, ok), null);
  assert.equal(called, 1);
  // 실제 실행: PATH 를 비우면 git 을 못 찾는다
  assert.match((await gitopsPreflight({ GITOPS_REPO_DIR: "/tmp/g", PATH: "/nonexistent" }))!, /ENOENT/);
});
