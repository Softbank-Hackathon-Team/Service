// 배포 이미지 복사: 사설 이미지를 렌더 값이 가리키는 도착 레지스트리 자리로 다이제스트 그대로 복사 (AWS ECR ↔ GCP Artifact Registry).
// aws·gcloud·crane 은 가짜 exec (레지스트리 상태를 Map 으로 흉내), 자격 대여는 가짜 withRoles. 실제 클라우드·레지스트리 호출 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isKnownFailureCode } from "@svc/core";
import type { Exec } from "@svc/adapters";
import { approvedValues, envFacts, fillPlaceholders, type DeployInput } from "../src/gitops/index.js";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { copyImages, imageCopiesOf, imageCopyStep, IMAGE_COPY_BUDGET_MS, type ImageCopy } from "../src/jobs/image-copy.js";
import type { StepRoles, withStepRoles } from "../src/jobs/_roles.js";
import { ONE, withApi } from "./demo-one.js";

const T = "9f8e7d6c-0000-4000-8000-000000000001";
const j = { tenantId: T, migrationId: "4a8c0000-0000-4000-8000-000000000001" };
const m = { id: j.migrationId, status: "deploying" as const, sourceEnvId: "src", targetEnvId: "dst" };
const D1 = `sha256:${"a".repeat(64)}`, D2 = `sha256:${"b".repeat(64)}`, D3 = `sha256:${"c".repeat(64)}`;
const SRC_ECR = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const DST_ECR = "444455556666.dkr.ecr.ap-northeast-2.amazonaws.com";
const SRC_AR = "asia-northeast3-docker.pkg.dev";
const DST_AR = "asia-northeast3-docker.pkg.dev";
const BORROWED_SRC = { AWS_CONFIG_FILE: "/tmp/svc-aws-src/config", AWS_SHARED_CREDENTIALS_FILE: "/tmp/svc-aws-src/credentials", AWS_REGION: "us-west-2" };
const BORROWED_DST = { AWS_CONFIG_FILE: "/tmp/svc-aws-dst/config", AWS_SHARED_CREDENTIALS_FILE: "/tmp/svc-aws-dst/credentials", AWS_REGION: "ap-northeast-2" };
const WORKER = { PATH: "/bin", HOME: "/home/node", AWS_ACCESS_KEY_ID: "AKIAWORKER", AWS_PROFILE: "worker",
  AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials", AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token" };
const REAL = { ...WORKER, REAL_STS: "1" }, LOCAL = { ...WORKER, REAL_STS: "0" };

interface Call { cmd: string; args: string[]; env: NodeJS.ProcessEnv; auths: Record<string, string> | null }
const authOf = (b: string) => Buffer.from(b, "base64").toString();
function fakes(o: { present?: Record<string, string>; roles?: Partial<StepRoles>; copyFails?: boolean; wrongDigest?: boolean; repoFails?: string } = {}) {
  const store = new Map(Object.entries(o.present ?? {}));
  const calls: Call[] = [];
  const steps: string[] = [];
  const exec: Exec = async (cmd, args, x) => {
    const cfg = x.env.DOCKER_CONFIG ? join(x.env.DOCKER_CONFIG, "config.json") : null;
    const auths = cfg && existsSync(cfg)
      ? Object.fromEntries(Object.entries((JSON.parse(readFileSync(cfg, "utf8")) as { auths: Record<string, { auth: string }> }).auths).map(([h, a]) => [h, authOf(a.auth)]))
      : null;
    calls.push({ cmd, args, env: x.env, auths });
    const r = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr, ms: 1 });
    if (cmd === "aws" && args[1] === "get-login-password") return r(0, `pw-${args[3]}-${x.env.AWS_CONFIG_FILE ?? "process"}\n`);
    if (cmd === "aws" && args[1] === "create-repository") return o.repoFails ? r(254, "", o.repoFails) : r(0, "{}");
    if (cmd === "gcloud") return r(0, "gtok-process\n");
    if (args[0] === "digest") return store.has(args[1]!) ? r(0, `${store.get(args[1]!)}\n`) : r(1, "", "MANIFEST_UNKNOWN");
    if (args[0] === "copy") {
      if (o.copyFails) return r(1, "", "DENIED: Permission \"artifactregistry.repositories.uploadArtifacts\" denied");
      store.set(args[2]!, o.wrongDigest ? D3 : args[1]!.split("@")[1]!);
      return r(0);
    }
    throw new Error(`예상 밖 명령 ${cmd} ${args.join(" ")}`);
  };
  const withRoles = (async (step: string, _j: unknown, _m: unknown, fn: (r: StepRoles) => Promise<unknown>) => {
    steps.push(step);
    return fn({ creds: [], skipped: [], denied: [], ...o.roles });
  }) as typeof withStepRoles;
  return { exec, withRoles, calls, steps, store };
}
const deps = (f: ReturnType<typeof fakes>, env: NodeJS.ProcessEnv = REAL) => ({ exec: f.exec, withRoles: f.withRoles, env });
const cmds = (f: ReturnType<typeof fakes>) => f.calls.map((c) => `${c.cmd} ${c.args[0] === "ecr" || c.args[0] === "auth" ? c.args[1] : c.args[0]}`);

