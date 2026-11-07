// 온프레 환경별 gitops 폴더 (onprem-k3s-<환경 앞 8자>) + 롤백 뒤 도착 묶음 지우기 (2026-11-07 GCP→온프레 실검증에서 찾은 두 결함)
//   1) 예전 폴더 tenants/<t>/apps/<앱>/onprem-k3s 는 환경 구분이 없어 한 회사의 온프레 클러스터가 모두 같은 앱을 받았다
//   2) 롤백이 온프레 도착 묶음을 안 지워 앱·CNPG DB 가 남았다
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argoAppName, bundlePath, bundleRefFor, siteOf, GitopsRepo } from "../src/gitops/index.js";

const T = "11111111-2222-4333-8444-555555555555";
const ENV_A = "1adfeb6c-0000-4000-8000-000000000001";
const ENV_B = "cdaece4c-0000-4000-8000-000000000002";
const M1 = "aaaaaaaa-0000-4000-8000-000000000001", M2 = "bbbbbbbb-0000-4000-8000-000000000002";

test("온프레 묶음은 환경마다 폴더·Argo 앱 이름이 다르고, 클라우드는 예전 그대로", () => {
  const a = bundleRefFor(T, "shop-api", "onprem", ENV_A), b = bundleRefFor(T, "shop-api", "onprem", ENV_B);
  assert.equal(siteOf(ENV_A), "1adfeb6c");
  assert.equal(bundlePath(a), "tenants/t-11111111/apps/shop-api/onprem-k3s-1adfeb6c");
  assert.equal(argoAppName(a), "t-11111111-shop-api-onprem-k3s-1adfeb6c");
  assert.notEqual(bundlePath(a), bundlePath(b));
  const g = bundleRefFor(T, "shop-api", "gcp", ENV_A);
  assert.deepEqual(g, { tenant: "t-11111111", app: "shop-api", env: "gcp-gke" });
  assert.equal(argoAppName(g), "t-11111111-shop-api-gcp-gke");
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "onprem-site-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "tools", "node_modules"), { recursive: true });   // ensureCheckout 이 npm install 을 건너뛰게
  const bundle = (rel: string, migrationId: string) => {
    mkdirSync(join(dir, rel, "manifests"), { recursive: true });
    writeFileSync(join(dir, rel, "plan.json"), JSON.stringify({ env: "onprem-k3s", migrationId, bundleSha256: "" }));
    writeFileSync(join(dir, rel, "values.yaml"), JSON.stringify({ traffic: null }));
    writeFileSync(join(dir, rel, "manifests", "cluster-app-db.yaml"), "kind: Cluster\n");
  };
  writeFileSync(join(dir, "README.md"), "x\n");
  const repo = new GitopsRepo({ dir, branch: "main", push: false, author: { name: "t", email: "t@x" }, maxPushTries: 1 } as ConstructorParameters<typeof GitopsRepo>[0]);
  return { dir, git, bundle, repo, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("예전 공용 폴더로 배포된 이전은 계속 그 폴더를 읽는다 (진행 중 이전 보호). 새 폴더가 있으면 새 폴더", async () => {
  const f = fixture();
  try {
    const a = bundleRefFor(T, "shop-api", "onprem", ENV_A);
    assert.deepEqual(await f.repo.resolve(a), a);                       // 둘 다 없으면 새 폴더 (첫 배포)
    f.bundle("tenants/t-11111111/apps/shop-api/onprem-k3s", M1);
    assert.equal(bundlePath(await f.repo.resolve(a)), "tenants/t-11111111/apps/shop-api/onprem-k3s");
    assert.equal((await f.repo.readPlan(a)).migrationId, M1);
    f.bundle(bundlePath(a), M2);
    assert.deepEqual(await f.repo.resolve(a), a);
    assert.equal((await f.repo.readPlan(a)).migrationId, M2);
  } finally { f.done(); }
});

test("롤백 정리: 이 이전의 묶음 폴더만 지워 커밋한다. 다른 이전 폴더·다른 환경 폴더는 그대로, 다시 불러도 같다", async () => {
  const f = fixture();
  try {
    const a = bundleRefFor(T, "shop-api", "onprem", ENV_A), b = bundleRefFor(T, "shop-api", "onprem", ENV_B);
    f.bundle(bundlePath(a), M1);
    f.bundle(bundlePath(b), M2);
    f.git("add", "-A"); f.git("commit", "-q", "-m", "seed");
    assert.deepEqual(await f.repo.removeBundle(a, M2, "x"), { skipped: "other_migration", path: bundlePath(a) });
    const r = await f.repo.removeBundle(a, M1, "rollback: remove target bundle");
    assert.ok(r.commit && !r.skipped);
    assert.equal(existsSync(join(f.dir, bundlePath(a))), false);
    assert.equal(existsSync(join(f.dir, bundlePath(b), "plan.json")), true);
    assert.equal(f.git("status", "--porcelain"), "");
    assert.match(f.git("log", "-1", "--format=%s"), /^cleanup\(t-11111111\/shop-api\/onprem-k3s-1adfeb6c\): rollback/);
    assert.deepEqual(await f.repo.removeBundle(a, M1, "x"), { skipped: "no_bundle", path: bundlePath(a) });
  } finally { f.done(); }
});
