// 리허설 렌더 = 커밋할 바이트: renderBundle 은 커밋 없이 렌더하고 작업 복사본을 되돌린다.
//   통과한 지문으로 커밋하면 커밋된 manifests 가 렌더한 글자와 같고, 지문이 다르면 커밋하지 않고 REHEARSAL_BUNDLE_MISMATCH
// 진짜 git + helm + gitops 레포 검증 도구. gitops 레포 뼈대(tools/node_modules 설치, charts/app = 이 레포 gitops/charts/app)를 GITOPS_FIXTURE_DIR 로 주면 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUB_TF_OUTPUTS, stubTfOutputsV2 } from "@svc/adapters";
import { ONE } from "./demo-one.js";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { mockArgoWatcher } from "../src/gitops/argo-watch.js";
import { bundlePath, bundleRefOf, deployToGitops, GitopsError, GitopsRepo, clusterSecretFile, renderForRehearsal, type DeployInput } from "../src/gitops/index.js";

const FIXTURE = process.env.GITOPS_FIXTURE_DIR;
const hasHelm = (() => { try { execFileSync("helm", ["version", "--short"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !FIXTURE || !existsSync(join(FIXTURE ?? "", "tools", "node_modules")) || !hasHelm
  ? "GITOPS_FIXTURE_DIR(tools/node_modules 포함)와 helm이 있어야 한다" : false;

const ENV_ID = "33333333-3333-4333-8333-333333333333";
const plan = buildPlanDoc({ planId: "7f000000-0000-4000-8000-000000000002", migrationId: "4a8c0000-0000-4000-8000-000000000002",
  spec: ONE, target: { envId: ENV_ID, provider: "gcp", region: "default" }, precheck: stubPrecheck(), now: new Date() });
const input: DeployInput = { tenantId: "9f8e7d6c-0000-4000-8000-000000000002", spec: ONE, plan,
  target: { envId: ENV_ID, provider: "gcp", region: "default", accountId: "demo-project" },
  tfOutputs: { ...STUB_TF_OUTPUTS, ...stubTfOutputsV2(ONE) } };

function workRepo() {
  const tmp = mkdtempSync(join(tmpdir(), "rehearsal-render-"));
  const sh = (...a: string[]) => execFileSync("git", ["-C", tmp, "-c", "user.name=t", "-c", "user.email=t@x", ...a], { encoding: "utf8" }).trim();
  cpSync(FIXTURE!, tmp, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", tmp]);
  sh("add", "-A"); sh("commit", "-q", "-m", "seed");
  return { tmp, sh, repo: new GitopsRepo({ dir: tmp, branch: "main", push: false, author: { name: "platform-worker", email: "w@x" }, maxPushTries: 1 }) };
}

test("렌더만: 지문과 manifests 글자를 돌려주고 작업 복사본·HEAD 는 그대로 (첫 배포도, 이미 커밋된 묶음도)", { skip }, async () => {
  const { tmp, sh, repo } = workRepo();
  try {
    const head = sh("rev-parse", "HEAD");
    const a = await renderForRehearsal(repo, input);
    assert.match(a.rendered.bundleSha256, /^[0-9a-f]{64}$/);
    assert.ok(a.rendered.manifests.length > 3 && a.rendered.manifests.every((m) => m.path.startsWith("manifests/") && m.yaml.includes("kind:")));
    assert.equal(sh("status", "--porcelain"), "", "첫 배포 렌더 뒤 남은 파일 없음");
    assert.equal(sh("rev-parse", "HEAD"), head);
    // 통과한 지문으로 커밋 → 커밋된 바이트 = 렌더한 바이트
    const out = await deployToGitops(repo, input, mockArgoWatcher, { expectBundleSha: a.rendered.bundleSha256 });
    assert.equal(out.result.bundleHash, a.rendered.bundleSha256);
    const dir = join(tmp, bundlePath(bundleRefOf(input)));
    for (const m of a.rendered.manifests) assert.equal(readFileSync(join(dir, m.path), "utf8"), m.yaml, m.path);
    // 이미 커밋된 묶음 위에서 다시 렌더해도 같은 지문, 작업 복사본 그대로
    const b = await renderForRehearsal(repo, input);
    assert.equal(b.rendered.bundleSha256, a.rendered.bundleSha256);
    assert.equal(sh("status", "--porcelain"), "");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("GKE 접속 정보: 배포 때 cluster Secret 을 같이 커밋하고, 다시 배포해도 다른 앱 구역을 안 지운다. 묶음 지문은 그대로", { skip }, async () => {
  const { tmp, repo } = workRepo();
  try {
    const gke = { ...input, tfOutputs: { ...input.tfOutputs, cluster_endpoint: "34.0.0.1", cluster_ca_certificate: "Y2E=" } };
    const b = bundleRefOf(gke);
    const file = join(tmp, "tenants", b.tenant, "argocd", clusterSecretFile("gcp-gke"));
    const plain = await renderForRehearsal(repo, gke);
    const out = await deployToGitops(repo, gke, mockArgoWatcher, { expectBundleSha: plain.rendered.bundleSha256 });
    assert.equal(out.result.bundleHash, plain.rendered.bundleSha256, "Secret 은 묶음 지문 밖");
    const s = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(s.metadata.name, `${b.tenant}-gcp-gke`);
    assert.equal(s.stringData.name, `${b.tenant}-gcp-gke`);
    assert.equal(s.stringData.server, "https://34.0.0.1");
    assert.equal(s.stringData.namespaces, `app-${b.app}`);
    const cfg = JSON.parse(s.stringData.config);
    assert.equal(cfg.execProviderConfig.env.GOOGLE_APPLICATION_CREDENTIALS, `/var/run/gcp-cred/${b.tenant}.json`);
    assert.equal(cfg.tlsClientConfig.caData, "Y2E=");

    s.stringData.namespaces = "app-other";
    writeFileSync(file, JSON.stringify(s));
    await deployToGitops(repo, gke, mockArgoWatcher);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).stringData.namespaces, `app-other,app-${b.app}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("GKE 출력이 없으면(흉내 길) cluster Secret 을 만들지 않는다", { skip }, async () => {
  const { tmp, repo } = workRepo();
  try {
    await deployToGitops(repo, input, mockArgoWatcher);
    assert.equal(existsSync(join(tmp, "tenants", bundleRefOf(input).tenant, "argocd", clusterSecretFile("gcp-gke"))), false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("EKS 접속 정보: 허브를 켜면 배포 커밋에 svc-deploy cluster Secret 이 같이 들어가고 validate 를 통과한다", { skip }, async () => {
  const { tmp, sh, repo } = workRepo();
  const awsPlan = buildPlanDoc({ planId: "7f000000-0000-4000-8000-000000000003", migrationId: "4a8c0000-0000-4000-8000-000000000003",
    spec: ONE, target: { envId: ENV_ID, provider: "aws", region: "default" }, precheck: stubPrecheck(), now: new Date() });
  const aws: DeployInput = { ...input, plan: awsPlan, target: { envId: ENV_ID, provider: "aws", region: "default", accountId: "111122223333" },
    tfOutputs: { ...input.tfOutputs, cluster_name: "customer-eks", cluster_endpoint: "https://ABC.gr7.ap-northeast-2.eks.amazonaws.com", cluster_ca_certificate: "Y2E=" } };
  const prev = process.env.ARGO_HUB_ROLE_ARN;
  process.env.ARGO_HUB_ROLE_ARN = "arn:aws:iam::725072160743:role/platform-argocd-hub";
  try {
    const out = await deployToGitops(repo, aws, mockArgoWatcher);
    const b = bundleRefOf(aws);
    const rel = `tenants/${b.tenant}/argocd/${clusterSecretFile("aws-eks")}`;
    assert.ok(sh("show", "--name-only", "--format=", out.commit).split("\n").includes(rel), "Secret 이 배포 커밋에 있다");
    const s = JSON.parse(readFileSync(join(tmp, rel), "utf8"));
    assert.equal(s.stringData.name, `${b.tenant}-aws-eks`);
    assert.equal(s.stringData.namespaces, `app-${b.app}`);
    assert.deepEqual(JSON.parse(s.stringData.config).awsAuthConfig, { clusterName: "customer-eks", roleARN: "arn:aws:iam::111122223333:role/svc-deploy" });
  } finally {
    if (prev === undefined) delete process.env.ARGO_HUB_ROLE_ARN; else process.env.ARGO_HUB_ROLE_ARN = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("지문이 다르면 커밋하지 않고 REHEARSAL_BUNDLE_MISMATCH, 작업 복사본은 되돌린다", { skip }, async () => {
  const { tmp, sh, repo } = workRepo();
  try {
    const head = sh("rev-parse", "HEAD");
    await assert.rejects(deployToGitops(repo, input, mockArgoWatcher, { expectBundleSha: "0".repeat(64) }),
      (e: GitopsError) => e.code === "REHEARSAL_BUNDLE_MISMATCH");
    assert.equal(sh("rev-parse", "HEAD"), head, "커밋 없음");
    assert.equal(sh("status", "--porcelain"), "", "되돌림");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