const awsToGcp: ImageCopy = { ref: `${DST_AR}/cust-mig/platform/t-9f8e7d6c/api@${D1}`, source: `${SRC_ECR}/shop/api:1.4@${D1}`, digest: D1 };
const gcpToAws: ImageCopy = { ref: `${DST_ECR}/platform/t-9f8e7d6c/api@${D2}`, source: `${SRC_AR}/cust-prj/apps/api@${D2}`, digest: D2 };

test("AWS → GCP: 출발 ECR 을 출발 관찰 자격으로 받아 도착 AR 에 다이제스트 그대로 올리고, 다시 읽어 확인", async () => {
  const f = fakes({ roles: { awsEnv: { source: BORROWED_SRC }, gcpToken: { target: "gtok-target" } } });
  const out = await copyImages(j, m, [awsToGcp], deps(f));
  assert.deepEqual(out, { ok: true, copied: [awsToGcp.ref], present: [] });
  assert.deepEqual(f.steps, ["image_copy"]);
  assert.deepEqual(cmds(f), ["crane digest", "aws get-login-password", "crane copy", "crane digest"], "AR 은 저장소를 만들지 않는다 (gcp/env 의 platform)");
  const copy = f.calls.find((c) => c.args[0] === "copy")!;
  assert.deepEqual(copy.args, ["copy", `${SRC_ECR}/shop/api@${D1}`, awsToGcp.ref], "태그는 버리고 다이제스트로만");
  assert.deepEqual(copy.auths, { [DST_AR]: "oauth2accesstoken:gtok-target", [SRC_ECR]: "AWS:pw-us-west-2-/tmp/svc-aws-src/config" });
  const login = f.calls.find((c) => c.args[1] === "get-login-password")!;
  assert.equal(login.env.AWS_CONFIG_FILE, BORROWED_SRC.AWS_CONFIG_FILE);
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_PROFILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_WEB_IDENTITY_TOKEN_FILE"]) assert.equal(login.env[k], undefined, `워커 자기 자격 ${k}`);
  for (const c of f.calls.filter((x) => x.cmd === "crane")) assert.equal(Object.keys(c.env).filter((k) => k.startsWith("AWS_")).length, 0, "crane 에 클라우드 자격 없음");
  assert.equal(f.store.get(awsToGcp.ref), D1);
});

test("GCP → AWS: 출발 AR 을 출발 관찰 토큰으로 받아 도착 ECR 이미지별 저장소(태그 managed-by)를 만들고 올림", async () => {
  const f = fakes({ roles: { gcpToken: { source: "gtok-source" }, awsEnv: { target: BORROWED_DST } } });
  const out = await copyImages(j, m, [gcpToAws], deps(f));
  assert.deepEqual(out, { ok: true, copied: [gcpToAws.ref], present: [] });
  assert.deepEqual(cmds(f), ["aws get-login-password", "crane digest", "aws create-repository", "crane copy", "crane digest"]);
  const repo = f.calls.find((c) => c.args[1] === "create-repository")!;
  assert.equal(repo.args[repo.args.indexOf("--repository-name") + 1], "platform/t-9f8e7d6c/api");
  assert.equal(repo.args[repo.args.indexOf("--region") + 1], "ap-northeast-2");
  assert.ok(repo.args.includes("IMMUTABLE") && repo.args.includes("scanOnPush=true") && repo.args.includes("Key=managed-by,Value=platform"));
  assert.equal(repo.env.AWS_CONFIG_FILE, BORROWED_DST.AWS_CONFIG_FILE, "저장소는 도착 실행 자격으로");
  const copy = f.calls.find((c) => c.args[0] === "copy")!;
  assert.deepEqual(copy.auths, { [DST_ECR]: "AWS:pw-ap-northeast-2-/tmp/svc-aws-dst/config", [SRC_AR]: "oauth2accesstoken:gtok-source" });
});

