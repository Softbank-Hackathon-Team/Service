import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Provider, type TargetEnv } from "@svc/contracts";
import { adapterFor, aws, gcp, onprem, azure, targetBuilderFor, DEMO_SPEC, type Target } from "../src/index.js";
import { MODULE_DIGEST } from "../src/module-digests.js";
import { moduleDigest } from "../scripts/module-digest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const tf = (m: string) => readFileSync(join(root, "infra/modules", m, "main.tf"), "utf8");
const blocks = (src: string, kind: "variable" | "resource" | "data") =>
  [...src.matchAll(new RegExp(`^${kind} "([^"]+)"`, "gm"))].map((m) => m[1]!);
// default가 있는 변수 = 어댑터가 안 넘겨도 되는 변수
const requiredVars = (src: string) => src.split(/^variable /m).slice(1)
  .filter((b) => !/^\s*default\s*=/m.test(b.split(/^}/m)[0]!)).map((b) => b.match(/^"([^"]+)"/)![1]!);

// 권한표 기준: DB·시크릿이 있는 앱 (권한 함수는 명세 대신 이 두 가지만 본다)
const full = (_p: Provider) => ({ database: true, secrets: true });
const tgt = (p: Provider, extra: Partial<Target> = {}): TargetEnv => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", ...extra } as TargetEnv);
const MODULE: Record<Provider, string> = { aws: "aws/app", gcp: "gcp/app", onprem: "onprem/app", azure_mock: "azure/app" };

test("계약: 권한표의 자원 종류 = main.tf가 만드는 자원 종류 (DB·시크릿 있는 명세 기준)", () => {
  const cases: Array<[string, string[]]> = [
    ["aws/app", aws.resourceTypes(full("aws"))],
    ["gcp/app", gcp.resourceTypes(full("gcp"))],
    ["azure/app", azure.resourceTypes(full("azure_mock"))],
  ];
  for (const [m, types] of cases) {
    const src = tf(m);
    const inTf = [...blocks(src, "resource"), ...blocks(src, "data").map((d) => `data.${d}`)];
    assert.deepEqual([...new Set(inTf)].sort(), types, m);
  }
  // 온프레: Terraform 자원 → RBAC 자원 이름
  const map: Record<string, string> = { kubernetes_namespace_v1: "core/namespaces",
    kubernetes_resource_quota_v1: "core/resourcequotas", kubernetes_network_policy_v1: "networking.k8s.io/networkpolicies" };
  for (const r of blocks(tf("onprem/app"), "resource").filter((r) => r !== "time_sleep"))
    assert.ok(onprem.resourceTypes(full("onprem")).includes(map[r]!), r);
});

test("모듈 지문: module-digests.ts가 실제 infra 파일과 같다 (다르면 npm run gen:digests)", () => {
  for (const [m, d] of Object.entries(MODULE_DIGEST)) assert.equal(moduleDigest(join(root, "infra/modules", m)), d, m);
});

test("AWS 세션 정책은 2,048자 이하, plan은 읽기 권한만", () => {
  const s = full("aws");
  for (const purpose of ["plan", "apply", "destroy"] as const) assert.ok(aws.sessionPolicy(s, purpose).length <= 2048);
  assert.ok(aws.operateActions(s, "plan").every((a) => /:(Describe|Get|List)/.test(a)));
  assert.ok(aws.operateActions(s, "apply").includes("rds:CreateDBInstance"));
  assert.ok(!aws.operateActions(s, "apply").includes("rds:DeleteDBInstance"));
});

test("이미지 주소: 사설 레지스트리면 digest는 그대로, 저장소만 도착 환경 것으로", () => {
  // FM-APP-01: 공개 레지스트리(ghcr.io 등)는 출발 주소 그대로 → 사설(ECR)로 시험
  const src = `123456789012.dkr.ecr.us-east-1.amazonaws.com/demo/shop-api@sha256:${"ab".repeat(32)}`;
  const digest = src.split("@")[1];
  for (const p of Provider.options) {
    const ref = adapterFor(p).imageRef(src, tgt(p, { accountId: "111122223333", projectId: "proj-1", registryHost: "reg.local:5000", tenantId: "t1" }));
    assert.ok(ref.endsWith(`/platform/t1/shop-api@${digest}`), `${p}: ${ref}`);
  }
});

test("FM-APP-01: 공개 레지스트리 이미지는 어느 도착이든 출발 주소@digest 그대로 (Docker Hub 짧은 이름 포함)", () => {
  const d = `sha256:${"cd".repeat(32)}`;
  for (const p of Provider.options) {
    const t = tgt(p, { accountId: "111122223333", projectId: "proj-1", registryHost: "reg.local:5000", tenantId: "t1" });
    for (const src of [`ghcr.io/demo/shop-api@${d}`, `docker.io/hashicorp/http-echo@${d}`, `hashicorp/http-echo@${d}`, `nginx@${d}`, `quay.io/x/y@${d}`])
      assert.equal(adapterFor(p).imageRef(src, t), src, `${p}: ${src}`);
  }
});

test("FM-APP-01 거부: 사설·모르는 호스트(ECR·pkg.dev·localhost:5000·registry.example)는 도착 플랫폼 저장소로, digest 없으면 막힘", () => {
  const d = `sha256:${"cd".repeat(32)}`;
  const t = tgt("gcp", { projectId: "proj-1", tenantId: "t1" });
  for (const src of [`1.dkr.ecr.ap-northeast-2.amazonaws.com/a/web@${d}`, `asia-northeast3-docker.pkg.dev/p/r/web@${d}`, `localhost:5000/web@${d}`, `registry.example/web@${d}`])
    assert.equal(adapterFor("gcp").imageRef(src, t), `asia-northeast3-docker.pkg.dev/proj-1/platform/t1/web@${d}`, src);
  assert.throws(() => adapterFor("gcp").imageRef("docker.io/library/nginx:1.27", t), /digest/);
});

test("Azure는 Mock: 실행 권한 0, 능력표에 mock 표시", () => {
  assert.deepEqual(targetBuilderFor("azure_mock").operateActionsV2(DEMO_SPEC, "apply"), []);
  assert.ok(adapterFor("azure_mock").capabilities().includes("mock"));
});

test("권한 경계: infra/permissions 파일 = 어댑터 정의, 앱 역할 모듈이 경계를 붙인다", () => {
  const f = JSON.parse(readFileSync(join(root, "infra/permissions/aws-app-role-boundary.json"), "utf8"));
  assert.deepEqual(f, aws.appRoleBoundary("ap-northeast-2"));
  assert.match(tf("aws/app"), /permissions_boundary\s*=\s*var\.app_role_boundary_arn/);
  assert.match(readFileSync(join(root, "infra/modules/aws/env/main.tf"), "utf8"), /permissions\/aws-app-role-boundary\.json/);
  const { vars } = targetBuilderFor("aws").toTerraformV2(DEMO_SPEC, { ...tgt("aws", { accountId: "111122223333" }), tenantId: "t1", migrationId: "m1" } as Target);
  assert.equal(vars.app_role_boundary_arn, "arn:aws:iam::111122223333:policy/platform-app-boundary");
});
