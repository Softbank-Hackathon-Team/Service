import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, AppSpecV2, ComponentV2, ModuleInstance, TF_KIND_VARS, upconvertV1, type TargetEnv } from "@svc/contracts";
import {
  targetBuilderFor, requirementsV2, v2Blockers, V2_FIELD_COVERAGE, UNSUPPORTED_V2, AdapterError, aws, gcp, onprem,
  rdsClassFor, cloudSqlTierFor, type Target,
} from "../src/index.js";

// TA1 (설계 27번 A1 = 24번 I5) 도착 Builder v2 시험

const T = (p: TargetEnv["provider"], extra: Partial<Target> = {}): Target =>
  ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222", ...extra }) as Target;
const D = (c: string) => `sha256:${c.repeat(64)}`;

// v1 데모 (DB·시크릿 있는 API 층)
const V1: AppSpec = AppSpec.parse({
  schemaVersion: "1", app: { name: "shop" },
  service: { image: `registry/shop-api@${D("a")}`, port: 8080, healthPath: "/healthz", replicas: 2, cpu: "500m", memory: "1Gi",
    env: [{ name: "LOG_LEVEL", value: "info" }], secretRefs: [{ name: "DATABASE_PASSWORD", key: "password" }] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 },
  ingress: { hostname: "shop.example.com", entry: "cloudflare-lb" },
});

// 3티어 v2: web → api → db, + 예약 잡 (api 와 같은 SA)
const svc = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "service",
  props: {
    runtime: "k8s", origin: { runtime: "k8s", product: "eks" }, namespace: "shop",
    image: { source: "registry", repository: `ghcr.io/demo/${id}`, digest: D(id === "web" ? "b" : "c") },
    resources: { request: { cpuMilli: 250, memMiB: 512 } }, env: [], serviceAccount: id, replicas: { min: 2, max: 2 },
    ports: [{ port: 8080, protocol: "TCP" }],
    endpoints: [{ name: id, type: "ClusterIP", ports: [{ port: 80, targetPort: 8080, protocol: "TCP" }] }],
    ...extra,
  },
});
const TIER3 = (): AppSpecV2 => AppSpecV2.parse({
  schemaVersion: "2", app: { name: "shop" },
  components: [
    svc("web", { env: [{ name: "API_URL", fromLink: { to: "api", output: "url" } }],
      probes: { readiness: { type: "http", path: "/", port: 8080 } } }),
    svc("api", {
      env: [
        { name: "DB_HOST", fromLink: { to: "db", output: "host" } },
        { name: "JDBC", template: "jdbc:postgresql://${db.host}:5432/shop?sslmode=require" },
        { name: "DATABASE_PASSWORD", fromSecret: { secret: "shop-db", key: "password" } },
        { name: "LOG_LEVEL", value: "info" },
      ],
      scale: { targetCpuPct: 70 }, replicas: { min: 2, max: 4 },
    }),
    { id: "nightly", kind: "job", props: {
      image: { source: "registry", repository: "ghcr.io/demo/api", digest: D("c") }, resources: {}, env: [], serviceAccount: "api",
      schedule: "0 3 * * *", concurrencyPolicy: "Forbid" } },
    { id: "db", kind: "postgres", props: { majorVersion: "16", storageGb: 50, compute: { cpuMilli: 2000, memMiB: 4096 }, parameters: { max_connections: "200" } } },
  ],
  links: [
    { from: "web", to: "api", intent: "call" },
    { from: "api", to: "db", intent: "connect" },
    { from: "nightly", to: "db", intent: "connect" },
  ],
  entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], tls: { mode: "terminate" },
    routes: [{ matches: [{ path: { type: "PathPrefix", value: "/api" } }], backends: [{ to: "api", port: 80, weight: 1 }] },
      { matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "web", port: 80, weight: 1 }] }] }] },
  posture: { permissions: [], network: [{ scope: "namespace", namespace: "shop", mode: "mirror", policies: [], default: "allow-all" }] },
});
const parseJson = (v: unknown) => JSON.parse(String(v));
const CLOUD = ["aws", "gcp"] as const;

