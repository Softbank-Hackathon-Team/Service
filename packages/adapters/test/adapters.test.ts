import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AppSpec, Provider, type TargetEnv } from "@svc/contracts";
import { adapterFor, aws, gcp, onprem, azure, DEMO_INVENTORY, type Target } from "../src/index.js";
import { MODULE_DIGEST } from "../src/module-digests.js";
import { moduleDigest } from "../scripts/module-digest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const tf = (m: string) => readFileSync(join(root, "infra/modules", m, "main.tf"), "utf8");
const blocks = (src: string, kind: "variable" | "resource" | "data") =>
  [...src.matchAll(new RegExp(`^${kind} "([^"]+)"`, "gm"))].map((m) => m[1]!);
// default가 있는 변수 = 어댑터가 안 넘겨도 되는 변수
const requiredVars = (src: string) => src.split(/^variable /m).slice(1)
  .filter((b) => !/^\s*default\s*=/m.test(b.split(/^}/m)[0]!)).map((b) => b.match(/^"([^"]+)"/)![1]!);

// 실제 데모 원본(가져오기) → 명세. DB와 시크릿이 있는 3티어 API 층
const full = (p: Provider) => AppSpec.parse(adapterFor(p === "azure_mock" ? "aws" : p).normalize(DEMO_INVENTORY[p === "azure_mock" ? "aws" : p]).spec);
const tgt = (p: Provider, extra: Partial<Target> = {}): TargetEnv => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", ...extra } as TargetEnv);
const MODULE: Record<Provider, string> = { aws: "aws/app", gcp: "gcp/app", onprem: "onprem/app", azure_mock: "azure/app" };

test("모든 어댑터의 normalize 결과는 AppSpec을 통과한다 (빈 원본 = 고정 예시, 검토 필요 표시)", () => {
  for (const p of Provider.options) {
    const { spec, fieldMeta } = adapterFor(p).normalize({ provider: p, items: [], coverage: {} });
    assert.equal(AppSpec.safeParse(spec).success, true, p);
    assert.equal(fieldMeta["service.image"]?.needs_review, true, p);
  }
});

test("데모 원본(ECS+RDS / GKE+CloudSQL / k3s+CNPG) → 같은 명세로 모인다", () => {
  const specs = (["aws", "gcp", "onprem"] as const).map((p) => {
    const r = adapterFor(p).normalize(DEMO_INVENTORY[p]);
    assert.equal(AppSpec.safeParse(r.spec).success, true, p);
    assert.equal(r.fieldMeta["service.port"]?.confidence, 1, p);
    return AppSpec.parse(r.spec);
  });
  for (const s of specs) {
    assert.equal(s.app.name, "shop-api");
    assert.deepEqual(s.database, { engine: "postgres", majorVersion: "16", storageGb: 20 });
    assert.deepEqual(s.service.secretRefs.map((r) => r.name), ["DATABASE_PASSWORD"]);
    assert.equal(s.service.cpu, "500m"); assert.equal(s.service.memory, "1Gi");
    assert.equal(s.service.image.split("@")[1], specs[0]!.service.image.split("@")[1]); // digest 동일
  }
});

test("어댑터는 순수하다: 같은 입력이면 같은 출력 (planHash 결정성)", () => {
  for (const p of Provider.options) {
    const a = adapterFor(p); const s = full(p); const t = tgt(p);
    assert.deepEqual(a.toTerraform(s, t), a.toTerraform(structuredClone(s), { ...t }), p);
    assert.deepEqual(a.toHelmValues(s, {}, t), a.toHelmValues(structuredClone(s), {}, { ...t }), p);
    // env·secret 순서가 달라도 같은 값 (정렬)
    const shuffled = { ...s, service: { ...s.service, env: [...s.service.env].reverse(), secretRefs: [...s.service.secretRefs].reverse() } };
    assert.deepEqual(a.toHelmValues(shuffled, {}, t), a.toHelmValues(s, {}, t), p);
  }
});

