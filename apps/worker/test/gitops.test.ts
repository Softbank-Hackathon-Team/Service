import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONE, apiImage } from "./demo-one.js";
import { adapterFor } from "@svc/adapters";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { mockArgoWatcher } from "../src/gitops/argo-watch.js";
import {
  configFromEnv, approvedValues, bundleRefOf, commitTrafficWeight, deployToGitops, fillPlaceholders, GitopsError,
  GitopsRepo, resourceId, tenantSlug, type DeployInput,
} from "../src/gitops/index.js";

const TENANT = "9f8e7d6c-0000-4000-8000-000000000001";
const ENV_ID = "33333333-3333-4333-8333-333333333333";
const spec = ONE;
const plan = buildPlanDoc({
  planId: "7f000000-0000-4000-8000-000000000001", migrationId: "4a8c0000-0000-4000-8000-000000000001",
  spec, target: { envId: ENV_ID, provider: "gcp", region: "default" }, precheck: stubPrecheck(), now: new Date(),
});
const input: DeployInput = {
  tenantId: TENANT, spec, plan,
  target: { envId: ENV_ID, provider: "gcp", region: "default", accountId: "demo-project" },
  tfOutputs: { app_gsa_email: "app@demo-project.iam.gserviceaccount.com", db_private_ip: "10.0.3.12",
               db_password_secret_id: "db-password" },
};

test("회사 폴더 이름과 자리표시 채우기", () => {
  assert.equal(tenantSlug(TENANT), "t-9f8e7d6c");
  const r = fillPlaceholders({ a: "<tf-output:x>", b: ["<env:tenantId>-y"], c: "<tf-output:none>" },
    { tf: { x: "1" }, env: { tenantId: "t-1" } });
  assert.deepEqual(r.values, { a: "1", b: ["t-1-y"], c: "<tf-output:none>" });
  assert.deepEqual(r.missing, ["<tf-output:none>"]);
});

test("manifest 한 파일에서 Kind/namespace/name", () => {
  const y = "apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  labels:\n    a: b\n  namespace: t-1-web\nspec: {}\n";
  assert.equal(resourceId(y), "Service/t-1-web/web");
});

test("승인 뒤 명세가 바뀌면 GITOPS_VALUES_DRIFT", () => {
  assert.ok(approvedValues(input));
  const changed = apiImage(spec, "2");
  assert.throws(() => approvedValues({ ...input, spec: changed }), (e: GitopsError) => e.code === "GITOPS_VALUES_DRIFT");
});

test("자리표시가 남으면 커밋하지 않는다", async () => {
  const repo = new GitopsRepo({ dir: "/nonexistent", branch: "main", push: false, author: { name: "t", email: "t@x" }, maxPushTries: 1 });
  await assert.rejects(deployToGitops(repo, { ...input, tfOutputs: {} }, mockArgoWatcher), (e: GitopsError) => e.code === "GITOPS_PLACEHOLDER_MISSING");
});

// 진짜 git + helm + 검증 도구. gitops 레포 뼈대(tools/node_modules 설치된 것)를 GITOPS_FIXTURE_DIR로 주면 돈다
const FIXTURE = process.env.GITOPS_FIXTURE_DIR;
const hasHelm = (() => { try { execFileSync("helm", ["version", "--short"]); return true; } catch { return false; } })();
const skip = !FIXTURE || !existsSync(join(FIXTURE ?? "", "tools", "node_modules")) || !hasHelm
  ? "GITOPS_FIXTURE_DIR(tools/node_modules 포함)와 helm이 있어야 한다" : false;

