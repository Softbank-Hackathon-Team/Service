// worker 가 gitops 레포에 쓰는 경로 ↔ gitops 검사기 허용 목록 계약 (#373 D4)
//   왜: PR #302 뒤 worker 가 tenants/<회사>/argocd/cluster-aws-eks.yaml 을 쓰기 시작했는데 gitops 레포 tools/validate.mjs 가 그 파일을 몰라서
//   온프레→AWS 실이전이 GITOPS_VALIDATE_FAILED("이 폴더에 둘 수 없는 파일이다")로 11분 20초 멈췄다 (2026-11-07, gitops PR #13 으로 고침).
//   이런 어긋남을 실이전 전에 Service CI 에서 잡는다.
//   어떻게: 손으로 적은 경로 목록이 아니라 진짜 쓰기 함수(deployToGitops·commitTrafficWeight·commitReplicationCleanup·GitopsRepo.removeBundle)를
//   임시 gitops 작업 복사본에 돌리고, 커밋된 경로를 git 에서 전부 모아 대조한다.
//     - GITOPS_FIXTURE_DIR = gitops 레포 체크아웃(tools/node_modules 설치) + helm 이 있으면: GitopsRepo 가 커밋마다 진짜 render.mjs·validate.mjs 를 부르고,
//       모은 경로를 진짜 path-guard.mjs 에도 넣는다 (로컬, 그리고 ci.yml gitops 작업에 읽기 토큰이 있을 때)
//     - 없으면 (CI 기본: gitops 레포가 비공개라 Service CI 에 읽기 토큰이 없다): 흉내 render/validate 로 커밋하고 고정 거울(gitops-path-rules.ts)과 대조
//     두 길 모두 고정 거울 대조는 한다. 거울은 gitops 레포 be845bb 기준이고, 고칠 gitops 파일 이름은 gitops-path-rules.ts 머리에 있다
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { Provider, ReplicationEndpoint } from "@svc/contracts";
import { STUB_TF_OUTPUTS, stubTfOutputsV2 } from "@svc/adapters";
import { ONE } from "./demo-one.js";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { mockArgoWatcher } from "../src/gitops/argo-watch.js";
import { sealedSecretValues } from "../src/gitops/migration-secrets.js";
import { TUNNEL_TOKEN_SECRET } from "../src/traffic-entry.js";
import {
  DELIVERY, ENV_DIR, GitopsRepo, bundlePath, bundleRefFor, bundleRefOf, clusterSecretFile, commitReplicationCleanup, commitTrafficWeight,
  decideDelivery, deployToGitops, filledValues, legacyRef, tenantSlug, type ClusterAccess, type DeployInput,
} from "../src/gitops/index.js";
import {
  ARGOCD_FILES, ARGOCD_FILES_BEFORE_PR13, BUNDLE_REQUIRED, PATH_GUARD_BOT_ONLY, PATH_GUARD_KNOWN_GAPS, PINNED, validateRejects,
} from "./gitops-path-rules.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const has = (bin: string, args: string[]) => { try { execFileSync(bin, args, { stdio: "ignore" }); return true; } catch { return false; } };
const FIXTURE = process.env.GITOPS_FIXTURE_DIR;
const REAL = !!FIXTURE && existsSync(join(FIXTURE, "tools", "validate.mjs")) && existsSync(join(FIXTURE, "tools", "path-guard.mjs"))
  && existsSync(join(FIXTURE, "tools", "node_modules")) && has("helm", ["version", "--short"]);
const OPENSSL = has("openssl", ["version"]);

// 회사·환경 번호는 시험용. 모든 클라우드 묶음 + 온프레 환경별 폴더 + 클러스터 접속 정보를 한 회사에 다 그린다
const TENANT = "3730d400-0000-4000-8000-000000000373";
const T = tenantSlug(TENANT);
const ENV_IDS: Record<Provider, string> = {
  gcp: "0373a001-0000-4000-8000-000000000001", aws: "0373a002-0000-4000-8000-000000000002",
  onprem: "0373a003-0000-4000-8000-000000000003", azure_mock: "0373a004-0000-4000-8000-000000000004",
};
// 클러스터 접속 정보를 쓰는 환경 전부. ClusterAccess 에 환경이 늘면 여기서 타입 검사가 깨진다 → 거울(ARGOCD_FILES)도 같이 본다
const CLUSTER_ENVS = { "gcp-gke": true, "aws-eks": true } satisfies Record<ClusterAccess["env"], true>;
const CLUSTER_OUT: Partial<Record<Provider, Record<string, string>>> = {
  gcp: { cluster_endpoint: "34.0.0.1", cluster_ca_certificate: "Y2E=" },
  aws: { cluster_endpoint: "https://ABCDEF0123.gr7.ap-northeast-2.eks.amazonaws.com", cluster_ca_certificate: "Y2E=", cluster_name: "customer-eks" },
};
const ACCOUNT: Record<Provider, string | null> = { gcp: "demo-project", aws: "111122223333", onprem: null, azure_mock: "00000000-0000-0000-0000-000000000000" };

