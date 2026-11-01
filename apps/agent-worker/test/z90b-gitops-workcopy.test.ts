// 작업 Z90b: 장애 점검 작업 복사본 = 진짜 git 레포 deploy/. 설정 없으면 GITOPS_NOT_CONFIGURED, 수정안은 새 브랜치 커밋
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitopsWorkcopyFromEnv, WorkcopyError } from "../src/gitops-workcopy.js";

const g = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
function repo() {
  const d = mkdtempSync(join(tmpdir(), "z90b-src-"));
  execFileSync("git", ["init", "-q", "-b", "main", d]);
  mkdirSync(join(d, "deploy"));
  writeFileSync(join(d, "deploy", "web.yaml"), 'kind: Deployment\nmemory: "128Mi"\n');
  writeFileSync(join(d, "README.md"), "x\n");
  g(d, "add", "-A"); g(d, "commit", "-q", "-m", "init");
  return d;
}

test("설정 없음·GITOPS_DISABLE=1 → GITOPS_NOT_CONFIGURED (고정 파일로 대신하지 않음)", async () => {
  for (const env of [{}, { GITOPS_DISABLE: "1", GITOPS_REPO_DIR: "/tmp/x" }]) {
    await assert.rejects(() => gitopsWorkcopyFromEnv(env)({ runId: "r" }), (e: unknown) => e instanceof WorkcopyError && e.code === "GITOPS_NOT_CONFIGURED");
  }
});

test("로컬 레포: deploy/ YAML 만 읽고, 수정안을 agent/remediate-<run> 브랜치로 원본에 올린다 (main 그대로)", async () => {
  const d = repo();
  const mainBefore = g(d, "rev-parse", "main");
  const wc = await gitopsWorkcopyFromEnv({ GITOPS_REPO_DIR: d, PATH: process.env.PATH, HOME: process.env.HOME })({ runId: "abcdef12-3456" });
  assert.deepEqual([...wc.repo.keys()], ["deploy/web.yaml"]);
  const p = await wc.propose(new Map([["deploy/web.yaml", 'kind: Deployment\nmemory: "512Mi"\n']]), "web 메모리 512Mi");
  await wc.dispose();
  assert.equal(p?.branch, "agent/remediate-abcdef12");
  assert.equal(p?.pushed, true);
  assert.equal(p?.push, "local");
  assert.equal(g(d, "rev-parse", "agent/remediate-abcdef12"), p?.commit);
  assert.match(g(d, "show", "agent/remediate-abcdef12:deploy/web.yaml"), /512Mi/);
  assert.equal(g(d, "rev-parse", "main"), mainBefore);
  // deploy/ 밖 파일·바뀐 것 없음은 커밋하지 않는다
  const wc2 = await gitopsWorkcopyFromEnv({ GITOPS_REPO_DIR: d, PATH: process.env.PATH })({ runId: "ffff0000" });
  assert.equal(await wc2.propose(new Map([["README.md", "y"]]), "t"), null);
  await wc2.dispose();
});

test("deploy/ 없는 레포 → GITOPS_NO_DEPLOY_DIR", async () => {
  const d = mkdtempSync(join(tmpdir(), "z90b-empty-"));
  execFileSync("git", ["init", "-q", "-b", "main", d]);
  writeFileSync(join(d, "a.txt"), "x"); g(d, "add", "-A"); g(d, "commit", "-q", "-m", "i");
  await assert.rejects(() => gitopsWorkcopyFromEnv({ GITOPS_REPO_DIR: d, PATH: process.env.PATH })({ runId: "r" }), (e: unknown) => (e as WorkcopyError).code === "GITOPS_NO_DEPLOY_DIR");
});

test("Z90b-2: 원격 레포(URL)는 GITOPS_PUSH 없으면 push 안 함 + PUSH_DISABLED + 패치 남김, 원격 레포는 그대로", async () => {
  const bare = mkdtempSync(join(tmpdir(), "z90b-bare-"));
  const src = repo();
  execFileSync("git", ["clone", "-q", "--bare", src, bare]);
  const env = { GITOPS_REPO_URL: `file://${bare}`, PATH: process.env.PATH, HOME: process.env.HOME };
  const wc = await gitopsWorkcopyFromEnv(env)({ runId: "1234abcd-0" });
  const p = await wc.propose(new Map([["deploy/web.yaml", 'memory: "512Mi"\n']]), "t");
  await wc.dispose();
  assert.equal(p?.push, "off");
  assert.equal(p?.pushed, false);
  assert.match(p!.reason, /^PUSH_DISABLED/);
  assert.match(p!.patch ?? "", /512Mi/);
  assert.throws(() => g(bare, "rev-parse", "--verify", "agent/remediate-1234abcd"));
  // GITOPS_PUSH=1 일 때만 원격에 브랜치
  const wc2 = await gitopsWorkcopyFromEnv({ ...env, GITOPS_PUSH: "1" })({ runId: "1234abcd-0" });
  const p2 = await wc2.propose(new Map([["deploy/web.yaml", 'memory: "512Mi"\n']]), "t");
  await wc2.dispose();
  assert.equal(p2?.push, "remote");
  assert.equal(g(bare, "rev-parse", "agent/remediate-1234abcd"), p2?.commit);
});

test("Z90b-2: 경로 탈출(deploy/../..)은 GITOPS_BAD_PATH, 게이트 GATE-01 도 거부, 심볼릭 링크는 안 읽음", async () => {
  const d = repo();
  execFileSync("ln", ["-s", "/etc/hostname", join(d, "deploy", "link.yaml")]);
  g(d, "add", "-A"); g(d, "commit", "-q", "-m", "link");
  const wc = await gitopsWorkcopyFromEnv({ GITOPS_REPO_DIR: d, PATH: process.env.PATH })({ runId: "babe0000" });
  assert.deepEqual([...wc.repo.keys()], ["deploy/web.yaml"]);
  for (const bad of ["deploy/../../../tmp/z90b-pwn.yaml", "deploy/./x.yaml", "deploy//x.yaml"])
    await assert.rejects(() => wc.propose(new Map([[bad, "x"]]), "t"), (e: unknown) => (e as WorkcopyError).code === "GITOPS_BAD_PATH");
  await wc.dispose();
  const { gateChanges } = await import("@svc/agent");
  const v = gateChanges(new Map(), new Map([["deploy/../../../tmp/z90b-pwn.yaml", "kind: ConfigMap\n"]]));
  assert.equal(v.ok, false);
  assert.match(v.violations.join(), /GATE-01/);
});