test("멱등: 도착에 같은 다이제스트가 이미 있으면 출발 자격·저장소 만들기·복사 없이 present", async () => {
  const f = fakes({ present: { [gcpToAws.ref]: D2 }, roles: { awsEnv: { target: BORROWED_DST } } });
  const out = await copyImages(j, m, [gcpToAws], deps(f));
  assert.deepEqual(out, { ok: true, copied: [], present: [gcpToAws.ref] });
  assert.deepEqual(cmds(f), ["aws get-login-password", "crane digest"]);
  const again = await copyImages(j, m, [awsToGcp], deps(fakes({ present: { [awsToGcp.ref]: D1 }, roles: { gcpToken: { target: "t" } } })));
  assert.deepEqual(again, { ok: true, copied: [], present: [awsToGcp.ref] });
});

test("도착에 다른 다이제스트가 있거나 복사 뒤 다시 읽은 다이제스트가 다르면 digest_mismatch", async () => {
  const f = fakes({ roles: { awsEnv: { source: BORROWED_SRC }, gcpToken: { target: "t" } }, wrongDigest: true });
  const out = await copyImages(j, m, [awsToGcp], deps(f));
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.reason, "digest_mismatch");
  assert.equal(!out.ok && out.image, awsToGcp.ref);
});

test("배포 단계: 복사 실패는 커밋 전 paused(IMAGE_COPY_FAILED), 감사 detail 에 이유·이미지. 코드는 실패 코드 목록에 있다", async () => {
  const f = fakes({ roles: { awsEnv: { source: BORROWED_SRC }, gcpToken: { target: "t" } }, copyFails: true });
  const out = await imageCopyStep(j, m, inputFor("gcp", ecrSpec), deps(f));
  assert.ok("outcome" in out);
  assert.equal(out.outcome.to, "paused");
  assert.equal(out.outcome.failureCode, "IMAGE_COPY_FAILED");
  const d = (out.outcome.detail as { deploy: { error: string; step: string; image: string; reason: string } }).deploy;
  assert.equal(d.error, "IMAGE_COPY_FAILED");
  assert.equal(d.step, "copy_failed");
  assert.equal(d.image, awsToGcp.ref);
  assert.match(d.reason, /uploadArtifacts/);
  assert.ok(isKnownFailureCode("IMAGE_COPY_FAILED"));
});

test("배포 단계 정상: 복사한 주소가 감사 detail 로, 다시 돌면 present 로 (재개해도 같은 끝)", async () => {
  const f = fakes({ roles: { awsEnv: { source: BORROWED_SRC }, gcpToken: { target: "t" } } });
  const refs = [awsToGcp.ref, `${DST_AR}/cust-mig/platform/t-9f8e7d6c/proxy@${D2}`];
  const first = await imageCopyStep(j, m, inputFor("gcp", ecrSpec), deps(f));
  assert.deepEqual(first, { detail: { copied: refs, present: [] } });
  const second = await imageCopyStep(j, m, inputFor("gcp", ecrSpec), deps(f));
  assert.deepEqual(second, { detail: { copied: [], present: refs } });
  assert.equal(f.calls.filter((c) => c.args[0] === "copy").length, 2, "두 번째는 복사하지 않음");
});

test("거부: 실환경(REAL_STS)에서 그 쪽 자격을 못 빌렸으면 워커 자기 자격으로 토큰을 받지 않고 no_credentials", async () => {
  const noSource = fakes({ roles: { gcpToken: { target: "t" } } });
  const a = await copyImages(j, m, [awsToGcp], deps(noSource));
  assert.equal(!a.ok && a.reason, "no_credentials");
  assert.ok(!noSource.calls.some((c) => c.cmd === "aws" || c.cmd === "gcloud"), "aws·gcloud 를 워커 자격으로 부르지 않음");
  const noTarget = fakes({ roles: { gcpToken: { source: "s" } } });
  const b = await copyImages(j, m, [gcpToAws], deps(noTarget));
  assert.equal(!b.ok && b.reason, "no_credentials");
  assert.equal(noTarget.calls.length, 0);
});