function inputFor(provider: Provider, n: number): DeployInput {
  const target = { envId: ENV_IDS[provider], provider, region: "default" };
  const id = (p: string) => `${p}000000-0000-4000-8000-00000000037${n}`;
  const plan = buildPlanDoc({ planId: id("7f"), migrationId: id("4a"), spec: ONE, target, precheck: stubPrecheck(), now: new Date() });
  return { tenantId: TENANT, spec: ONE, plan,
    // aws: 도착 환경 꼬리가 붙은 배포 역할(svc-deploy-<8자>)까지 그린다 (validate.mjs EKS_DEPLOY_ROLE)
    target: { ...target, accountId: ACCOUNT[provider], ...(provider === "aws" ? { awsRoleSuffix: "-0373abcd" } : {}) },
    tfOutputs: { ...STUB_TF_OUTPUTS, ...stubTfOutputsV2(ONE), ...(CLUSTER_OUT[provider] ?? {}) } };
}

// ── gitops 작업 복사본 ──
// 흉내 render: 진짜 tools/render.mjs 와 같은 자리에 같은 이름의 파일(manifests/, bundle.sha256, plan.json 의 bundleSha256)만 쓴다.
//   manifests/ 안 파일 이름은 진짜 렌더(helm template → <kind>-<이름>.yaml)가 정하는 gitops 쪽 몫이라 흉내는 한 장만 쓴다
const STUB_RENDER = `import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
for (const rel of process.argv.slice(2)) {
  const dir = resolve(rel);
  const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  const h = createHash("sha256").update(readFileSync(join(dir, "values.yaml"))).digest("hex");
  rmSync(join(dir, "manifests"), { recursive: true, force: true });
  mkdirSync(join(dir, "manifests"));
  writeFileSync(join(dir, "manifests", "configmap-render-stub.yaml"), "apiVersion: v1\\nkind: ConfigMap\\nmetadata:\\n  name: render-stub\\n  namespace: " + plan.target.namespace + "\\n");
  writeFileSync(join(dir, "bundle.sha256"), h + "\\n");
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ ...plan, bundleSha256: h }, null, 2) + "\\n");
}
`;
// 흉내 validate: 늘 통과. 경로는 시험이 커밋 뒤 고정 거울로 본다
const STUB_VALIDATE = `console.log("validate stub: 경로는 gitops-path-contract.test.ts 가 고정 거울로 본다");\n`;