test("대응표: 데모 v1 → upconvertV1 → v2 Terraform 변수가 v1 변수와 뜻이 같다 (aws·gcp·onprem)", () => {
  const v2 = upconvertV1(V1).spec;
  // aws
  {
    const t = T("aws", { accountId: "000000000000" });
    const a = aws.awsAdapter.toTerraform(V1, t).vars, b = awsBuilder().toTerraformV2(v2, t).vars;
    for (const k of ["expected_account_id", "region", "app_name", "tenant_id", "cluster_name", "vpc_id", "db_subnet_ids_json", "k8s_namespace", "app_role_boundary_arn"])
      assert.equal(b[k], a[k], `aws ${k}`);
    const [pg] = parseJson(b.postgres_json), [id] = parseJson(b.identity_json);
    assert.equal(pg.name, a.name_db_instance);
    assert.equal(pg.major_version, a.db_engine_version);
    assert.equal(pg.storage_gb, a.db_allocated_storage);
    assert.equal(pg.instance_class, null, "v1 db.t4g.micro = 모듈 기본 (null)");
    assert.equal(a.db_instance_class, "db.t4g.micro");
    assert.equal(id.name, a.name_app_role, "앱 이름 = 서비스 id 면 v1 역할 이름 그대로");
    assert.equal(id.secret_names_json, a.secret_names_json);
    assert.equal(parseJson(b.postgres_json).length > 0, a.db_enabled);
    assert.deepEqual(parseJson(pg.allow_from_json), [id.id], "connect 의존성 신원 = DB 비밀 읽기");
  }
  // gcp
  {
    const t = T("gcp", { projectId: "p-1" });
    const a = gcp.gcpAdapter.toTerraform(V1, t).vars, b = targetBuilderFor("gcp").toTerraformV2(v2, t).vars;
    for (const k of ["project_id", "region", "app_name", "tenant_id", "k8s_namespace", "network_id", "cluster_name", "cluster_location"])
      assert.equal(b[k], a[k], `gcp ${k}`);
    const [pg] = parseJson(b.postgres_json), [id] = parseJson(b.identity_json);
    assert.equal(pg.name, a.name_db_instance);
    assert.equal(`POSTGRES_${pg.major_version}`, a.db_version);
    assert.equal(pg.storage_gb, a.db_disk_gb);
    assert.equal(id.name, a.name_app_sa);
    assert.equal(id.secret_names_json, a.secret_ids_json);
  }
  // onprem
  {
    const t = T("onprem");
    const a = onprem.onpremAdapter.toTerraform(V1, t).vars, b = targetBuilderFor("onprem").toTerraformV2(v2, t).vars;
    for (const k of ["kube_context", "app_name", "tenant_id", "k8s_namespace"]) assert.equal(b[k], a[k], `onprem ${k}`);
    const [ns] = parseJson(b.namespace_json);
    assert.equal(ns.quota_cpu_m, a.quota_cpu_m);
    assert.equal(ns.quota_memory_mi, a.quota_memory_mi);
  }
});
const awsBuilder = () => targetBuilderFor("aws");

test("결정성: 같은 입력이면 같은 변수·값 (두 번 부르고 components 순서 뒤집어도 같음)", () => {
  for (const p of ["aws", "gcp", "onprem"] as const) {
    const b = targetBuilderFor(p), t = T(p);
    const s1 = TIER3(), s2 = TIER3();
    s2.components.reverse(); s2.links.reverse();
    assert.deepEqual(b.toTerraformV2(s1, t), b.toTerraformV2(s2, t), p);
    assert.deepEqual(b.toWorkloadValues(s1, {}, t), b.toWorkloadValues(s2, {}, t), p);
    assert.deepEqual(b.operateActionsV2(s1, "apply"), b.operateActionsV2(s2, "apply"), p);
  }
});

