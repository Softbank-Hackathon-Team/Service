// 리허설 이미지 복사: 다이제스트 그대로 복사, 태그 거부, 흉내 건너뜀, 출발 자격은 출발 토큰 자식 프로세스에만, 실패 → 닫힌 사유
// aws·crane 은 가짜 exec (레지스트리 상태를 Map 으로 흉내). 실제 클라우드·레지스트리 호출 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QUEUES } from "@svc/contracts";
import { policyOf } from "@svc/core";
import type { Exec } from "@svc/adapters";
import { ECR_PULL_ACTIONS, STEP_ROLES, TempRoleDenied, checkLeastPrivilege } from "@svc/security";
import { MIRROR_BUDGET_MS, mirrorImages, type MirrorImage } from "../src/rehearsal/image-mirror.js";
import type { StepRoles, withStepRoles } from "../src/jobs/_roles.js";

const T = "11111111-2222-4333-8444-555555555555";
const j = { tenantId: T, migrationId: "66666666-7777-4888-8999-000000000000" };
const m = { id: j.migrationId, status: "deploying" as const, sourceEnvId: "src", targetEnvId: "dst" };
const D1 = `sha256:${"a".repeat(64)}`, D2 = `sha256:${"b".repeat(64)}`, D3 = `sha256:${"c".repeat(64)}`;
const PLATFORM = "999999999999.dkr.ecr.ap-northeast-2.amazonaws.com";
const CUSTOMER = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const ENV = { SANDBOX_IMAGE_REGISTRY: `${PLATFORM}/sandbox`, PATH: "/bin", HOME: "/home/node",
  AWS_ACCESS_KEY_ID: "AKIAWORKER", AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials" };
const BORROWED = { AWS_CONFIG_FILE: "/tmp/svc-aws-x/config", AWS_SHARED_CREDENTIALS_FILE: "/tmp/svc-aws-x/credentials", AWS_REGION: "us-west-2" };

interface Call { cmd: string; args: string[]; env: NodeJS.ProcessEnv; inScope: boolean; dockerConfig: string | null }
function fakes(o: { present?: Record<string, string>; fail?: Partial<Record<"token" | "copy" | "crane", number>>; wrongDigest?: boolean;
  denied?: boolean; borrowed?: boolean } = {}) {
  const store = new Map(Object.entries(o.present ?? {}));
  const calls: Call[] = [];
  const scope = { inScope: false, steps: [] as string[], released: 0 };
  const exec: Exec = async (cmd, args, x) => {
    const cfg = x.env.DOCKER_CONFIG ? join(x.env.DOCKER_CONFIG, "config.json") : null;
    calls.push({ cmd, args, env: x.env, inScope: scope.inScope, dockerConfig: cfg && existsSync(cfg) ? readFileSync(cfg, "utf8") : null });
    const r = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr, ms: 1 });
    if (cmd === "aws" && args[1] === "get-login-password") return o.fail?.token ? r(o.fail.token, "", "An error occurred (AccessDeniedException)") : r(0, `tok-${args[3]}\n`);
    if (cmd === "aws" && args[1] === "create-repository") return r(0, "{}");
    if (o.fail?.crane) return r(o.fail.crane, "", "crane: not found");
    if (args[0] === "digest") return store.has(args[1]!) ? r(0, `${store.get(args[1]!)}\n`) : r(1, "", "MANIFEST_UNKNOWN");
    if (args[0] === "copy") {
      if (o.fail?.copy) return r(o.fail.copy, "", "UNAUTHORIZED: authentication required");
      store.set(args[2]!, o.wrongDigest ? D3 : args[1]!.split("@")[1]!);
      return r(0);
    }
    throw new Error(`예상 밖 명령 ${cmd} ${args.join(" ")}`);
  };
  const withRoles = (async (step: string, _j: unknown, _m: unknown, fn: (r: StepRoles) => Promise<unknown>) => {
    scope.steps.push(step);
    scope.inScope = true;
    try {
      return await fn({ creds: [], skipped: [], denied: o.denied ? [{ side: "source", purpose: "observe", code: "ROLE_NO_ISSUER" }] : [],
        ...(o.borrowed === false ? {} : { awsEnv: { source: BORROWED } }) });
    } finally { scope.inScope = false; scope.released++; }
  }) as typeof withStepRoles;
  return { exec, withRoles, calls, scope, store };
}
const run = (images: MirrorImage[], f: ReturnType<typeof fakes>, env: NodeJS.ProcessEnv = ENV) =>
  mirrorImages(j, m, images, { exec: f.exec, withRoles: f.withRoles, env });