function workCopy() {
  const dir = mkdtempSync(join(tmpdir(), "gitops-contract-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", ...a], { encoding: "utf8" }).trim();
  if (REAL) {
    // 진짜 레포의 tenants/ 는 실이전 기록이라 뺀다 (이 시험의 회사만 검사하게). .git 도 빼고 새로 만든다
    cpSync(FIXTURE!, dir, { recursive: true, filter: (src) => ![".git", "tenants", ".render"].includes(relative(FIXTURE!, src).split(sep)[0]!) });
  } else {
    mkdirSync(join(dir, "tools", "node_modules"), { recursive: true });   // ensureCheckout 이 npm install 을 건너뛰게
    writeFileSync(join(dir, "tools", "render.mjs"), STUB_RENDER);
    writeFileSync(join(dir, "tools", "validate.mjs"), STUB_VALIDATE);
    mkdirSync(join(dir, "platform"), { recursive: true });
    writeFileSync(join(dir, "platform", "project-platform-root.yaml"), "spec:\n  sourceRepos:\n    - https://github.com/Softbank-Hackathon-Team/gitops.git\n");
    mkdirSync(join(dir, "charts", "app"), { recursive: true });
    cpSync(join(ROOT, "gitops", "charts", "app", "Chart.yaml"), join(dir, "charts", "app", "Chart.yaml"));
  }
  mkdirSync(join(dir, "tenants"), { recursive: true });
  writeFileSync(join(dir, "tenants", ".gitkeep"), "");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const repo = new GitopsRepo({ dir, branch: "main", push: false, author: { name: "platform-worker", email: "w@x" }, maxPushTries: 1 });
  return { dir, git, repo, seed: git("rev-parse", "HEAD"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// 시험 전용 sealed-secrets 컨트롤러 흉내 인증서 (replication-delivery.test.ts 와 같은 방법)
function sealingCert(): string {
  const d = mkdtempSync(join(tmpdir(), "gitops-contract-seal-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(d, "k.pem"), "-out", join(d, "c.pem"),
      "-days", "30", "-subj", "/CN=sealed-secret-test"], { stdio: "ignore" });
    return readFileSync(join(d, "c.pem"), "utf8");
  } finally { rmSync(d, { recursive: true, force: true }); }
}
const endpoint = (side: "source" | "target", migrationId: string): ReplicationEndpoint => ({
  tenantId: TENANT, migrationId, side, label: `${side}-db`, provider: side === "source" ? "rds" : "cnpg",
  host: side === "source" ? "shop.abc123.ap-northeast-2.rds.amazonaws.com" : "203.0.113.7", port: 5432, dbname: "shop",
  username: side === "source" ? "repl_admin" : "svc_migrate", passwordRef: side === "source" ? "env:REPL_SECRET_SRC_TEST" : "derive:migrate",
  peerHost: null, peerPort: null, appRole: "app_user", fenceRoles: [], schemaName: null, sslmode: "require", tlsServername: null, caPem: null,
  relayHost: side === "target" ? "203.0.113.7" : null,
  relayKnownHosts: side === "target" ? "203.0.113.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForRenderOnly" : null, relayPort: 22,
});

/** 이전 한 바퀴에서 worker 가 gitops 레포에 커밋하는 길을 전부 돈다. 돌린 단계 이름을 돌려준다 */
async function runWorkerWrites(repo: GitopsRepo): Promise<string[]> {
  const steps: string[] = [];
  const hub = process.env.ARGO_HUB_ROLE_ARN;
  // EKS 접속 정보는 허브를 켠 플랫폼에서만 그린다 (awsHubEnabled). 실플랫폼과 같게 켠다
  process.env.ARGO_HUB_ROLE_ARN = "arn:aws:iam::999988887777:role/platform-argocd-hub";
  try {
    const gcp = inputFor("gcp", 1), aws = inputFor("aws", 2), onprem = inputFor("onprem", 3), azure = inputFor("azure_mock", 4);
    // 1) 배포: 묶음 + 회사 울타리 + 클러스터 접속 정보 (GKE·EKS)
    await deployToGitops(repo, gcp, mockArgoWatcher); steps.push("deploy gcp-gke + cluster-gcp-gke");
    await deployToGitops(repo, aws, mockArgoWatcher); steps.push("deploy aws-eks + cluster-aws-eks");
    await deployToGitops(repo, azure, mockArgoWatcher); steps.push("deploy azure-mock");
    // 2) 온프레 도착: 환경별 폴더 + 바닥(할당량, onpremFloorViaGit) + CNPG 이전 배달물(봉인 비밀·서버 인증서·터널) + 트래픽 입구 터널 토큰
    let op = onprem;
    if (OPENSSL) {
      const cert = sealingCert();
      const d = await decideDelivery({ provider: "onprem", pullMode: true, values: filledValues(onprem), tenantId: TENANT,
        migrationId: onprem.plan.migrationId, records: [endpoint("source", onprem.plan.migrationId), endpoint("target", onprem.plan.migrationId)],
        stored: null, sealingCertPem: cert, masterKey: "test-master-key-not-a-secret-0123456789" });
      assert.equal(d.kind, "ok", JSON.stringify(d));
      const tunnel = sealedSecretValues(cert, `app-${ONE.app.name}`, TUNNEL_TOKEN_SECRET, { token: "test-tunnel-token" });
      op = { ...onprem, ...(d.kind === "ok" ? { replication: d.delivery } : {}), trafficEntry: { name: tunnel.name, encryptedData: tunnel.encryptedData } };
      steps.push("deploy onprem-k3s-<site> + replication delivery + traffic entry");
    } else steps.push("deploy onprem-k3s-<site> (openssl 없음: 배달물 빼고)");
    await deployToGitops(repo, op, mockArgoWatcher);
    // 3) 트래픽 단계와 되돌림 (shift·rollback 이 쓰는 커밋)
    for (const i of [gcp, aws, op]) {
      const b = bundleRefOf(i);
      const w = (await repo.readPlan(b)).approvedWeights;
      for (const pct of [...w.slice(0, 1), 0]) await commitTrafficWeight(repo, b, pct);
      steps.push(`traffic ${b.env} ${[...w.slice(0, 1), 0].join("→")}`);
    }
    // 4) 정리: 복제 배달물 걷기 → 롤백 뒤 온프레 도착 묶음 지우기 (target-destroy)
    const ob = bundleRefOf(op);
    const c = await commitReplicationCleanup(ob, repo);
    assert.equal(c.error, undefined, c.error);
    steps.push(`replication cleanup (${c.commit ? "커밋" : c.skipped})`);
    const r = await repo.removeBundle(ob, op.plan.migrationId, "rollback: remove target bundle");
    assert.ok(r.commit, JSON.stringify(r));
    steps.push("remove onprem bundle");
  } finally {
    if (hub === undefined) delete process.env.ARGO_HUB_ROLE_ARN; else process.env.ARGO_HUB_ROLE_ARN = hub;
  }
  return steps;
}

const committedPaths = (git: (...a: string[]) => string, seed: string) =>
  [...new Set(git("log", "--no-renames", "--name-only", "--format=", `${seed}..HEAD`).split("\n").filter(Boolean))].sort();
const gapOf = (p: string) => PATH_GUARD_KNOWN_GAPS.some((g) => p.endsWith(g));
const list = (xs: string[]) => xs.map((x) => `\n  ${x}`).join("");

test(`worker 가 이전 한 바퀴에서 커밋하는 경로가 전부 gitops 검사기 허용 목록 안 (${REAL ? "진짜 render·validate·path-guard" : "흉내 render/validate + 고정 거울"})`, async () => {
  const w = workCopy();
  try {
    const steps = await runWorkerWrites(w.repo);
    const paths = committedPaths(w.git, w.seed);
    console.log(`gitops 경로 계약: ${REAL ? "진짜 검사기" : "고정 거울"} / 단계 ${steps.length}개 / 커밋 경로 ${paths.length}개${list(steps)}`);
    assert.equal(w.git("status", "--porcelain", "--untracked-files=all"), "", "쓰고 커밋 안 한 파일이 남지 않는다");

    // 덮는 범위가 줄면 실패 (예: 허브 스위치가 꺼져 EKS 접속 정보를 안 그리면 이 시험이 아무것도 안 보게 된다)
    const want = [
      `tenants/${T}/argocd/appproject.yaml`,
      ...Object.keys(CLUSTER_ENVS).map((e) => `tenants/${T}/argocd/${clusterSecretFile(e as ClusterAccess["env"])}`),
      ...(Object.keys(ENV_DIR) as Provider[]).flatMap((p) => {
        const dir = bundlePath(bundleRefFor(TENANT, ONE.app.name, p, ENV_IDS[p]));
        return BUNDLE_REQUIRED.map((f) => `${dir}/${f}`);
      }),
    ];
    assert.deepEqual(want.filter((p) => !paths.includes(p)), [], "worker 쓰기 길이 이 경로를 그리지 않았다");
    for (const p of Object.keys(ENV_DIR) as Provider[]) {
      const dir = bundlePath(bundleRefFor(TENANT, ONE.app.name, p, ENV_IDS[p]));
      assert.ok(paths.some((x) => x.startsWith(`${dir}/manifests/`)), `${dir}/manifests/ 를 커밋하지 않았다`);
    }

    // 고정 거울: tools/validate.mjs (worker 커밋 길에서 돌아 실이전을 막는 검사기)
    const blocked = paths.flatMap((p) => { const why = validateRejects(p); return why ? [`${p} — ${why}`] : []; });
    assert.deepEqual(blocked, [], "gitops 레포 tools/validate.mjs 가 막을 경로를 worker 가 쓴다. gitops 레포 검사기를 먼저 고쳐 머지하고 " +
      `apps/worker/test/gitops-path-rules.ts 거울을 고친다:${list(blocked)}`);
    // 고정 거울: tools/path-guard.mjs BOT_ONLY. 알려진 빈틈(PATH_GUARD_KNOWN_GAPS)만 걸려야 한다 — 새로 걸리거나, 빈틈이 메워졌는데 목록이 남으면 실패
    assert.deepEqual(paths.filter((p) => !PATH_GUARD_BOT_ONLY.test(p)), paths.filter(gapOf),
      "gitops 레포 tools/path-guard.mjs(봇 경로) 거울과 다르다. 새 경로면 gitops 레포 path-guard.mjs 를 고치고 거울을 고친다");

    // 거부: PR #13 전 검사기 거울이었으면 오늘 멈춘 그 파일을 CI 에서 잡았다
    const before = paths.filter((p) => validateRejects(p, { ...PINNED, argocdFiles: ARGOCD_FILES_BEFORE_PR13 }) !== null);
    assert.deepEqual(before, [`tenants/${T}/argocd/cluster-aws-eks.yaml`]);
    assert.match(validateRejects(before[0]!, { ...PINNED, argocdFiles: ARGOCD_FILES_BEFORE_PR13 })!, /이 폴더에 둘 수 없는 파일이다/);

    if (REAL) {
      // 진짜 path-guard: 같은 경로 목록을 넣는다 (gitops 레포 BOT-PERMISSIONS.md 의 사용법 그대로)
      const g = spawnSync("node", ["tools/path-guard.mjs", "bot"], { cwd: w.dir, input: paths.join("\n") + "\n", encoding: "utf8" });
      const fails = [...g.stdout.matchAll(/^FAIL {2}\S+ 쓸 수 없는 경로: (\S+)$/gm)].map((m) => m[1]!).sort();
      assert.deepEqual(fails, paths.filter(gapOf), `진짜 path-guard 결과가 거울 + 알려진 빈틈과 다르다 (gitops-path-rules.ts 를 고친다):\n${g.stdout}`);
      // 진짜 validate 거부: worker 가 안 쓰는 접속 정보 파일을 울타리 폴더에 두면 거울과 같이 막는다 (오늘 멈춘 것과 같은 문구)
      const extra = `tenants/${T}/argocd/cluster-azure-mock.yaml`;
      assert.notEqual(validateRejects(extra), null);
      cpSync(join(w.dir, "tenants", T, "argocd", "cluster-gcp-gke.yaml"), join(w.dir, extra));
      const v = spawnSync("node", ["tools/validate.mjs"], { cwd: w.dir, encoding: "utf8" });
      assert.equal(v.status, 1, v.stdout);
      assert.match(v.stdout, new RegExp(`FAIL {2}${extra}: 이 폴더에 둘 수 없는 파일이다`));
    }
  } finally { w.done(); }
});

test("경로 도우미: 모든 도착 환경의 묶음 폴더(새 폴더·예전 온프레 공용 폴더)와 클러스터 접속 정보 파일 이름이 거울 허용 목록 안", () => {
  // 출발 온프레 묶음(sourceReplicationStep)·예전 공용 폴더(GitopsRepo.resolve)는 위 한 바퀴가 새로 만들지 않는 자리라 도우미로 본다
  const dirs = (Object.keys(ENV_DIR) as Provider[]).flatMap((p) => {
    const b = bundleRefFor(TENANT, ONE.app.name, p, ENV_IDS[p]);
    return [bundlePath(b), bundlePath(legacyRef(b))];
  });
  const paths = [...new Set(dirs)].flatMap((d) => [...BUNDLE_REQUIRED.map((f) => `${d}/${f}`), `${d}/manifests/deployment-${ONE.app.name}.yaml`]);
  assert.deepEqual(paths.filter((p) => validateRejects(p) !== null || !PATH_GUARD_BOT_ONLY.test(p)), []);
  assert.deepEqual(Object.keys(DELIVERY).filter((e) => !PINNED.envDirs.includes(e)), [], "worker 환경 표(DELIVERY)에 검사기가 모르는 환경이 있다");
  for (const e of Object.keys(CLUSTER_ENVS) as Array<ClusterAccess["env"]>) assert.ok(ARGOCD_FILES.includes(clusterSecretFile(e)), clusterSecretFile(e));
});

test("거울 거부: 울타리 폴더의 다른 파일, 모르는 환경 폴더, 회사 폴더 밖은 막는다", () => {
  assert.match(validateRejects(`tenants/${T}/argocd/extra.yaml`)!, /둘 수 없는 파일/);
  assert.match(validateRejects(`tenants/${T}/argocd/cluster-azure-mock.yaml`)!, /둘 수 없는 파일/);
  assert.match(validateRejects(`tenants/${T}/apps/shop/onprem-k3s-zz/values.yaml`)!, /모르는 환경 이름/);
  assert.match(validateRejects(`tenants/${T}/apps/shop/aws-ecs/values.yaml`)!, /모르는 환경 이름/);
  assert.notEqual(validateRejects("charts/app/values.yaml"), null);
  assert.notEqual(validateRejects(`tenants/${T}/notes.md`), null);
  assert.equal(PATH_GUARD_BOT_ONLY.test(`tenants/${T}/argocd/extra.yaml`), false);
});

test("진짜 검사기 길을 요구했으면 준비돼 있어야 한다 (CI gitops 작업이 거울로 조용히 내려가지 않게)", { skip: process.env.GITOPS_CONTRACT_REQUIRE_REAL !== "1" && "GITOPS_CONTRACT_REQUIRE_REAL=1 일 때만" }, () => {
  assert.ok(REAL, "GITOPS_FIXTURE_DIR(tools/validate.mjs·path-guard.mjs·node_modules) 와 helm 이 있어야 한다");
});
