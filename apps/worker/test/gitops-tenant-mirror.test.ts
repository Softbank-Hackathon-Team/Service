import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { TenantMirror, tenantMirrorFromEnv, tenantRepoUrl } from "../src/gitops/tenant-mirror.js";
import { configFromEnv } from "../src/gitops/repo.js";

// 온프레 묶음을 회사 전용 레포로 옮기는 부분만 진짜 git 으로 본다 (원격 = 로컬 bare 레포)
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const author = { name: "t", email: "t@t.invalid" };
const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirror-"));
  const src = join(root, "src");
  mkdirSync(join(src, "tenants", "t-0a1b2c3d", "apps", "shop", "onprem-k3s", "manifests"), { recursive: true });
  mkdirSync(join(src, "tenants", "t-0a1b2c3d", "argocd"), { recursive: true });
  mkdirSync(join(src, "tenants", "t-99999999", "apps", "other", "onprem-k3s"), { recursive: true });
  writeFileSync(join(src, "tenants", "t-0a1b2c3d", "apps", "shop", "onprem-k3s", "manifests", "a.yaml"), "kind: A\n");
  writeFileSync(join(src, "tenants", "t-0a1b2c3d", "argocd", "appproject.yaml"), "{}\n");
  writeFileSync(join(src, "tenants", "t-99999999", "apps", "other", "onprem-k3s", "values.yaml"), "secret-of-other\n");
  const remote = join(root, "remote", "gitops-t-0a1b2c3d.git");
  mkdirSync(remote, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const cfg = { urlTemplate: `file://${join(root, "remote")}/gitops-{tenant}.git`, dir: join(root, "work"), branch: "main",
    push: true, author, maxPushTries: 3 };
  return { root, src, remote, cfg };
}

test("회사 폴더만 회사 레포로 간다 (다른 회사·중앙 울타리는 안 간다), 빈 레포에 첫 push", async () => {
  const f = fixture();
  try {
    const commit = await new TenantMirror(f.cfg, env).sync(f.src, "t-0a1b2c3d", "deploy shop");
    assert.equal(git(f.remote, "rev-parse", "main"), commit, "돌려준 커밋 = 원격 main (Agent 가 보고할 revision)");
    const files = git(f.remote, "ls-tree", "-r", "--name-only", "main").split("\n");
    assert.deepEqual(files, ["tenants/t-0a1b2c3d/apps/shop/onprem-k3s/manifests/a.yaml"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("바뀐 게 없으면 새 커밋 없이 같은 커밋, 지운 파일은 회사 레포에서도 지운다", async () => {
  const f = fixture();
  try {
    const m = new TenantMirror(f.cfg, env);
    const c1 = await m.sync(f.src, "t-0a1b2c3d", "1");
    assert.equal(await m.sync(f.src, "t-0a1b2c3d", "2"), c1);
    rmSync(join(f.src, "tenants", "t-0a1b2c3d", "apps", "shop", "onprem-k3s", "manifests", "a.yaml"));
    writeFileSync(join(f.src, "tenants", "t-0a1b2c3d", "apps", "shop", "onprem-k3s", "manifests", "b.yaml"), "kind: B\n");
    const c3 = await m.sync(f.src, "t-0a1b2c3d", "3");
    assert.notEqual(c3, c1);
    assert.deepEqual(git(f.remote, "ls-tree", "-r", "--name-only", "main").split("\n"),
      ["tenants/t-0a1b2c3d/apps/shop/onprem-k3s/manifests/b.yaml"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("원격이 앞서 있어도(다른 워커) 원격 위에 다시 올린다", async () => {
  const f = fixture();
  try {
    await new TenantMirror(f.cfg, env).sync(f.src, "t-0a1b2c3d", "1");
    // 다른 작업 복사본이 먼저 올림
    const other = { ...f.cfg, dir: join(f.root, "work2") };
    writeFileSync(join(f.src, "tenants", "t-0a1b2c3d", "apps", "shop", "onprem-k3s", "manifests", "c.yaml"), "kind: C\n");
    const c2 = await new TenantMirror(other, env).sync(f.src, "t-0a1b2c3d", "2");
    writeFileSync(join(f.src, "tenants", "t-0a1b2c3d", "apps", "shop", "onprem-k3s", "manifests", "d.yaml"), "kind: D\n");
    const c3 = await new TenantMirror(f.cfg, env).sync(f.src, "t-0a1b2c3d", "3");
    assert.equal(git(f.remote, "rev-parse", "main"), c3);
    assert.equal(git(f.remote, "rev-parse", "main~1"), c2, "앞선 커밋 위에 쌓는다 (강제 push 아님)");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("회사 이름 모양이 아니면 거부 (경로 탈출 방지)", async () => {
  const f = fixture();
  try {
    await assert.rejects(new TenantMirror(f.cfg, env).sync(f.src, "../t-0a1b2c3d", "x"), { code: "GITOPS_TENANT_REPO_FAILED" });
    assert.equal(existsSync(join(f.cfg.dir)), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("설정: GITOPS_TENANT_REPO_URL 없으면 꺼짐, {tenant} 자리 없으면 거부, 있으면 configFromEnv 에 실린다", () => {
  const base = { dir: "/w", branch: "main", push: true, author };
  assert.equal(tenantMirrorFromEnv({}, base), null);
  assert.throws(() => tenantMirrorFromEnv({ GITOPS_TENANT_REPO_URL: "https://github.com/o/gitops-all.git" }, base), /\{tenant\}/);
  const c = configFromEnv({ GITOPS_REPO_URL: "https://github.com/o/gitops.git", GITOPS_TENANT_REPO_URL: "https://github.com/o/gitops-{tenant}.git",
    GITOPS_TENANT_TOKEN: "tok" } as NodeJS.ProcessEnv);
  assert.equal(c?.tenantRepo?.token, "tok");
  assert.equal(c?.tenantRepo?.dir.endsWith("-tenants"), true);
  assert.equal(tenantRepoUrl("https://github.com/o/gitops-{tenant}.git", "t-0a1b2c3d"), "https://github.com/o/gitops-t-0a1b2c3d.git");
});