test("3티어 스냅숏 (aws): 루트 변수·인스턴스·workloads 값", () => {
  const b = awsBuilder(), t = T("aws", { accountId: "000000000000" }), s = TIER3();
  const tf = b.toTerraformV2(s, t);
  assert.equal(tf.root.path, "infra/modules/aws/root");
  assert.deepEqual(tf.modules.map((m) => m.path), ["infra/modules/aws/kinds/identity", "infra/modules/aws/kinds/namespace", "infra/modules/aws/kinds/postgres"]);
  assert.deepEqual(tf.instances.map((i) => `${i.kind}:${i.id}`), ["identity:api", "identity:web", "namespace:app-shop", "postgres:db"]);
  for (const i of tf.instances) ModuleInstance.parse(i);
  const pg = parseJson(tf.vars.postgres_json);
  assert.equal(pg.length, 1);
  assert.equal(pg[0].instance_class, "db.t4g.medium", "compute 2vCPU·4GiB → 가장 가까운 이상 등급");
  assert.equal(pg[0].storage_gb, 50);
  assert.equal(pg[0].parameters_json, `{"max_connections":"200"}`);
  assert.equal(pg[0].logical_replication, true);
  assert.deepEqual(parseJson(pg[0].allow_from_json), ["api"], "api·nightly 는 같은 SA → 신원 하나");
  const ids = parseJson(tf.vars.identity_json);
  assert.deepEqual(ids.map((i: { id: string; service_account: string }) => [i.id, i.service_account]), [["api", "api"], ["web", "web"]]);
  assert.deepEqual(parseJson(ids[0].secret_names_json), ["shop-db"]);
  for (const [k, schema] of [["postgres_json", TF_KIND_VARS.postgres], ["identity_json", TF_KIND_VARS.identity], ["namespace_json", TF_KIND_VARS.namespace]] as const)
    for (const x of parseJson(tf.vars[k])) schema.parse(x);

  const v = b.toWorkloadValues(s, {}, t) as Record<string, any>;
  assert.equal(v.irVersion, "2");
  assert.equal(v.namespace, "app-shop");
  assert.deepEqual(v.workloads.map((w: { id: string; kind: string }) => `${w.kind}:${w.id}`), ["service:api", "job:nightly", "service:web"]);
  const api = v.workloads[0];
  assert.deepEqual(api.env, [
    { name: "DB_HOST", value: "<tf-output:link.db.host>" },
    { name: "JDBC", value: "jdbc:postgresql://<tf-output:link.db.host>:5432/shop?sslmode=require" },
    { name: "DATABASE_PASSWORD", valueFrom: { secretKeyRef: { name: "shop-db", key: "password" } } },
    { name: "LOG_LEVEL", value: "info" },
  ]);
  assert.deepEqual(api.replicas, { min: 2, max: 4 });
  assert.deepEqual(api.scale, { targetCpuPct: 70 });
  assert.deepEqual(api.resources, { requests: { cpu: "250m", memory: "512Mi" } });
  assert.match(api.image.ref, /^000000000000\.dkr\.ecr\.ap-northeast-2\.amazonaws\.com\/platform\/11111111-1111-4111-8111-111111111111\/api@sha256:c{64}$/);
  const web = v.workloads[2];
  assert.deepEqual(web.env, [{ name: "API_URL", value: "http://api.app-shop.svc" }], "서비스끼리 주소 = 도착 Service DNS (80 이면 포트 생략)");
  const job = v.workloads[1];
  assert.equal(job.schedule, "0 3 * * *");
  assert.equal(job.concurrencyPolicy, "Forbid");
  assert.equal("resources" in job, false, "요청량 없으면 resources 키 없음");
  assert.deepEqual(v.externalSecrets.secrets, [{ name: "shop-db", remoteKey: "platform/11111111-1111-4111-8111-111111111111/shop/shop-db", keys: ["password"] }]);
  assert.deepEqual(v.postgres, [{ id: "db", mode: "external", host: "<tf-output:link.db.host>", port: 5432, passwordSecret: "<tf-output:db_master_secret_arn>", passwordProperty: "password" }]);
  assert.deepEqual(v.ingress.hosts, [{ hostnames: ["shop.example.com"], tls: true, paths: [
    { path: "/api", pathType: "Prefix", service: "api", port: 80, workload: "api" },
    { path: "/", pathType: "Prefix", service: "web", port: 80, workload: "web" }] }]);
  assert.deepEqual(v.warnings, []);
  // apply 뒤 진짜 값이 오면 자리표시 대신 값
  const filled = b.toWorkloadValues(s, { "link.db.host": "shop.rds.local" }, t) as Record<string, any>;
  assert.equal(filled.workloads[0].env[0].value, "shop.rds.local");
});

test("3티어 (gcp·onprem): GSA 표시는 신원별, 온프레 DB 는 CNPG 주소를 직접 계산", () => {
  const g = targetBuilderFor("gcp").toWorkloadValues(TIER3(), {}, T("gcp")) as Record<string, any>;
  assert.deepEqual(g.workloads[1].serviceAccount, { name: "api", create: true, annotations: { "iam.gke.io/gcp-service-account": "<tf-output:identity.api.gsa_email>" } }, "nightly 는 api 신원");
  const o = targetBuilderFor("onprem").toWorkloadValues(TIER3(), {}, T("onprem")) as Record<string, any>;
  assert.equal(o.workloads[0].env[0].value, "shop-db-rw");
  assert.equal(o.postgres[0].mode, "cnpg");
  assert.equal(o.postgres[0].name, "shop-db");
  const otf = targetBuilderFor("onprem").toTerraformV2(TIER3(), T("onprem"));
  assert.equal(otf.vars.netpol_json, "[]", "allow-all = 정책 안 만듦 (mirror)");
  assert.deepEqual(parseJson(otf.vars.namespace_json)[0], { name: "app-shop", quota_cpu_m: null, quota_memory_mi: null }, "잡 요청량이 없으면 할당량을 지어내지 않음 (null = 안 만듦)");
});