test("정상: 공개·고객 ECR 이미지를 다이제스트 그대로 회사 자리로 복사, 플랫폼에 이미 있는 이미지는 그 주소 그대로", async () => {
  const f = fakes();
  const images = [
    { ref: `docker.io/library/nginx@${D1}`, source: `docker.io/library/nginx:1.27@${D1}` },
    { ref: `<env:registryHost>/platform/${T}/api@${D2}`, source: `${CUSTOMER}/shop/api@${D2}` },
    { ref: `${PLATFORM}/platform/${T}/web@${D3}`, source: `${PLATFORM}/platform/${T}/web@${D3}` },
  ];
  const out = await run(images, f);
  assert.deepEqual(out, { ok: true, images: [
    { ref: images[0]!.ref, sandboxRef: `${PLATFORM}/sandbox/${T}/nginx@${D1}` },
    { ref: images[1]!.ref, sandboxRef: `${PLATFORM}/sandbox/${T}/api@${D2}` },
    { ref: images[2]!.ref, sandboxRef: `${PLATFORM}/platform/${T}/web@${D3}` },
  ] });
  const copies = f.calls.filter((c) => c.args[0] === "copy").map((c) => c.args.slice(1));
  assert.deepEqual(copies, [[`docker.io/library/nginx@${D1}`, `${PLATFORM}/sandbox/${T}/nginx@${D1}`], [`${CUSTOMER}/shop/api@${D2}`, `${PLATFORM}/sandbox/${T}/api@${D2}`]],
    "태그 없이 다이제스트로만 받고, 플랫폼 이미지는 복사 안 함");
  assert.equal(f.store.get(`${PLATFORM}/sandbox/${T}/api@${D2}`), D2);
  const repos = f.calls.filter((c) => c.args[1] === "create-repository").map((c) => c.args);
  assert.deepEqual(repos.map((a) => a[a.indexOf("--repository-name") + 1]), [`sandbox/${T}/nginx`, `sandbox/${T}/api`]);
  assert.ok(repos.every((a) => a.includes("IMMUTABLE") && a.includes("scanOnPush=true")));
});

test("이미 같은 다이제스트가 있으면 저장소 만들기·복사 안 함", async () => {
  const f = fakes({ present: { [`${PLATFORM}/sandbox/${T}/nginx@${D1}`]: D1 } });
  const out = await run([{ ref: `nginx@${D1}`, source: `nginx@${D1}` }], f);
  assert.equal(out.ok, true);
  assert.deepEqual(f.calls.map((c) => `${c.cmd} ${c.args[0] === "ecr" ? c.args[1] : c.args[0]}`), ["aws get-login-password", "crane digest"]);
});

test("거부: 태그만 있는 주소, 다이제스트가 다른 짝은 아무것도 부르지 않고 not_by_digest", async () => {
  for (const i of [
    { ref: `nginx@${D1}`, source: "docker.io/library/nginx:1.27" },
    { ref: "nginx:1.27", source: `nginx@${D1}` },
    { ref: `nginx@${D2}`, source: `nginx@${D1}` },
  ]) {
    const f = fakes();
    const out = await run([i], f);
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.reason, "not_by_digest");
    assert.equal(!out.ok && out.code, "REHEARSAL_IMAGE_MIRROR_FAILED");
    assert.equal(f.calls.length + f.scope.steps.length, 0, "명령·자격 대여 0");
  }
});

test("MOCK_SANDBOX=1 이면 복사·자격 대여 없이 빈 표 (레지스트리 설정이 없어도)", async () => {
  const f = fakes();
  const out = await run([{ ref: `${CUSTOMER}/api@${D1}`, source: `${CUSTOMER}/api@${D1}` }], f, { MOCK_SANDBOX: "1" });
  assert.deepEqual(out, { ok: true, images: [], skipped: "mock" });
  assert.equal(f.calls.length + f.scope.steps.length, 0);
});