test("로컬·시험(REAL_STS=0)은 흉내 발급기라 프로세스 자격으로 토큰을 받는다", async () => {
  const f = fakes();
  const out = await copyImages(j, m, [awsToGcp], deps(f, LOCAL));
  assert.equal(out.ok, true);
  const copy = f.calls.find((c) => c.args[0] === "copy")!;
  assert.deepEqual(copy.auths, { [DST_AR]: "oauth2accesstoken:gtok-process", [SRC_ECR]: "AWS:pw-us-west-2-process" });
});

test("거부: 출발 관찰 역할이 거부되면 role_denied (발급기가 던져도, 거부 목록에 있어도)", async () => {
  const f = fakes({ roles: { gcpToken: { target: "t" }, denied: [{ side: "source", purpose: "observe", code: "ROLE_NO_EXTERNAL_ID" }] } });
  const out = await copyImages(j, m, [awsToGcp], deps(f));
  assert.equal(!out.ok && out.reason, "role_denied");
  assert.match(!out.ok ? out.message : "", /ROLE_NO_EXTERNAL_ID/);
  const { TempRoleDenied } = await import("@svc/security");
  const thrown = await copyImages(j, m, [awsToGcp], { exec: f.exec, env: REAL,
    withRoles: (async () => { throw new TempRoleDenied("ROLE_OBSERVE_WRITE", "x"); }) as typeof withStepRoles });
  assert.equal(!thrown.ok && thrown.reason, "role_denied");
});

test("거부: 같은 레지스트리 호스트에 출발·도착 자격이 다르면(같은 리전 AR → AR) 복사하지 않고 same_registry_host", async () => {
  const f = fakes({ roles: { gcpToken: { source: "s", target: "t" } } });
  const c: ImageCopy = { ref: `${DST_AR}/cust-mig/platform/t-9f8e7d6c/api@${D1}`, source: `${SRC_AR}/cust-prj/apps/api@${D1}`, digest: D1 };
  const out = await copyImages(j, m, [c], deps(f));
  assert.equal(!out.ok && out.reason, "same_registry_host");
  assert.ok(!f.calls.some((x) => x.args[0] === "copy"));
});

test("거부: 다이제스트로 안 고정됐거나, ECR·AR 이 아닌 사설 호스트면 자격 대여·명령 없이 멈춘다", async () => {
  for (const [c, reason] of [
    [{ ref: awsToGcp.ref, source: `${SRC_ECR}/shop/api:1.4`, digest: D1 }, "not_by_digest"],
    [{ ref: awsToGcp.ref.replace(D1, D2), source: awsToGcp.source, digest: D1 }, "not_by_digest"],
    [{ ref: awsToGcp.ref, source: `registry.corp.example/shop/api@${D1}`, digest: D1 }, "unsupported_registry"],
  ] as const) {
    const f = fakes();
    const out = await copyImages(j, m, [c], deps(f));
    assert.equal(!out.ok && out.reason, reason);
    assert.equal(f.calls.length + f.steps.length, 0);
  }
});

test("예산: 남은 시간이 없으면 다음 명령을 시작하지 않고 budget_exceeded", async () => {
  let t = 0;
  const f = fakes({ roles: { awsEnv: { source: BORROWED_SRC }, gcpToken: { target: "t" } } });
  const exec: Exec = async (cmd, args, x) => { t += IMAGE_COPY_BUDGET_MS; return f.exec(cmd, args, x); };
  const out = await copyImages(j, m, [awsToGcp], { ...deps(f), exec, now: () => t });
  assert.equal(!out.ok && out.reason, "budget_exceeded");
});