test("명세가 바뀌면 번역 결과도 바뀐다 (replicas → Helm, DB 크기 → Terraform)", () => {
  for (const p of ["aws", "gcp", "onprem"] as const) {
    const a = adapterFor(p); const s = full(p); const t = tgt(p);
    const more = { ...s, service: { ...s.service, replicas: s.service.replicas + 1 } };
    assert.notDeepEqual(a.toHelmValues(more, {}, t), a.toHelmValues(s, {}, t), p);
    const bigger = { ...s, database: { ...s.database!, storageGb: 50 } };
    assert.notDeepEqual(a.toTerraform(bigger, t), a.toTerraform(s, t), p);
  }
});

test("계약: 어댑터가 넘기는 Terraform 변수 = 모듈이 받는 변수", () => {
  for (const p of Provider.options) {
    const src = tf(MODULE[p]);
    const { moduleRef, vars } = adapterFor(p).toTerraform(full(p), tgt(p));
    assert.equal(moduleRef.path, `infra/modules/${MODULE[p]}`);
    const declared = new Set(blocks(src, "variable"));
    for (const k of Object.keys(vars)) assert.ok(declared.has(k), `${p}: 모듈에 없는 변수 ${k}`);
    for (const k of requiredVars(src)) assert.ok(k in vars, `${p}: 어댑터가 안 넘긴 필수 변수 ${k}`);
  }
});

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

test("이미지 주소: digest는 그대로, 저장소만 도착 환경 것으로", () => {
  const src = full("aws").service.image;
  const digest = src.split("@")[1];
  for (const p of Provider.options) {
    const ref = adapterFor(p).imageRef(src, tgt(p, { accountId: "111122223333", projectId: "proj-1", registryHost: "reg.local:5000", tenantId: "t1" }));
    assert.ok(ref.endsWith(`/platform/t1/shop-api@${digest}`), `${p}: ${ref}`);
  }
});

test("자리표시: 연결 정보를 다 주면 <env:…>가 남지 않고, 안 주면 정해진 칸만 남는다", () => {
  const extras = { tenantId: "t1", migrationId: "m1", accountId: "111122223333", projectId: "proj-1",
    networkId: "projects/proj-1/global/networks/v", vpcId: "vpc-1", subnetIds: ["subnet-b", "subnet-a"], clusterName: "c1", clusterLocation: "asia-northeast3-a" };
  const left = (p: "aws" | "gcp", t: TargetEnv) => JSON.stringify(adapterFor(p).toTerraform(full(p), t)).match(/<env:[a-zA-Z]+>/g) ?? [];
  assert.deepEqual(left("aws", tgt("aws", extras)), []);
  assert.deepEqual(left("gcp", tgt("gcp", extras)), []);
  assert.deepEqual([...new Set(left("aws", tgt("aws")))].sort(),
    ["<env:accountId>", "<env:clusterName>", "<env:dbSubnetIdsJson>", "<env:tenantId>", "<env:vpcId>"]);
  // 계획 단계(out 비어 있음) → <tf-output:…>, apply 뒤 → 진짜 값
  const v1 = gcp.gcpAdapter.toHelmValues(full("gcp"), {}, tgt("gcp")) as { database: { host: string } };
  const v2 = gcp.gcpAdapter.toHelmValues(full("gcp"), { db_private_ip: "10.0.0.5" }, tgt("gcp")) as { database: { host: string } };
  assert.equal(v1.database.host, "<tf-output:db_private_ip>");
  assert.equal(v2.database.host, "10.0.0.5");
});

