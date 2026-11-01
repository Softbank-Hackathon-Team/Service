import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync as x } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitopsRepo, type GitopsError } from "../src/gitops/repo.js";

// Z59: 같은 회사의 두 환경 이전이 울타리(appproject.yaml)를 동시에 고치면 되감기 충돌.
// 고치기 전: GITOPS_GIT_FAILED + 작업 복사본이 rebase 중으로 남아 다음 pull --ff-only 가 전부 실패 (클라우드 3/3 재현)
test("push 앞섬 충돌 + 되감기 충돌 → GITOPS_PUSH_CONFLICT, 작업 복사본은 원격 상태로 깨끗", async () => {
  const t = mkdtempSync(join(tmpdir(), "z59-"));
  const g = (c: string, ...a: string[]) => x("git", ["-C", c, "-c", "user.name=t", "-c", "user.email=t@x", ...a], { encoding: "utf8" }).trim();
  try {
    const seed = join(t, "seed"), bare = join(t, "r.git"), work = join(t, "w"), other = join(t, "o");
    const fence = "tenants/t-1/argocd/appproject.yaml";
    x("git", ["init", "-q", "-b", "main", seed]);
    mkdirSync(join(seed, "tenants/t-1/argocd"), { recursive: true });
    writeFileSync(join(seed, fence), '{"destinations":["t-1-aws-eks"]}\n');
    g(seed, "add", "-A"); g(seed, "commit", "-qm", "seed");
    x("git", ["clone", "-q", "--bare", seed, bare]); x("git", ["clone", "-q", bare, work]); x("git", ["clone", "-q", bare, other]);
    writeFileSync(join(other, fence), '{"destinations":["t-1-aws-eks","t-1-gcp-gke"]}\n'); g(other, "commit", "-qam", "gcp"); g(other, "push", "-q", "origin", "main");
    writeFileSync(join(work, fence), '{"destinations":["t-1-aws-eks","t-1-azure-mock"]}\n'); g(work, "commit", "-qam", "azure");
    const repo = new GitopsRepo({ dir: work, branch: "main", push: true, author: { name: "w", email: "w@x" }, maxPushTries: 3 });
    await assert.rejects((repo as unknown as { pushWithRetry(): Promise<void> }).pushWithRetry(),
      (e: GitopsError) => e.code === "GITOPS_PUSH_CONFLICT");
    assert.ok(!existsSync(join(work, ".git/rebase-merge")) && !existsSync(join(work, ".git/rebase-apply")), "rebase 중으로 남지 않는다");
    assert.equal(g(work, "rev-parse", "HEAD"), g(bare, "rev-parse", "main"), "원격 상태로 돌아간다 → 재개하면 최신 울타리 위에서 다시 렌더");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});