test("거부: capability 밖 종류(cache)·permissions·as-declared 네트워크·빌드 이미지는 UNSUPPORTED_V2", () => {
  const cases: Array<[string, (s: AppSpecV2) => void, string]> = [
    ["cache", (s) => { s.components.push(ComponentV2.parse({ id: "cache", kind: "cache", props: { engine: "redis", memoryMiB: 512, tls: true, auth: true } })); }, "kind.cache.redis"],
    ["permissions", (s) => { s.posture.permissions.push({ subject: "api", source: "iam:r", effect: "Allow", actions: ["s3:*"], resources: ["*"], mode: "mirror" }); }, "posture.permissions"],
    ["netpol", (s) => { s.posture.network[0] = { scope: "namespace", namespace: "shop", mode: "mirror", policies: ["deny"], default: "as-declared" }; }, "posture.networkPolicy"],
    ["build", (s) => { (s.components[0]!.props as any).image = { source: "build", repository: "x", digest: null }; }, "image.build"],
    ["2 db", (s) => { s.components.push(ComponentV2.parse({ id: "db2", kind: "postgres", props: { majorVersion: "16", storageGb: 20 } })); }, "kind.postgres.multi"],
    ["grants", (s) => { s.links[0] = { ...s.links[0]!, grants: [{ effect: "Allow", actions: ["x"], resources: ["y"] }] }; }, "render.grants"],
  ];
  for (const p of ["aws", "gcp", "onprem"] as const) for (const [name, mut, cap] of cases) {
    const s = TIER3(); mut(s);
    assert.ok(requirementsV2(s).includes(cap), `${p} ${name} 요구`);
    for (const f of [() => targetBuilderFor(p).toTerraformV2(s, T(p)), () => targetBuilderFor(p).toWorkloadValues(s, {}, T(p))])
      assert.throws(f, (e: unknown) => e instanceof AdapterError && e.code === UNSUPPORTED_V2 && e.message.includes(cap), `${p} ${name}`);
  }
  // azure-mock 은 껍데기
  assert.throws(() => targetBuilderFor("azure_mock").toTerraformV2(TIER3(), T("azure_mock")), (e: unknown) => e instanceof AdapterError && e.code === UNSUPPORTED_V2);
  assert.deepEqual(targetBuilderFor("azure_mock").operateActionsV2(TIER3(), "apply"), []);
});

test("거부: 프로브·요청량이 없는 서비스에는 probes·resources 키가 아예 없다 (지어내지 않음)", () => {
  const s = TIER3();
  for (const p of ["aws", "gcp", "onprem"] as const) {
    const v = targetBuilderFor(p).toWorkloadValues(s, {}, T(p)) as Record<string, any>;
    const api = v.workloads.find((w: { id: string }) => w.id === "api");
    assert.equal("probes" in api, false, p);
    const web = v.workloads.find((w: { id: string }) => w.id === "web");
    assert.deepEqual(web.probes, { readiness: { type: "http", path: "/", port: 8080 } }, "있으면 그대로");
    assert.equal(JSON.stringify(v).includes("/healthz"), false, "v1 기본 /healthz 를 안 넣음");
  }
});

test("40자 IR id → 실행 역할·SA 이름은 boundedName (aws 64, gcp 30, app- 접두어)", () => {
  const long = "a" + "b".repeat(39);
  const s = TIER3();
  (s.components.find((c) => c.id === "api")!.props as any).serviceAccount = "api";
  s.components.push(ComponentV2.parse({ ...svc(long), props: { ...svc(long).props, serviceAccount: long, endpoints: undefined } }));
  for (const [p, max] of [["aws", 64], ["gcp", 30]] as const) {
    const ids = parseJson(targetBuilderFor(p).toTerraformV2(s, T(p)).vars.identity_json) as Array<{ id: string; name: string }>;
    const row = ids.find((i) => i.id === long)!;
    assert.ok(row.name.startsWith("app-") && row.name.length <= max, `${p} ${row.name}`);
    assert.notEqual(row.name, `app-${long}`);
    assert.equal(new Set(ids.map((i) => i.name)).size, ids.length, "이름 겹침 없음");
  }
});