test("Helm 값: 프로바이더마다 다른 칸은 이미지·신원·시크릿 저장소·DB뿐 (같은 차트 재사용 근거)", () => {
  const s = full("aws");
  const vals = Provider.options.map((p) => adapterFor(p).toHelmValues(s, {}, tgt(p)) as Record<string, unknown>);
  const keys = Object.keys(vals[0]!);
  const differ = keys.filter((k) => vals.some((v) => JSON.stringify(v[k]) !== JSON.stringify(vals[0]![k])));
  const allowed = new Set(["database", "externalSecrets", "image", "ingress", "labels", "serviceAccount"]);
  for (const k of differ) assert.ok(allowed.has(k), `프로바이더마다 달라지면 안 되는 칸: ${k}`);
  for (const k of ["replicas", "resources", "port", "probes", "env", "app"]) assert.ok(!differ.includes(k), k);
  assert.equal((vals[2]!.database as { mode: string }).mode, "cnpg");
});

test("Azure는 Mock: 실행 권한 0, 능력표에 mock 표시", () => {
  assert.deepEqual(adapterFor("azure_mock").requiredOperateActions(full("azure_mock")), []);
  assert.ok(adapterFor("azure_mock").capabilities().includes("mock"));
});

test("Helm 차트 렌더: 네 어댑터 값이 gitops/charts/app 에서 오류 없이 렌더된다 (helm 없으면 건너뜀)", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const helm = process.env.HELM_BIN ?? "helm";
  try { execFileSync(helm, ["version", "--short"], { stdio: "ignore" }); } catch { t.skip("helm 없음"); return; }
  const dir = mkdtempSync(join(tmpdir(), "vals-"));
  for (const p of Provider.options) {
    const f = join(dir, `${p}.json`);
    writeFileSync(f, JSON.stringify(adapterFor(p).toHelmValues(full(p), {}, tgt(p, { tenantId: "t1" }))));
    const out = execFileSync(helm, ["template", "x", join(root, "gitops/charts/app"), "-f", f], { encoding: "utf8" });
    const kinds = [...out.matchAll(/^kind: (\w+)/gm)].map((m) => m[1]).sort();
    assert.ok(kinds.includes("Deployment") && kinds.includes("Service") && kinds.includes("ExternalSecret"), `${p}: ${kinds}`);
    assert.equal(kinds.includes("Cluster"), p === "onprem", `${p}: CNPG Cluster는 온프레만`);
    assert.ok(out.includes("@sha256:"), p);
  }
});

test("권한 경계: infra/permissions 파일 = 어댑터 정의, 앱 역할 모듈이 경계를 붙인다", () => {
  const f = JSON.parse(readFileSync(join(root, "infra/permissions/aws-app-role-boundary.json"), "utf8"));
  assert.deepEqual(f, aws.appRoleBoundary("ap-northeast-2"));
  assert.match(tf("aws/app"), /permissions_boundary\s*=\s*var\.app_role_boundary_arn/);
  assert.match(readFileSync(join(root, "infra/modules/aws/env/main.tf"), "utf8"), /permissions\/aws-app-role-boundary\.json/);
  const { vars } = adapterFor("aws").toTerraform(full("aws"), tgt("aws", { accountId: "111122223333" }));
  assert.equal(vars.app_role_boundary_arn, "arn:aws:iam::111122223333:policy/platform-app-boundary");
});

test("시크릿 이름: Helm 값의 remoteKey = Terraform이 만드는 시크릿 이름 규칙", () => {
  const ref = (p: "aws" | "gcp") => ((adapterFor(p).toHelmValues(full(p), {}, tgt(p, { tenantId: "t1" })) as
    { externalSecrets: { refs: Array<{ remoteKey: string }> } }).externalSecrets.refs[0]!.remoteKey);
  assert.equal(ref("aws"), "platform/t1/shop-api/DATABASE_PASSWORD");      // aws/app: platform/<tenant>/<app>/<name>
  assert.equal(ref("gcp"), "app-shop-api-database-password");              // gcp/app: app-<app>-<name 소문자>
  assert.match(tf("gcp/app"), /secret_id = "app-\$\{var\.app_name\}-\$\{lower/);
  assert.match(tf("aws/app"), /name\s*=\s*"platform\/\$\{var\.tenant_id\}\/\$\{var\.app_name\}\/\$\{each\.key\}"/);
});
