// 리허설 이미지 복사 결과가 호스트 가드 sbx-pod-guard 를 통과하는지 진짜 kube-apiserver 의 VAP CEL 로 본다.
// 로컬 kind 전용. SANDBOX_VAP_KIND_CONTEXT=kind-<이름> 이 없으면 건너뛴다. 정책은 플랫폼 차트 sandbox-vap.yaml 을 helm template 으로 렌더해 올리고,
// 파드는 server dry-run 이라 남지 않는다. 끝에 시험 네임스페이스를 지운다. 레지스트리·클라우드 호출 없음 (aws·crane 은 가짜 exec)
// 실행: kind create cluster --name sbx-vap --image kindest/node:v1.35.8
//       SANDBOX_VAP_KIND_CONTEXT=kind-sbx-vap node --import tsx --test apps/worker/test/image-mirror-vap.it.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { Exec } from "@svc/adapters";
import { mirrorImages, type MirrorImage } from "../src/rehearsal/image-mirror.js";
import type { StepRoles, withStepRoles } from "../src/jobs/_roles.js";

const CTX = process.env.SANDBOX_VAP_KIND_CONTEXT ?? "";
const skip = !CTX ? "SANDBOX_VAP_KIND_CONTEXT 없음 (kind VAP 시험 건너뜀)" : !CTX.startsWith("kind-") ? "kind- 컨텍스트만" : false;
const root = new URL("../../../", import.meta.url).pathname;
const T = "11111111-1111-4111-8111-111111111111", OTHER = "66666666-6666-4666-8666-666666666666";
const HOST = "000000000000.dkr.ecr.ap-northeast-2.amazonaws.com", REG = `${HOST}/sandbox`;
const NS = `sbx-mirror-vap-${process.pid}`;
const D = `sha256:${"0".repeat(64)}`;

const sh = (cmd: string, args: string[], input?: string) =>
  spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...(input === undefined ? {} : { input }) });
const k = (args: string[], input?: string) => sh("kubectl", ["--context", CTX, ...args], input);
const podAdmission = (image: string) => k(["-n", NS, "run", "p", `--image=${image}`, "--restart=Never", "--dry-run=server",
  `--overrides=${JSON.stringify({ apiVersion: "v1", spec: { nodeSelector: { pool: "sandbox" } } })}`]);

before(async () => {
  if (skip) return;
  const vap = sh("helm", ["template", "platform", "deploy/helm/platform", "-n", "platform", "-s", "templates/sandbox-vap.yaml",
    "--set", "sandbox.enabled=true", "--set", `sandbox.imageRegistry=${REG}`]);
  assert.equal(vap.status, 0, vap.stderr);
  const applied = k(["apply", "-f", "-"], vap.stdout);
  assert.equal(applied.status, 0, applied.stderr);
  const ns = { apiVersion: "v1", kind: "Namespace", metadata: { name: NS, labels: { "platform.svc/sandbox": "true", "platform.svc/tenant": T } } };
  const made = k(["create", "-f", "-"], JSON.stringify(ns));
  assert.equal(made.status, 0, made.stderr);
  for (let i = 0; i < 60; i++) {
    if (/sbx-pod-guard/.test(podAdmission(`${REG}/${OTHER}/web@${D}`).stderr)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.fail("sbx-pod-guard 가 60초 안에 켜지지 않음");
});
after(() => { if (!skip) k(["delete", "namespace", NS, "--wait=false"]); });

function fakeRegistry() {
  const store = new Map<string, string>();
  const exec: Exec = async (cmd, args) => {
    const r = (code: number, stdout = "") => ({ code, stdout, stderr: code ? "MANIFEST_UNKNOWN" : "", ms: 1 });
    if (cmd === "aws") return r(0, args[1] === "get-login-password" ? "tok\n" : "{}");
    if (args[0] === "digest") return store.has(args[1]!) ? r(0, `${store.get(args[1]!)}\n`) : r(1);
    store.set(args[2]!, args[1]!.split("@")[1]!);
    return r(0);
  };
  const withRoles = (async (_s: string, _j: unknown, _m: unknown, fn: (r: StepRoles) => Promise<unknown>) =>
    fn({ creds: [], denied: [], skipped: [], awsEnv: { source: { AWS_REGION: "us-west-2" } } })) as typeof withStepRoles;
  return { exec, withRoles };
}
const mirror = (images: MirrorImage[]) => mirrorImages({ tenantId: T, migrationId: "22222222-2222-4222-8222-222222222222" },
  { id: "22222222-2222-4222-8222-222222222222", status: "deploying", sourceEnvId: "s", targetEnvId: "t" }, images,
  { ...fakeRegistry(), env: { SANDBOX_IMAGE_REGISTRY: REG, PATH: process.env.PATH } });

test("복사 결과 주소는 모두 sbx-pod-guard 를 통과한다 (ECR·공개·이미 이 회사 자리)", { skip }, async () => {
  const out = await mirror([
    { ref: `x/api@${D}`, source: `111122223333.dkr.ecr.us-west-2.amazonaws.com/shop/api@${D}` },
    { ref: `x/pause@${D}`, source: `registry.k8s.io/pause@${D}` },
    { ref: `x/cached@${D}`, source: `${REG}/${T}/cached@${D}` },
  ]);
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.images.length, 3);
  for (const { sandboxRef } of out.images) {
    const r = podAdmission(sandboxRef);
    assert.equal(r.status, 0, `${sandboxRef}: ${r.stderr}`);
  }
});

test("플랫폼 레지스트리의 회사 자리 밖 주소는 sbx-pod-guard 가 거부하고, 복사는 그 원본을 넘기지 않고 멈춘다", { skip }, async () => {
  for (const source of [`${HOST}/platform/${T}/web@${D}`, `${REG}/${OTHER}/web@${D}`]) {
    const r = podAdmission(source);
    assert.notEqual(r.status, 0, `${source} 가 통과함`);
    assert.match(r.stderr, /sbx-pod-guard/);
    const out = await mirror([{ ref: `x/web@${D}`, source }]);
    assert.equal(!out.ok && out.reason, "unsupported_registry", JSON.stringify(out));
  }
});