test("ECR 저장소 만들기: 이미 있으면 그대로 진행, 권한 거부면 repo_failed", async () => {
  const exists = await copyImages(j, m, [gcpToAws], deps(fakes({ roles: { gcpToken: { source: "s" }, awsEnv: { target: BORROWED_DST } },
    repoFails: "An error occurred (RepositoryAlreadyExistsException)" })));
  assert.equal(exists.ok, true);
  const denied = await copyImages(j, m, [gcpToAws], deps(fakes({ roles: { gcpToken: { source: "s" }, awsEnv: { target: BORROWED_DST } },
    repoFails: "An error occurred (AccessDeniedException) when calling the CreateRepository operation" })));
  assert.equal(!denied.ok && denied.reason, "repo_failed");
});

// 렌더 값과 복사 목록이 같은 주소를 본다 (어댑터 imageRef + 자리표시 채움)
const ecrSpec = withApi(ONE, { image: { source: "registry", repository: `${SRC_ECR}/shop/api`, digest: D1 },
  sidecars: [{ name: "proxy", image: { source: "registry", repository: `${SRC_ECR}/shop/proxy`, digest: D2 }, env: [], resources: {} },
    { name: "log", image: { source: "registry", repository: "docker.io/fluent/fluent-bit", digest: D3 }, env: [], resources: {} }] });
const arSpec = withApi(ONE, { image: { source: "registry", repository: `${SRC_AR}/cust-prj/apps/api`, digest: D2 } });
function inputFor(provider: "aws" | "gcp" | "onprem", spec = ecrSpec): DeployInput {
  const target = { envId: "33333333-3333-4333-8333-333333333333", provider, region: "default" };
  const plan = buildPlanDoc({ planId: "7f000000-0000-4000-8000-000000000001", migrationId: j.migrationId, spec, target, precheck: stubPrecheck(), now: new Date() });
  return { tenantId: T, spec, plan, target: { ...target, accountId: provider === "gcp" ? "cust-mig" : provider === "aws" ? "444455556666" : null }, tfOutputs: {} };
}
const renderedImages = (i: DeployInput) => {
  const v = fillPlaceholders(approvedValues(i), { tf: {}, env: envFacts(i) }).values as { workloads: Array<{ image: string; sidecars?: Array<{ image: string }> }> };
  return v.workloads.flatMap((w) => [w.image, ...(w.sidecars ?? []).map((s) => s.image)]);
};

test("렌더: AWS → GCP 도착 Helm 값은 사설 이미지를 도착 AR 플랫폼 자리(다이제스트 그대로)로, 공개 이미지는 원본 그대로 가리키고, 복사 목록이 그 자리와 같다", () => {
  const i = inputFor("gcp");
  const images = renderedImages(i);
  assert.ok(images.includes(`${DST_AR}/cust-mig/platform/t-9f8e7d6c/api@${D1}`), images.join());
  assert.ok(images.includes(`${DST_AR}/cust-mig/platform/t-9f8e7d6c/proxy@${D2}`), images.join());
  assert.ok(images.includes(`docker.io/fluent/fluent-bit@${D3}`), images.join());
  assert.deepEqual(imageCopiesOf(i), [
    { ref: `${DST_AR}/cust-mig/platform/t-9f8e7d6c/api@${D1}`, source: `${SRC_ECR}/shop/api@${D1}`, digest: D1 },
    { ref: `${DST_AR}/cust-mig/platform/t-9f8e7d6c/proxy@${D2}`, source: `${SRC_ECR}/shop/proxy@${D2}`, digest: D2 },
  ]);
  assert.deepEqual(imageCopiesOf(i).map((c) => c.ref).filter((r) => !images.includes(r)), [], "복사하는 자리는 모두 렌더 값에 있다");
});

test("렌더: GCP → AWS 도착 Helm 값은 사설 AR 이미지를 도착 ECR 플랫폼 자리로 가리키고, 복사 목록이 그 자리와 같다", () => {
  const i = inputFor("aws", arSpec);
  const ref = `${DST_ECR}/platform/t-9f8e7d6c/api@${D2}`;
  assert.ok(renderedImages(i).includes(ref), renderedImages(i).join());
  assert.deepEqual(imageCopiesOf(i), [{ ref, source: `${SRC_AR}/cust-prj/apps/api@${D2}`, digest: D2 }]);
});

