// TA13: 관리형 컨테이너(ECS·Cloud Run) 도착 렌더 — aws(kinds/service-ecs)·gcp(kinds/service-cloudrun). 순수 함수, terraform 안 돌림
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppSpecV2, ModuleKind, ServiceEnvVar, ServiceSecretVar, ServiceTfVars, TF_KIND_VARS } from "@svc/contracts";
import {
  AdapterError, DEMO_INVENTORY_V2, flattenTfOutputsV2, managedBlockers, normalizeV2, resourceTypesV2For, targetBuilderFor, UNSUPPORTED_V2,
  v2PrecheckItems,
} from "../src/index.js";

const T = { envId: "33333333-3333-4333-8333-333333333333", region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" };
const at = (p: "aws" | "gcp" | "onprem" | "azure_mock") => ({ ...T, provider: p }) as never;
const ECS = (): AppSpecV2 => AppSpecV2.parse(normalizeV2(DEMO_INVENTORY_V2.aws!).result.spec);
const services = (vars: Record<string, unknown>) => (JSON.parse(vars.service_json as string) as unknown[]).map((x) => ServiceTfVars.parse(x));
const byId = (vars: Record<string, unknown>, id: string) => services(vars).find((s) => s.id === id)!;
const throwsUnsupported = (f: () => unknown, re: RegExp) =>
  assert.throws(f, (e: unknown) => e instanceof AdapterError && e.code === UNSUPPORTED_V2 && re.test(e.message));

test("aws: ECS 3티어 → service-ecs 3개 + postgres, k8s 신원·네임스페이스 없음, 같은 입력 = 같은 결과", () => {
  const a = targetBuilderFor("aws").toTerraformV2(ECS(), at("aws")), b = targetBuilderFor("aws").toTerraformV2(ECS(), at("aws"));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(a.instances.map((i) => `${i.module}:${i.id}`),
    ["aws/kinds/postgres:shop-db", "aws/kinds/service-ecs:shop-api", "aws/kinds/service-ecs:shop-web", "aws/kinds/service-ecs:shop-worker"]);
  assert.deepEqual(a.modules.map((m) => m.path), ["infra/modules/aws/kinds/postgres", "infra/modules/aws/kinds/service-ecs"]);
  assert.equal(a.vars.identity_json, "[]");
  assert.equal(a.vars.namespace_json, "[]");
  const api = byId(a.vars, "shop-api");
  assert.equal(api.min_instances, 2); assert.equal(api.max_instances, 6); assert.equal(api.target_cpu_pct, 70);
  assert.equal(api.port, 8080); assert.equal(api.health_path, "/healthz"); assert.equal(api.cpu_milli, 500); assert.equal(api.mem_mib, 1024);
  assert.match(api.image, /\.dkr\.ecr\.ap-northeast-2\.amazonaws\.com\/.*shop-api@sha256:[0-9a-f]{64}$/);
  assert.ok(api.role_name.startsWith("app-") && api.role_name.length <= 61);
  // env: 확정값은 lit, DB 주소는 ref (루트가 같은 apply 안에서 채움), 비밀은 값 없이 저장소 이름
  const env = ServiceEnvVar.array().parse(JSON.parse(api.env_json));
  assert.deepEqual(env, [
    { name: "LOG_LEVEL", parts: [{ lit: "info", ref: null }] },
    { name: "DB_HOST", parts: [{ lit: null, ref: "shop-db.host" }] },
  ]);
  assert.deepEqual(ServiceSecretVar.array().parse(JSON.parse(api.secrets_json)),
    [{ name: "DATABASE_PASSWORD", secret: `platform/${T.tenantId}/shop-api/shop-db`, key: "password" }]);
  // web 의 template 주소는 조각으로 (Service Connect 이름 = IR id 는 루트가 채움)
  assert.deepEqual(JSON.parse(byId(a.vars, "shop-web").env_json),
    [{ name: "API_URL", parts: [{ lit: "http://", ref: null }, { lit: null, ref: "shop-api.host" }, { lit: ":8080", ref: null }] }]);
  // 입구가 오는 서비스만 public
  assert.deepEqual(services(a.vars).map((s) => [s.id, s.public]), [["shop-api", true], ["shop-web", true], ["shop-worker", false]]);
  // Helm 워크로드 없음 (서비스는 Terraform 이 띄움), 서비스 이름은 루트 출력 자리표시
  const v = targetBuilderFor("aws").toWorkloadValues(ECS(), {}, at("aws"));
  assert.deepEqual(v.workloads, []);
  assert.deepEqual((v.managed as Array<{ service: string }>).map((m) => m.service),
    ["<tf-output:service.shop-api.name>", "<tf-output:service.shop-web.name>", "<tf-output:service.shop-worker.name>"]);
  const v2 = targetBuilderFor("aws").toWorkloadValues(ECS(), flattenTfOutputsV2({ service_names: JSON.stringify({ "shop-api": "shopapi-x" }) }), at("aws"));
  assert.equal((v2.managed as Array<{ service: string }>)[0]!.service, "shopapi-x");
});

test("gcp: ECS 3티어 → service-cloudrun 3개, 이름 49자·SA 30자 규칙, 비밀은 키마다 secret 하나", () => {
  const tf = targetBuilderFor("gcp").toTerraformV2(ECS(), at("gcp"));
  assert.deepEqual(tf.instances.filter((i) => i.kind === "service").map((i) => i.module), Array(3).fill("gcp/kinds/service-cloudrun"));
  for (const s of services(tf.vars)) {
    assert.match(s.name, /^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$/);
    assert.ok(s.role_name.startsWith("app-") && s.role_name.length >= 6 && s.role_name.length <= 30, s.role_name);
    assert.match(s.image, /^asia-northeast3-docker\.pkg\.dev\//);
  }
  assert.deepEqual(JSON.parse(byId(tf.vars, "shop-api").secrets_json), [{ name: "DATABASE_PASSWORD", secret: "app-shop-api-shop-db-password", key: "password" }]);
  // 계약 표: service 가 종류 모듈로 들어감 (매트릭스 줄 module.service["<id>"])
  assert.ok(ModuleKind.safeParse("service").success);
  assert.equal(TF_KIND_VARS.service, ServiceTfVars);
  // precheck: Cloud Run 주소(https·443) 경고 + 입구 미연결 경고 (막지는 않음)
  const items = v2PrecheckItems("gcp", { spec: null, specV2: ECS(), hadV2Before: false });
  // 막는 줄은 출발 DB 방화벽을 못 읽은 것(사람 확인)뿐 — 관리형 렌더 미지원 줄 없음
  assert.deepEqual(items.filter((i) => i.level === "block").map((i) => i.id), ["PC-V2-HUMAN-1"]);
  assert.ok(items.some((i) => i.level === "warn" && /shop-web\.API_URL: Cloud Run/.test(i.message)));
  assert.ok(items.some((i) => i.level === "warn" && /입구\(entry\)/.test(i.message)));
});

test("권한표: 관리형이면 ECS·Cloud Run 자원 종류와 동작, 관리형이 없으면 그대로", () => {
  assert.ok(resourceTypesV2For("aws", ECS()).includes("aws_ecs_service"));
  assert.ok(resourceTypesV2For("aws", ECS()).includes("aws_appautoscaling_policy"));
  assert.equal(resourceTypesV2For("aws", ECS()).includes("aws_eks_pod_identity_association"), false);
  const acts = targetBuilderFor("aws").operateActionsV2(ECS(), "apply");
  for (const a of ["ecs:CreateService", "ecs:RegisterTaskDefinition", "servicediscovery:CreateHttpNamespace", "iam:CreateRole", "secretsmanager:CreateSecret"]) assert.ok(acts.includes(a), a);
  assert.ok(targetBuilderFor("gcp").operateActionsV2(ECS(), "apply").includes("run.services.create"));
  assert.ok(resourceTypesV2For("gcp", ECS()).includes("google_cloud_run_v2_service_iam_member"));
});

test("관리형이 없는 명세: service_json 키 자체가 없음 (기존 계획 지문 그대로)", () => {
  const k8s = AppSpecV2.parse({ ...ECS(), components: ECS().components.map((c) => (c.kind === "service" ? { ...c, props: { ...c.props, runtime: "k8s" } } : c)) });
  for (const p of ["aws", "gcp"] as const) {
    const tf = targetBuilderFor(p).toTerraformV2(k8s, at(p));
    assert.equal("service_json" in tf.vars, false, p);
    assert.equal(tf.instances.some((i) => i.kind === "service"), false, p);
    assert.equal(JSON.parse(tf.vars.identity_json as string).length, 3, p);
  }
});

test("거부: 온프레·azure 는 capability 로 막힘 (그대로)", () => {
  for (const p of ["onprem", "azure_mock"] as const) throwsUnsupported(() => targetBuilderFor(p).toTerraformV2(ECS(), at(p)), /runtime\.managedContainer/);
});

test("거부: k8s 워크로드와 섞음 · 사이드카·볼륨·fromField · 포트 2개 · 권한 대응 → UNSUPPORTED_V2 (계획 전)", () => {
  const base = ECS();
  const job = { id: "nightly", kind: "job", props: { image: (base.components[0] as { props: { image: unknown } }).props.image, resources: {}, env: [],
    serviceAccount: "x", schedule: "0 3 * * *" } };
  const mixed = AppSpecV2.parse({ ...base, components: [...base.components, job] });
  for (const p of ["aws", "gcp"] as const) throwsUnsupported(() => targetBuilderFor(p).toTerraformV2(mixed, at(p)), /nightly.*섞음/);
  const edit = (f: (props: Record<string, unknown>) => void) => {
    const s = structuredClone(base) as unknown as { components: Array<{ id: string; props: Record<string, unknown> }> };
    f(s.components.find((c) => c.id === "shop-api")!.props);
    return AppSpecV2.parse(s);
  };
  const bad = edit((p) => {
    p.volumes = [{ name: "data", mountPath: "/data" }];
    (p.env as unknown[]).push({ name: "POD_IP", fromField: "status.podIP" });
    p.ports = [{ port: 8080, protocol: "TCP" }, { port: 9090, protocol: "TCP" }];
  });
  assert.deepEqual(managedBlockers(bad), ["도착 렌더 미지원: shop-api 관리형 서비스에 volumes·env(fromConfig·fromField·fromResource)·ports 2개 이상 못 그림"]);
  throwsUnsupported(() => targetBuilderFor("aws").toTerraformV2(bad, at("aws")), /shop-api 관리형 서비스에 volumes/);
  assert.ok(v2PrecheckItems("aws", { spec: null, specV2: bad, hadV2Before: false }).some((i) => i.level === "block" && /volumes/.test(i.message)));
  const granted = AppSpecV2.parse({ ...base, links: base.links.map((l) => (l.from === "shop-api" ? { ...l, grants: [{ effect: "Allow", actions: ["s3:GetObject"], resources: ["*"] }] } : l)) });
  assert.ok(managedBlockers(granted).some((m) => /권한 대응/.test(m)));
  assert.deepEqual(managedBlockers(ECS()), []);
});

test("HCL 대조: 루트가 service_json 을 받고 module.service 로 넘김, 비면 기본 [] (aws·gcp)", () => {
  const infra = join(dirname(fileURLToPath(import.meta.url)), "../../../infra/modules");
  for (const [p, kind] of [["aws", "service-ecs"], ["gcp", "service-cloudrun"]] as const) {
    const root = readFileSync(join(infra, p, "root", "main.tf"), "utf8");
    assert.match(root, /variable "service_json" \{\s*type\s*=\s*string\s*default\s*=\s*"\[\]"/, p);
    assert.match(root, new RegExp(`module "service" \\{\\s*source\\s*=\\s*"\\.\\./kinds/${kind}"`), p);
    // 루트가 조각(parts)의 ref 를 link 출력으로 바꿔 모듈엔 {name, value} 만 넘김
    assert.match(root, /p\.ref == null \? p\.lit : local\.link_values\[p\.ref\]/, p);
  }
});

test("계약: env 조각은 lit·ref 중 하나만, ref 는 <IR id>.<출력> 모양 (거부)", () => {
  assert.ok(ServiceEnvVar.safeParse({ name: "A", parts: [{ lit: "x", ref: null }, { lit: null, ref: "shop-db.host" }] }).success);
  assert.equal(ServiceEnvVar.safeParse({ name: "A", parts: [{ lit: "x", ref: "shop-db.host" }] }).success, false);
  assert.equal(ServiceEnvVar.safeParse({ name: "A", parts: [{ lit: null, ref: null }] }).success, false);
  assert.equal(ServiceEnvVar.safeParse({ name: "A", parts: [{ lit: null, ref: "shop-db.password" }] }).success, false);
  assert.equal(ServiceTfVars.safeParse({ ...byId(targetBuilderFor("aws").toTerraformV2(ECS(), at("aws")).vars, "shop-api"), extra: 1 }).success, false);
});