test("로컬 bare 레포로 끝에서 끝까지: 커밋·push·멱등·트래픽·앞섬 충돌", { skip }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gitops-it-"));
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@x", ...a], { encoding: "utf8" }).trim();
  try {
    const seed = join(tmp, "seed"), bare = join(tmp, "remote.git"), work = join(tmp, "work"), other = join(tmp, "other");
    cpSync(FIXTURE!, seed, { recursive: true });
    sh(tmp, "init", "-q", "-b", "main", seed); sh(seed, "add", "-A"); sh(seed, "commit", "-q", "-m", "seed");
    execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
    execFileSync("git", ["clone", "-q", bare, work]);
    execFileSync("git", ["clone", "-q", bare, other]);
    cpSync(join(FIXTURE!, "tools", "node_modules"), join(work, "tools", "node_modules"), { recursive: true });

    const repo = new GitopsRepo({ dir: work, branch: "main", push: true, author: { name: "platform-worker", email: "w@x" }, maxPushTries: 3 });

    const t0 = Date.now();
    const a = await deployToGitops(repo, input, mockArgoWatcher);
    const ms = Date.now() - t0;
    assert.equal(a.result.status, "synced_healthy");
    assert.equal(a.app, "t-9f8e7d6c-" + spec.app.name + "-gcp-gke");
    assert.equal(sh(bare, "rev-parse", "main"), a.commit);
    const fence = JSON.parse(readFileSync(join(work, "tenants/t-9f8e7d6c/argocd/appproject.yaml"), "utf8"));
    assert.deepEqual(fence.spec.destinations, [{ name: "t-9f8e7d6c-gcp-gke", namespace: "app-*" }], "새 회사 울타리를 같은 커밋에 만든다");
    const dir = join(work, "tenants/t-9f8e7d6c/apps", spec.app.name, "gcp-gke");
    assert.equal(readFileSync(join(dir, "bundle.sha256"), "utf8").trim(), a.result.bundleHash);
    assert.match(sh(bare, "log", "-1", "--format=%B", "main"), /Bundle-Sha256: [0-9a-f]{64}/);
    assert.ok(a.result.resources.some((r) => r.startsWith("Deployment/app-" + spec.app.name + "/")));

    const again = await deployToGitops(repo, input, mockArgoWatcher);
    assert.equal(again.commit, a.commit, "같은 계획을 다시 배포하면 새 커밋이 없다");

    const b = bundleRefOf(input);
    await assert.rejects(commitTrafficWeight(repo, b, 30), (e: GitopsError) => e.code === "GITOPS_WEIGHT_NOT_APPROVED");

    // 앞섬 충돌 만들기: 워커가 커밋한 직후(push 전) 다른 쪽이 먼저 push 하게 post-commit 훅을 건다
    const hook = join(work, ".git", "hooks", "post-commit");
    writeFileSync(hook, `#!/bin/sh\nunset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE\ncd ${other} && git pull -q origin main && echo x > NOTE.md && git add NOTE.md && ` +
      `git -c user.name=o -c user.email=o@x commit -q -m other && git push -q origin main\nrm -f ${hook}\n`);
    chmodSync(hook, 0o755);
    const w = await commitTrafficWeight(repo, b, 50);
    assert.ok(w.changed);
    assert.equal(sh(bare, "rev-parse", "main"), w.commit);
    assert.match(sh(bare, "log", "-1", "--format=%s", "main"), /traffic\(.*\): 0 -> 50/);
    assert.match(sh(bare, "log", "-2", "--format=%s", "main"), /other/, "남의 커밋 위로 다시 올라갔다");
    assert.notEqual(w.bundleSha256, a.result.bundleHash, "트래픽 단계가 바뀌면 지문도 바뀐다");
    console.log(`deploy commit+push ${ms} ms`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("환경변수: 둘 다 없으면 STUB, URL만 있어도 켜진다", () => {
  assert.equal(configFromEnv({}), null);
  const c = configFromEnv({ GITOPS_REPO_URL: "https://github.com/Softbank-Hackathon-Team/gitops", GITOPS_WRITE_TOKEN: "tok" });
  assert.equal(c?.url, "https://github.com/Softbank-Hackathon-Team/gitops");
  assert.equal(c?.token, "tok");
  assert.equal(configFromEnv({ GITOPS_REPO_DIR: "/x" })?.dir, "/x");
});

test("URL 모드: 없는 레포로 clone 실패해도 토큰이 오류 메시지에 안 남는다", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "gitops-url-")), "w");
  const token = "ghs_SECRET_TOKEN_VALUE_123";
  const repo = new GitopsRepo({ dir, url: "file:///nonexistent/repo.git", token, branch: "main", push: true,
    author: { name: "t", email: "t@x" }, maxPushTries: 1 });
  await assert.rejects(repo.chartVersion(), (e: GitopsError) => {
    assert.equal(e.code, "GITOPS_GIT_FAILED");
    assert.ok(!e.message.includes(token) && !e.message.includes(Buffer.from(`x-access-token:${token}`).toString("base64")));
    return true;
  });
});

test("URL 모드: 로컬 bare 레포를 clone 해서 배포", { skip }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gitops-url-it-"));
  try {
    const seed = join(tmp, "seed"), bare = join(tmp, "remote.git");
    cpSync(FIXTURE!, seed, { recursive: true });
    rmSync(join(seed, "tools", "node_modules"), { recursive: true, force: true });
    const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@x", ...a], { encoding: "utf8" }).trim();
    g(tmp, "init", "-q", "-b", "main", seed); g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "seed");
    execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
    const cfg = configFromEnv({ GITOPS_REPO_URL: `file://${bare}`, GITOPS_WRITE_TOKEN: "tok", GITOPS_REPO_DIR: join(tmp, "work") })!;
    const out = await deployToGitops(new GitopsRepo(cfg), input, mockArgoWatcher);
    assert.equal(g(bare, "rev-parse", "main"), out.commit);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