test("건너뜀: 온프레·Azure 도착은 이 단계 밖, 흉내 IaC(MOCK_IAC=1, 꽂은 가짜 없음)는 도착 레지스트리가 없다 — 둘 다 감사 detail 에 이유", async () => {
  assert.deepEqual(await imageCopyStep(j, m, inputFor("onprem"), undefined), { detail: { skipped: "target_not_cloud" } });
  const was = process.env.MOCK_IAC;
  process.env.MOCK_IAC = "1";
  try { assert.deepEqual(await imageCopyStep(j, m, inputFor("gcp"), undefined), { detail: { skipped: "mock_iac" } }); }
  finally { if (was === undefined) delete process.env.MOCK_IAC; else process.env.MOCK_IAC = was; }
});

test("공개 이미지만 있으면 자격을 빌리지 않는다", async () => {
  const f = fakes();
  assert.deepEqual(await imageCopyStep(j, m, inputFor("gcp", ONE), deps(f)), { detail: { copied: [], present: [] } });
  assert.equal(f.steps.length + f.calls.length, 0);
});

test("멈춤 detail: 자격·권한·도구가 모자란 이유면 deploy 칸에 missing(정확한 이름)·hint(고칠 자리), 그 밖의 실패엔 없다", async () => {
  const stop = async (f: ReturnType<typeof fakes>, d = deps(f), input = inputFor("gcp", ecrSpec)) => {
    const out = await imageCopyStep(j, m, input, d);
    assert.ok("outcome" in out);
    return (out.outcome.detail as { deploy: { step: string; reason: string; missing?: string[]; hint?: string } }).deploy;
  };
  // 실환경에서 출발 AWS 자격을 못 빌림 → 출발 관찰 역할 + 연결 링크 안내
  const noCred = await stop(fakes({ roles: { gcpToken: { target: "t" } } }));
  assert.equal(noCred.step, "no_credentials");
  assert.deepEqual(noCred.missing, ["aws: svc-observe"]);
  assert.match(noCred.hint!, /CloudFormation 연결 스택/);
  // 발급기가 거부를 던짐 (어느 쪽인지 모름) → 이 복사에 필요한 두 쪽 권한을 모두
  const { TempRoleDenied } = await import("@svc/security");
  const f = fakes();
  const denied = await stop(f, { exec: f.exec, env: REAL, withRoles: (async () => { throw new TempRoleDenied("ROLE_OUTSIDE_CEILING", "x"); }) as typeof withStepRoles });
  assert.equal(denied.step, "role_denied");
  assert.deepEqual(denied.missing, ["aws: ecr:BatchGetImage", "aws: ecr:GetAuthorizationToken", "aws: ecr:GetDownloadUrlForLayer",
    "gcp: artifactregistry.repositories.uploadArtifacts"]);
  assert.match(denied.hint!, /PERMISSIONS_DIR/);
  assert.match(denied.hint!, /svc-connect/);
  assert.match(denied.hint!, /infra\/onboarding\/gcp-connect\.sh/);
  // 워커 이미지에 crane 이 없음
  const g = fakes({ roles: { awsEnv: { source: BORROWED_SRC }, gcpToken: { target: "t" } } });
  const noCrane: Exec = async (cmd, args, x) => (cmd === "crane" ? { code: 127, stdout: "", stderr: "crane: not found", ms: 1 } : g.exec(cmd, args, x));
  const tool = await stop(g, { ...deps(g), exec: noCrane });
  assert.equal(tool.step, "tool_missing");
  assert.deepEqual(tool.missing, ["crane"]);
  assert.match(tool.hint!, /Dockerfile/);
  // 같은 레지스트리 호스트: 운영자가 할 일만 (빠진 설정은 없음)
  const same = await stop(fakes({ roles: { gcpToken: { source: "s", target: "t" } } }), undefined, inputFor("gcp", arSpec));
  assert.equal(same.step, "same_registry_host");
  assert.equal(same.missing, undefined);
  assert.match(same.hint!, /crane copy/);
  // 복사 실패는 설정 문제로 단정하지 않는다 (reason 그대로)
  const copy = await stop(fakes({ roles: { awsEnv: { source: BORROWED_SRC }, gcpToken: { target: "t" } }, copyFails: true }));
  assert.equal(copy.step, "copy_failed");
  assert.equal(copy.missing, undefined);
  assert.equal(copy.hint, undefined);
});