test("자격 범위: 출발 ECR 이 있을 때만 image_mirror 역할을 빌리고, 빌린 자격은 출발 토큰 명령에만, 일은 전부 돌려주기 전에 끝남", async () => {
  const f = fakes();
  await run([{ ref: `x/api@${D2}`, source: `${CUSTOMER}/shop/api@${D2}` }], f);
  assert.deepEqual(f.scope.steps, ["image_mirror"]);
  assert.equal(f.scope.released, 1);
  assert.ok(f.calls.every((c) => c.inScope), "모든 명령이 대여 안에서");
  const [src, platform] = f.calls.filter((c) => c.args[1] === "get-login-password");
  assert.equal(src!.args[3], "us-west-2");
  assert.equal(src!.env.AWS_CONFIG_FILE, BORROWED.AWS_CONFIG_FILE);
  assert.equal(src!.env.AWS_ACCESS_KEY_ID, undefined, "워커 키 없음");
  assert.equal(src!.env.AWS_CONTAINER_CREDENTIALS_FULL_URI, undefined, "워커 Pod Identity 없음");
  assert.equal(platform!.args[3], "ap-northeast-2");
  assert.equal(platform!.env.AWS_CONFIG_FILE, undefined, "플랫폼 쪽은 빌린 자격을 안 씀");
  assert.equal(platform!.env.AWS_CONTAINER_CREDENTIALS_FULL_URI, ENV.AWS_CONTAINER_CREDENTIALS_FULL_URI);
  const cranes = f.calls.filter((c) => c.cmd === "crane");
  assert.ok(cranes.every((c) => !Object.keys(c.env).some((k) => k.startsWith("AWS_"))), "crane 에 클라우드 자격 없음");
  const auths = JSON.parse(cranes[0]!.dockerConfig!).auths;
  assert.deepEqual(Object.keys(auths).sort(), [CUSTOMER, PLATFORM].sort());
  assert.equal(Buffer.from(auths[CUSTOMER].auth, "base64").toString(), "AWS:tok-us-west-2");
  assert.equal(existsSync(cranes[0]!.env.DOCKER_CONFIG!), false, "토큰 파일은 끝나면 지움");

  const pub = fakes();
  await run([{ ref: `nginx@${D1}`, source: `nginx@${D1}` }], pub);
  assert.deepEqual(pub.scope.steps, [], "공개 이미지만이면 고객 역할을 안 빌림");
});

test("실패 사유: 레지스트리 없음·미지원·역할 거부·도구 없음·토큰 실패·복사 실패·다이제스트 다름", async () => {
  const ecr = [{ ref: `x/api@${D2}`, source: `${CUSTOMER}/api@${D2}` }];
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["registry_unset", () => run(ecr, fakes(), { PATH: "/bin" })],
    ["unsupported_registry", () => run([{ ref: `x/api@${D1}`, source: `asia-northeast3-docker.pkg.dev/p/r/api@${D1}` }], fakes())],
    ["role_denied", () => run(ecr, fakes({ denied: true }))],
    ["role_denied", () => mirrorImages(j, m, ecr, { exec: fakes().exec, env: ENV,
      withRoles: (async () => { throw new TempRoleDenied("ROLE_OBSERVE_WRITE", "x"); }) as typeof withStepRoles })],
    ["tool_missing", () => run(ecr, fakes({ fail: { crane: 127 } }))],
    ["tool_missing", () => run(ecr, fakes({ fail: { token: 127 } }))],
    ["auth_failed", () => run(ecr, fakes({ fail: { token: 255 } }))],
    ["copy_failed", () => run(ecr, fakes({ fail: { copy: 1 } }))],
    ["digest_mismatch", () => run(ecr, fakes({ wrongDigest: true }))],
  ];
  for (const [reason, go] of cases) {
    const out = await go() as { ok: boolean; reason?: string; code?: string };
    assert.equal(out.ok, false, reason);
    assert.equal(out.reason, reason);
    assert.equal(out.code, "REHEARSAL_IMAGE_MIRROR_FAILED");
  }
});