test("권한: v2 operateActionsV2 = 켜진 종류 행의 합, upconvert 판은 v1 operateActions 와 같다 (세션 정책 파일 안 바뀜)", () => {
  const v2 = upconvertV1(V1).spec;
  for (const p of ["aws", "gcp", "onprem"] as const) for (const purpose of ["plan", "apply", "destroy"] as const)
    assert.deepEqual(targetBuilderFor(p).operateActionsV2(v2, purpose), (p === "aws" ? aws.operateActions(V1, purpose) : p === "gcp" ? gcp.operateActions(V1, purpose) : onprem.operateActions(V1, purpose)), `${p} ${purpose}`);
  // 잡이 있으면 온프레는 CronJob 권한이 더 생김
  assert.ok(targetBuilderFor("onprem").operateActionsV2(TIER3(), "apply").includes("batch/cronjobs:create"));
});

test("칸 대응표: IR v2 의 모든 리소스 칸은 render / info / block 중 하나로 분류돼 있다 (조용히 버리는 칸 없음)", () => {
  for (const opt of (ComponentV2 as any).options) {
    const kind = opt.shape.kind.value as string;
    const keys = Object.keys(opt.shape.props.shape);
    for (const k of keys) assert.ok(V2_FIELD_COVERAGE[kind]?.[k], `${kind}.${k} 분류 없음`);
  }
  for (const k of Object.keys((AppSpecV2 as any).shape)) assert.ok(V2_FIELD_COVERAGE.spec?.[k], `spec.${k} 분류 없음`);
});

test("사람 확인: 출발 DB 방화벽을 못 읽었거나 CIDR 이 아닌 원본이면 needsHuman, 공개 + CIDR 은 mirror", () => {
  const s = TIER3();
  s.posture.network.push({ scope: "component", subject: "db", mode: "mirror", ingress: "unknown", public: null });
  const caps = targetBuilderFor("aws").capabilities();
  assert.deepEqual(v2Blockers(s, caps).unsupported, []);
  assert.equal(v2Blockers(s, caps).needsHuman.length, 1);
  const s2 = TIER3();
  s2.posture.network.push({ scope: "component", subject: "db", mode: "mirror", ingress: [{ from: "203.0.113.7/32", port: 5432 }, { from: "sg-123" }], public: true });
  assert.match(v2Blockers(s2, caps).needsHuman.join(), /sg-123/);
  const pg = parseJson(targetBuilderFor("aws").toTerraformV2(s2, T("aws")).vars.postgres_json)[0];
  assert.equal(pg.public, true);
  assert.deepEqual(parseJson(pg.peer_cidrs_json), ["203.0.113.7/32"]);
  assert.equal(pg.public_subnet_ids_json, "<env:dbPublicSubnetIdsJson>");
});

test("라우팅: 가중치 나누기·헤더 매치·와일드카드는 경고 줄로 남는다", () => {
  const s = TIER3();
  s.entry!.hosts[0]!.hostnames.push("*.shop.example.com");
  s.entry!.hosts[0]!.routes[1] = { matches: [{ path: { type: "Exact", value: "/" }, headers: [{ name: "x", value: "1" }] }],
    backends: [{ to: "web", port: 80, weight: 9 }, { to: "api", port: 80, weight: 1 }] };
  const v = targetBuilderFor("gcp").toWorkloadValues(s, {}, T("gcp")) as Record<string, any>;
  assert.equal(v.warnings.length, 3);
  assert.equal(v.ingress.hosts[0].paths[1].pathType, "Exact");
  assert.equal(v.ingress.className, "gce");
});

test("DB 등급 고르기 (H-A6 기본): compute 없으면 null, 있으면 같거나 큰 등급", () => {
  assert.equal(rdsClassFor(undefined), null);
  assert.equal(rdsClassFor({ cpuMilli: null, memMiB: null }), null);
  assert.equal(rdsClassFor({ cpuMilli: 500, memMiB: 1024 }), "db.t4g.micro");
  assert.equal(rdsClassFor({ cpuMilli: 4000, memMiB: 8192 }), "db.m6g.xlarge");
  assert.equal(cloudSqlTierFor(undefined), null);
  assert.equal(cloudSqlTierFor({ cpuMilli: 2000, memMiB: 4096 }), "db-custom-2-4096");
  assert.equal(cloudSqlTierFor({ cpuMilli: 3000, memMiB: 100 }), "db-custom-4-3840");
  for (const p of CLOUD) assert.ok(targetBuilderFor(p).capabilities().includes("kind.postgres.16"));
});