test("예산: 단계마다 시간 상한 = min(단계 상한, 남은 예산), 다 쓰면 그 이미지에서 budget_exceeded", async () => {
  const clock = { t: 0 };
  const store = new Map<string, string>();
  const copyTimeouts: number[] = [];
  // 복사 하나에 250초 걸리는 레지스트리. 시간 상한이 그보다 짧으면 끊겨서 실패한다
  const exec: Exec = async (cmd, args, x) => {
    const step = cmd === "aws" ? args[1]! : args[0]!;
    if (step === "copy") copyTimeouts.push(x.timeoutMs);
    const need = step === "copy" ? 250_000 : 1_000;
    clock.t += Math.min(need, x.timeoutMs);
    const r = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr, ms: Math.min(need, x.timeoutMs) });
    if (need > x.timeoutMs) return r(1, "", `[z70] timeout ${x.timeoutMs}ms`);
    if (step === "digest") return store.has(args[1]!) ? r(0, `${store.get(args[1]!)}\n`) : r(1, "", "MANIFEST_UNKNOWN");
    if (step === "copy") { store.set(args[2]!, args[1]!.split("@")[1]!); return r(0); }
    return r(0, step === "get-login-password" ? "tok\n" : "{}");
  };
  const images = [D1, D2, D3].map((d, n) => ({ ref: `img${n}@${d}`, source: `docker.io/library/img${n}@${d}` }));
  const out = await mirrorImages(j, m, images, { exec, env: ENV, now: () => clock.t });
  assert.deepEqual(copyTimeouts, [300_000, 300_000, 91_000], "세 번째 복사는 남은 91초만 받는다");
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.code, "REHEARSAL_IMAGE_MIRROR_FAILED");
  assert.equal(!out.ok && out.reason, "budget_exceeded");
  assert.equal(!out.ok && out.image, images[2]!.ref);
  assert.equal(clock.t, MIRROR_BUDGET_MS);
});

test("예산: 역할 대여가 예산을 다 쓰면 명령을 하나도 시작하지 않고 budget_exceeded", async () => {
  const f = fakes();
  const clock = { t: 0 };
  const slowRoles = ((...a: Parameters<typeof withStepRoles>) => { clock.t += MIRROR_BUDGET_MS; return f.withRoles(...a); }) as typeof withStepRoles;
  const out = await mirrorImages(j, m, [{ ref: `x/api@${D2}`, source: `${CUSTOMER}/api@${D2}` }],
    { exec: f.exec, withRoles: slowRoles, env: ENV, now: () => clock.t });
  assert.equal(!out.ok && out.reason, "budget_exceeded");
  assert.equal(f.calls.length, 0);
});

test("예산은 deploy 작업 만료보다 300초 이상 짧다 (만료를 줄이면 여기가 깨진다)", () => {
  const expireSec = policyOf(QUEUES.deploy).expireInSeconds ?? 900;   // 없으면 pg-boss 기본 900초
  assert.ok(MIRROR_BUDGET_MS <= expireSec * 1000 - 300_000, `예산 ${MIRROR_BUDGET_MS}ms, deploy 만료 ${expireSec}s`);
});

test("image_mirror 역할 요청 = ECR 받기 세 동작, 관찰 최소 권한 검사 통과, 고객 관찰 역할 인라인에 모두 있음", () => {
  const [r] = STEP_ROLES.image_mirror;
  assert.deepEqual({ side: r.side, purpose: r.purpose, actions: [...r.actions] },
    { side: "source", purpose: "observe", actions: ["ecr:BatchGetImage", "ecr:GetAuthorizationToken", "ecr:GetDownloadUrlForLayer"] });
  assert.doesNotThrow(() => checkLeastPrivilege({ tenantId: T, envId: T, provider: "aws", purpose: "observe", actions: [...ECR_PULL_ACTIONS], ttlSec: 900 }));
  const tpl = JSON.parse(readFileSync(new URL("../../../infra/onboarding/aws-connect.json", import.meta.url), "utf8"));
  const inline: string[] = tpl.Resources.ObserveRole.Properties.Policies[0].PolicyDocument.Statement.flatMap((s: { Action: string[] }) => s.Action);
  for (const a of ECR_PULL_ACTIONS) assert.ok(inline.includes(a), `고객 관찰 역할에 없음: ${a}`);
});
