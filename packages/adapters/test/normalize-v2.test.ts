// I3a: 원본 → 공통 명세 v2 (normalizeV2) · v2 → v1 투영 (projectV1·rebuildFromV2). 순수 함수 + 가짜 kubectl 로 golden
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, AppSpecV2, ImportResultV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { projectV1, rebuildFromV2 } from "../src/import/project-v1.js";
import { normalizeInventory } from "../src/common/normalize.js";
import { discoverGcp, discoverOnprem } from "../src/discover/index.js";
import { DEMO_INVENTORY_V2, DEMO_SPEC } from "../src/common/fixtures.js";
import type { Exec } from "../src/terraform/real-runner.js";

const D = "sha256:" + "ab".repeat(32);
const NS = "shop";
type Raw = Record<string, any>;
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items });
const dep = (name: string, env: Raw[] = [], extra: Raw = {}): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name } },
  spec: { replicas: 2, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }],
    resources: { requests: { cpu: "300m", memory: "768Mi" } }, readinessProbe: { httpGet: { path: "/healthz", port: 8080 } }, env, ...extra }] } } },
});
const svc = (name: string, sel = name): Raw => ({ kind: "k8s.service", metadata: { name, namespace: NS }, spec: { selector: { app: sel }, ports: [{ name: "http", port: 80, targetPort: 8080 }] } });
const comp = (spec: AppSpecV2, id: string) => spec.components.find((c) => c.id === id) as unknown as { id: string; kind: string; props: Raw } | undefined;
const errorsOf = (spec: AppSpecV2) => checkV2(spec).errors;

// ── 3티어 (데모 v2 원본) ─────────────────────────────
for (const p of ["gcp", "onprem"] as const) {
  test(`3티어 ${p}: 서비스 3 + 작업 1 + postgres 1, 의존성·신뢰도·env 다시 쓰기, Zod·checkV2 통과`, () => {
    const { result, projectionEnv } = normalizeV2(DEMO_INVENTORY_V2[p]!);
    const { spec, fieldMeta, unmapped } = result;
    assert.equal(ImportResultV2.safeParse(result).success, true, JSON.stringify(ImportResultV2.safeParse(result).error?.issues?.slice(0, 3)));
    assert.deepEqual(checkV2(spec), { errors: [], reviews: [], approvals: [] });
    assert.deepEqual(spec.components.map((c) => `${c.kind}:${c.id}`),
      ["service:shop-api", "job:shop-cleanup", "postgres:shop-db", "service:shop-web", "service:shop-worker"]);
    const L = Object.fromEntries(spec.links.map((l) => [`${l.from}->${String(l.to)}`, l.intent]));
    assert.deepEqual(L, { "shop-api->shop-db": "connect", "shop-cleanup->shop-db": "connect", "shop-web->shop-api": "call", "shop-worker->shop-db": "connect" });
    assert.equal(fieldMeta["links.shop-api->shop-db"]?.confidence, 1);        // env 주소 + 비밀 이름
    assert.equal(fieldMeta["links.shop-web->shop-api"]?.confidence, 1);       // 클러스터 안 전체 주소
    // env: 주소 → fromLink / template, 출발 값은 명세에 없음
    const api = comp(spec, "shop-api")!;
    assert.deepEqual(api.props.env, [{ name: "DB_HOST", fromLink: { to: "shop-db", output: "host" } },
      { name: "DATABASE_PASSWORD", fromSecret: { secret: "shop-db", key: "password" } }]);
    assert.deepEqual(comp(spec, "shop-web")!.props.env, [{ name: "API_URL", template: "http://${shop-api.host}" }]);
    // HPA 가 서비스 필드로 접힘, Service 객체 → endpoints, Ingress → 라우팅
    assert.deepEqual(api.props.replicas, { min: 2, max: 6 });
    assert.deepEqual(api.props.scale, { targetCpuPct: 70 });
    assert.equal(api.props.endpoints[0].ports[0].port, 80);
    assert.deepEqual(spec.entry?.hosts[0]?.routes.map((r) => `${r.matches[0]!.path.value}->${r.backends[0]!.to}:${r.backends[0]!.port}`), ["/api->shop-api:80", "/->shop-web:80"]);
    // CronJob 실행 규칙
    const job = comp(spec, "shop-cleanup")!;
    assert.equal(job.props.concurrencyPolicy, "Forbid");
    assert.equal(job.props.backoffLimit, 2);
    // 보안 기준선: NetworkPolicy 없음 = 다 열림 그대로
    assert.deepEqual(spec.posture.network[0], { scope: "namespace", namespace: NS, mode: "mirror", policies: [], default: "allow-all" });
    assert.equal(spec.posture.permissions.length, 0);
    // 설명 없는 이름 추측 연결 없음, unmapped 없음
    assert.ok(!Object.values(fieldMeta).some((m) => m.source === "heuristic:name"));
    assert.deepEqual(unmapped, []);
    // 투영 재료: 원래 env 값은 projectionEnv 에만 (명세·저장 대상엔 없음)
    assert.equal(projectionEnv.workloads["shop-api"]?.env.find((e) => e.name === "DB_HOST")?.value, p === "gcp" ? "10.20.0.5" : "shop-db-rw.shop.svc");
    assert.ok(!JSON.stringify(result).includes(p === "gcp" ? "10.20.0.5\"" : "shop-db-rw.shop.svc\""));
    // projectV1: 지금 v1 모양
    const v1 = projectV1(result, projectionEnv);
    const parsed = AppSpec.parse(v1.spec);
    assert.equal(parsed.app.name, "shop-api");
    assert.equal(parsed.service.replicas, 2);   // R12: HPA 가 있어도 Deployment.spec.replicas
    assert.equal(parsed.ingress.hostname, "shop.example.com");
    assert.deepEqual(parsed.database, { engine: "postgres", majorVersion: "16", storageGb: 20 });
  });
}

test("결정성: 입력 순서를 뒤섞어도 결과가 글자 하나까지 같다", () => {
  const raw = DEMO_INVENTORY_V2.gcp!;
  const a = JSON.stringify(normalizeV2(raw).result);
  assert.equal(JSON.stringify(normalizeV2({ ...raw, items: [...raw.items].reverse() }).result), a);
  assert.equal(JSON.stringify(normalizeV2({ ...raw, items: [...raw.items.slice(4), ...raw.items.slice(0, 4)] }).result), a);
});

// ── PoC 에서 옮긴 시험 (k8s·DB) ─────────────────────
test("id: 워크로드 이름이 겹치면 네임스페이스를 붙인다 (PoC :77)", () => {
  const a = dep("api"), b = dep("api");
  b.metadata.namespace = "admin";
  const { result } = normalizeV2(inv([a, b]));
  assert.deepEqual(result.spec.components.map((c) => c.id), ["admin-api", "shop-api"]);
  assert.deepEqual(errorsOf(result.spec), []);
});

test("없는 걸 만들지 않는다: 프로브·requests 없으면 비워 두고 표시만 (PoC :108)", () => {
  const d = dep("api");
  delete d.spec.template.spec.containers[0].readinessProbe;
  delete d.spec.template.spec.containers[0].resources;
  const { result } = normalizeV2(inv([d]));
  const c = comp(result.spec, "api")!;
  assert.equal(c.props.probes, undefined);
  assert.deepEqual(c.props.resources, {});
  assert.equal(result.fieldMeta["components.api.probes"]?.needs_review, true);
  assert.equal(result.spec.entry, undefined);
  assert.deepEqual(errorsOf(result.spec), []);
});

test("CronJob: 실행 규칙 필드를 옮기고, digest 없으면 checkV2 가 막는다 (PoC :175)", () => {
  const cj: Raw = { kind: "k8s.cronjob", imageDigest: D, metadata: { name: "nightly", namespace: NS },
    spec: { schedule: "0 3 * * *", concurrencyPolicy: "Forbid", timeZone: "Asia/Tokyo",
      jobTemplate: { spec: { backoffLimit: 2, template: { spec: { restartPolicy: "OnFailure", containers: [{ image: "ghcr.io/demo/batch:2", command: ["node", "run.js"] }] } } } } } };
  const { result } = normalizeV2(inv([cj]));
  const j = comp(result.spec, "nightly")!;
  assert.equal(j.kind, "job");
  assert.equal(j.props.concurrencyPolicy, "Forbid");
  assert.equal(j.props.timeZone, "Asia/Tokyo");
  assert.equal(j.props.backoffLimit, 2);
  assert.equal(j.props.restartPolicy, "OnFailure");
  assert.deepEqual(j.props.command, ["node", "run.js"]);
  assert.deepEqual(errorsOf(result.spec), []);
  const noDigest = structuredClone(cj); delete noDigest.imageDigest;
  assert.ok(errorsOf(normalizeV2(inv([noDigest])).result.spec).some((e) => e.includes("digest 아님")));
});

test("R9: digest 없는 Deployment 는 리소스가 아니라 unmapped B", () => {
  const d = dep("api"); d.imageDigest = null;
  const { result } = normalizeV2(inv([d, dep("web")]));
  assert.deepEqual(result.spec.components.map((c) => c.id), ["web"]);
  assert.ok(result.unmapped.some((u) => u.resource === "k8s.deployment:api" && u.grade === "B"));
});

test("Postgres 가 아닌 DB 는 unmapped, 못 읽는 수량은 NaN 이 아니라 null + 0.6 (PoC :224, R3)", () => {
  // BOUNDARY: 앱 경계 안에 들도록 api 가 env 로 pg 를 가리킴 (근거 없는 DB 는 경계 밖)
  const { result } = normalizeV2(inv([dep("api", [{ name: "DB_HOST", value: "pg-rw.shop.svc" }]),
    { kind: "rds.dbInstance", DBInstanceIdentifier: "legacy", Engine: "mysql", EngineVersion: "8.0", AllocatedStorage: 20 },
    { kind: "cnpg.cluster", metadata: { name: "pg", namespace: NS }, spec: { imageName: "x:16", storage: { size: "lots" } } }]));
  assert.ok(result.unmapped.some((u) => u.resource === "rds.dbInstance:legacy" && /mysql/.test(u.reason)));
  const pg = comp(result.spec, "pg")!;
  assert.equal(pg.props.storageGb, null);
  assert.equal(pg.props.majorVersion, "16");
  assert.equal(result.fieldMeta["components.pg.storageGb"]?.confidence, 0.6);
  assert.deepEqual(errorsOf(result.spec), []);   // R3: postgres 필수 필드 없음 → 막지 않고 검토 표시
});

test("R10: CNPG 는 spec.postgresVersion 도 읽는다", () => {
  const { result } = normalizeV2(inv([dep("api", [{ name: "DB_HOST", value: "pg-rw.shop.svc" }]), { kind: "cnpg.cluster", metadata: { name: "pg", namespace: NS }, spec: { postgresVersion: "17", storage: { size: "50Gi" } } }]));
  assert.equal(comp(result.spec, "pg")!.props.majorVersion, "17");
  assert.equal(comp(result.spec, "pg")!.props.storageGb, 50);
});

test("자원 하나가 이상해도 전체가 안 터진다: backend.resource, 깨진 원본 (PoC :236)", () => {
  const { result } = normalizeV2(inv([dep("api"), svc("api"),
    { kind: "k8s.ingress", metadata: { name: "i", namespace: NS }, spec: { rules: [{ host: "a.example.com", http: { paths: [
      { path: "/static", pathType: "Prefix", backend: { resource: { kind: "StorageBucket", name: "s" } } },
      { path: "/", pathType: "Prefix", backend: { service: { name: "api", port: { name: "http" } } } }] } }] } },
    { kind: "rds.dbInstance" }]));
  assert.equal(result.spec.entry?.hosts[0]?.routes.length, 1);
  assert.ok(result.unmapped.some((u) => u.reason.startsWith("backend.resource")));
  assert.ok(result.unmapped.some((u) => u.resource === "rds.dbInstance:?"));
});

test("id: 같은 이름 DB 가 두 리전에 있어도 벤더 고유 ID 로 갈림, 재가져오기에도 그대로 (PoC :340)", () => {
  const rds = (ep: string, arn: string): Raw => ({ kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16", AllocatedStorage: 20, Endpoint: { Address: ep }, DBInstanceArn: arn });
  const items = [rds("a.rds.amazonaws.com", "arn:aws:rds:us-east-1:0:db:shop-db"), rds("b.rds.amazonaws.com", "arn:aws:rds:eu-west-1:0:db:shop-db")];
  const api = dep("api", [{ name: "DB_HOSTS", value: "a.rds.amazonaws.com,b.rds.amazonaws.com" }]);   // BOUNDARY: 둘 다 경계 안
  const one = normalizeV2(inv([api, ...items])).result;
  assert.deepEqual(errorsOf(one.spec), []);
  assert.equal(new Set(one.spec.components.map((c) => c.id)).size, 3);
  const two = normalizeV2(inv([...items].reverse().concat([api])), { previousIds: one.ids }).result;
  assert.deepEqual(two.ids, one.ids);
});

test("라우팅: defaultBackend 는 그 Ingress 호스트에만, Service 가 Deployment 둘을 고르면 둘 다 + 검토 (PoC :349)", () => {
  const a = dep("a"), b = dep("b"), b2 = dep("b-canary");
  b2.spec.template.metadata.labels = { app: "b" };
  const ing = (name: string, host: string, be: string): Raw => ({ kind: "k8s.ingress", metadata: { name, namespace: NS }, spec: { defaultBackend: { service: { name: be } },
    rules: [{ host, http: { paths: [{ path: "/x", pathType: "Prefix", backend: { service: { name: be } } }] } }] } });
  const { result } = normalizeV2(inv([a, b, b2, svc("a"), svc("b"), ing("ia", "a.example.com", "a"), ing("ib", "b.example.com", "b")]));
  const H: Record<string, Array<{ backends: Array<{ to: string }> }>> = Object.fromEntries(result.spec.entry!.hosts.map((h) => [h.hostnames[0], h.routes]));
  assert.deepEqual(H["a.example.com"]!.flatMap((r) => r.backends.map((x) => x.to)), ["a", "a"]);
  assert.deepEqual(H["b.example.com"]![0]!.backends.map((x) => x.to), ["b", "b-canary"]);
  assert.equal(result.fieldMeta["entry.b.example.com.routes[0].backend"]?.confidence, 0.6);
});

test("env 다시 쓰기: 값 일부가 주소면 template, 스킴·포트·경로 그대로, 맨 이름은 0.9", () => {
  const { result } = normalizeV2(inv([
    dep("shop-api", [{ name: "JDBC", value: "jdbc:postgresql://shop-db-rw.shop.svc:5432/shop?sslmode=require" }, { name: "DB_NAME", value: "shop-db-rw" }]),
    { kind: "cnpg.cluster", metadata: { name: "shop-db", namespace: NS }, spec: { postgresVersion: "16", storage: { size: "1Gi" } } }]));
  const env = comp(result.spec, "shop-api")!.props.env;
  assert.deepEqual(env[0], { name: "JDBC", template: "jdbc:postgresql://${shop-db.host}:5432/shop?sslmode=require" });
  assert.deepEqual(env[1], { name: "DB_NAME", value: "shop-db-rw" });   // 맨 이름 shop-db-rw 는 주소 별칭 아님 → 그대로
  assert.deepEqual(errorsOf(result.spec), []);
});

test("거부: 평문 비밀 env 는 v2·v1 둘 다 없고, unmapped B + 검토 표시", () => {
  const raw = inv([dep("shop-api", [{ name: "LOG_LEVEL", value: "info" }, { name: "API_TOKEN", value: "plain-secret-123" }, { name: "DSN", value: "postgres://u:pw@db:5432/x" }])]);
  const { result, projectionEnv } = normalizeV2(raw);
  const s = JSON.stringify(result);
  assert.ok(!s.includes("plain-secret-123") && !s.includes("u:pw@"), "v2 에 평문 비밀 없음");
  assert.ok(result.unmapped.some((u) => u.resource === "env:shop-api.API_TOKEN" && u.grade === "B"));
  assert.equal(result.fieldMeta["components.shop-api.env.API_TOKEN"]?.needs_review, true);
  const v1 = projectV1(result, projectionEnv);
  assert.ok(!JSON.stringify(v1).includes("plain-secret-123") && !JSON.stringify(v1).includes("u:pw@"), "v1 에도 없음");
  assert.deepEqual(v1.spec.service?.env, [{ name: "LOG_LEVEL", value: "info" }]);
  assert.equal(v1.fieldMeta["service.env.API_TOKEN"]?.confidence, 0.6);
});

test("projectV1: 서비스가 없으면 SOURCE_INCOMPLETE, IMPORT_APP 으로 주 서비스를 고른다", () => {
  const empty = normalizeV2(inv([{ kind: "cnpg.cluster", metadata: { name: "pg", namespace: NS }, spec: { postgresVersion: "16", storage: { size: "1Gi" } } }]));
  assert.throws(() => projectV1(empty.result, empty.projectionEnv), (e: { code?: string }) => e.code === "SOURCE_INCOMPLETE");
  const two = normalizeV2(inv([dep("a-svc"), dep("b-svc")]));
  assert.equal(projectV1(two.result, two.projectionEnv).spec.app?.name, "a-svc");
  assert.equal(projectV1(two.result, two.projectionEnv, { mainApp: "b-svc" }).spec.app?.name, "b-svc");
  assert.throws(() => projectV1(two.result, two.projectionEnv, { mainApp: "nope" }), (e: { code?: string }) => e.code === "SOURCE_INCOMPLETE");
});

test("rebuildFromV2: env·secretRefs 는 앞 판 v1 에서, 나머지는 고친 v2 에서 (R15)", () => {
  const { result, projectionEnv } = normalizeV2(DEMO_INVENTORY_V2.onprem!);
  const prev = AppSpec.parse(projectV1(result, projectionEnv).spec);
  const edited = structuredClone(result);
  const api = comp(edited.spec, "shop-api")!;
  api.props.resources = { request: { cpuMilli: 1000, memMiB: 2048 } };
  (comp(edited.spec, "shop-db")!.props).storageGb = 40;
  const r = rebuildFromV2(edited, prev);
  const v1 = AppSpec.parse(r.spec);
  assert.equal(v1.service.cpu, "1");
  assert.equal(v1.service.memory, "2Gi");
  assert.equal(v1.database?.storageGb, 40);
  assert.deepEqual(v1.service.env, prev.service.env);
  assert.deepEqual(v1.service.secretRefs, prev.service.secretRefs);
  assert.equal(v1.app.name, prev.app.name);
  assert.equal(r.fieldMeta["service.cpu"]?.confidence, 1);
  // 빌드 대상 이미지는 v1 로 못 뽑음
  api.props.image = { source: "build", repository: "x", digest: null };
  assert.throws(() => rebuildFromV2(edited, prev), (e: { code?: string }) => e.code === "SPEC_V2_INVALID");
});

// ── golden (R14): 같은 가짜 kubectl JSON → v1 경로 vs v2 경로 + projectV1 ──────────
type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>): Exec {
  return async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    const r = hit[1];
    return { code: r.code ?? 0, stdout: typeof r.out === "string" ? r.out : JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
}
const GD = "sha256:" + "cd".repeat(32);
/** z88 모양 클러스터 원문. env = 주 Deployment 의 env */
function cluster(o: { env?: Raw[]; resources?: Raw | null; probe?: Raw | null; ports?: Raw[] | null; ingressHost?: string | null; lb?: string; extraDeploy?: boolean; image?: string } = {}) {
  const container: Raw = { name: "api", image: o.image ?? "ghcr.io/demo/shop-api:1.4.2" };
  if (o.ports !== null) container.ports = o.ports ?? [{ containerPort: 8080 }];
  if (o.resources !== null) container.resources = o.resources ?? { requests: { cpu: "500m", memory: "1Gi" } };
  if (o.probe !== null) container.readinessProbe = o.probe ?? { httpGet: { path: "/healthz" } };
  container.env = o.env ?? [{ name: "LOG_LEVEL", value: "info" },
    { name: "DATABASE_PASSWORD", valueFrom: { secretKeyRef: { name: "shop-db", key: "password" } } },
    { name: "FROM_CM", valueFrom: { configMapKeyRef: { name: "x", key: "y" } } }];
  const deployments: Raw[] = [
    { kind: "Deployment", metadata: { name: "shop-api", namespace: NS }, spec: { replicas: 2, selector: { matchLabels: { app: "shop-api" } },
      template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [container] } } } },
    { kind: "Deployment", metadata: { name: "coredns", namespace: "kube-system" }, spec: { replicas: 1, template: { spec: { containers: [{ name: "c", image: "x" }] } } } },
  ];
  if (o.extraDeploy) deployments.push({ kind: "Deployment", metadata: { name: "shop-web", namespace: NS }, spec: { replicas: 1, selector: { matchLabels: { app: "shop-web" } },
    template: { metadata: { labels: { app: "shop-web" } }, spec: { containers: [{ name: "web", image: "ghcr.io/demo/shop-web:1", ports: [{ containerPort: 3000 }] }] } } } });
  const services: Raw[] = [{ kind: "Service", metadata: { name: "shop-api", namespace: NS }, spec: { selector: { app: "shop-api" }, ports: [{ port: 80, targetPort: 8080 }] },
    ...(o.lb ? { status: { loadBalancer: { ingress: [{ hostname: o.lb }] } } } : {}) }];
  const ingresses: Raw[] = o.ingressHost === null ? [] : [{ kind: "Ingress", metadata: { name: "shop", namespace: NS }, spec: { rules: [{ host: o.ingressHost ?? "shop.softbank-team-iron.com",
    http: { paths: [{ backend: { service: { name: "shop-api" } } }] } }] } }];
  const pods: Raw[] = [
    { metadata: { name: "shop-api-1", namespace: NS, labels: { app: "shop-api" } }, status: { containerStatuses: [{ name: "api", imageID: `ghcr.io/demo/shop-api@${GD}` }] } },
    { metadata: { name: "shop-web-1", namespace: NS, labels: { app: "shop-web" } }, status: { containerStatuses: [{ name: "web", imageID: `ghcr.io/demo/shop-web@${GD}` }] } },
  ];
  const empty = { out: { items: [] } };
  return [
    [/^kubectl get deployments,services,ingresses/, { out: { items: [...deployments, ...services, ...ingresses] } }],
    [/^kubectl get deployments /, { out: { items: deployments } }],
    [/^kubectl get services /, { out: { items: services } }],
    [/^kubectl get ingresses /, { out: { items: ingresses } }],
    [/^kubectl get pods /, { out: { items: pods } }],
    [/^kubectl get (horizontalpodautoscalers|cronjobs|networkpolicies|serviceaccounts|configmaps) /, empty],
  ] as Array<[RegExp, Reply]>;
}
const onpremDb = (spec: Raw): Array<[RegExp, Reply]> => [
  [/^kubectl get nodes/, { out: { items: [{ metadata: { name: "n1" }, status: { nodeInfo: { kubeletVersion: "v1.31.5+k3s1" }, allocatable: { cpu: "4", memory: "8Gi" } } }] } }],
  [/^kubectl get clusters.postgresql.cnpg.io/, { out: { items: [{ metadata: { name: "shop-db", namespace: NS }, spec }] } }],
];
const gcpRest = (db: Raw): Array<[RegExp, Reply]> => [
  [/^gcloud projects describe finals-demo/, { out: { projectId: "finals-demo" } }],
  [/^gcloud container clusters list/, { out: [{ name: "finals-gke", location: "asia-northeast3", currentMasterVersion: "1.31.4-gke.1" }] }],
  [/^gcloud container clusters get-credentials/, { out: "kubeconfig entry generated" }],
  [/^gcloud sql instances list/, { out: [db] }],
  [/^gcloud (compute networks|compute forwarding-rules|artifacts repositories|secrets) list/, { out: [] }],
];
/** v1 field_meta 를 {confidence, needs_review} 만 남겨 비교 (source 글자는 아무도 비교 안 함, R14) */
const shape = (m: Record<string, { confidence: number; needs_review: boolean }>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { confidence: v.confidence, needs_review: v.needs_review }]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));

const GOLDEN: Array<{ name: string; provider: "onprem" | "gcp"; table: Array<[RegExp, Reply]>; env?: Record<string, string>; except?: string[] }> = [
  { name: "z88 온프레 (CNPG 17.2, 5Gi)", provider: "onprem", table: [...cluster(), ...onpremDb({ imageName: "ghcr.io/cloudnative-pg/postgresql:17.2", storage: { size: "5Gi" }, instances: 1 })] },
  { name: "온프레: requests·프로브 없음 → v1 기본값 500m·1Gi·/healthz + 같은 확신", provider: "onprem",
    table: [...cluster({ resources: null, probe: null }), ...onpremDb({ postgresVersion: "16", storage: { size: "250Gi" } })] },
  { name: "온프레: 단계 올림(300m·768Mi → 500m·1Gi, 0.9) + 평문 비밀 env 0.6", provider: "onprem",
    table: [...cluster({ resources: { requests: { cpu: "300m", memory: "768Mi" } }, env: [{ name: "LOG_LEVEL", value: "info" }, { name: "API_TOKEN", value: "abc" }] }),
      ...onpremDb({ imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "20Gi" } })] },
  { name: "온프레: 포트 없음 → Service targetPort, Ingress 없음 → LB 주소", provider: "onprem",
    table: [...cluster({ ports: null, ingressHost: null, lb: "lb.example.com" }), ...onpremDb({ imageName: "x:16", storage: { size: "1Gi" } })] },
  { name: "온프레: Deployment 둘 + IMPORT_APP", provider: "onprem", env: { IMPORT_APP: "shop-web" },
    table: [...cluster({ extraDeploy: true }), ...onpremDb({ imageName: "x:16", storage: { size: "1Gi" } })] },
  { name: "GCP: Cloud SQL 16, 200GB (v1 은 100 으로 자르고 확신 1 그대로, R13)", provider: "gcp",
    table: [...cluster(), ...gcpRest({ name: "shop-db", databaseVersion: "POSTGRES_16", settings: { dataDiskSizeGb: "200", tier: "db-f1-micro" } })] },
  // v1 은 태그를 split(":")[0] 으로 떼서 레지스트리 포트까지 잘린다(지금 동작). 투영은 원문으로 같은 규칙을 다시 써서 같게 낸다(H-1: v1 그대로).
  // v2 명세 쪽 repository 는 포트를 지킨다 → 아래 별도 확인
  { name: "레지스트리 포트 있는 이미지 (v1 동작 그대로 재현)", provider: "onprem",
    table: [...cluster({ image: "registry.local:5000/shop-api:1.4.2" }), ...onpremDb({ imageName: "x:16", storage: { size: "1Gi" } })] },
];

for (const g of GOLDEN) {
  test(`golden R14: ${g.name} → v1 경로와 v2+projectV1 이 같은 명세·같은 확신`, async () => {
    const exec = fakeExec(g.table);
    const env = { ONPREM_KUBE_CONTEXT: "k3d-test", GCP_PROJECT: "finals-demo", ...(g.env ?? {}) };
    const discover = g.provider === "onprem" ? discoverOnprem : discoverGcp;
    const v1raw = await discover({ exec, env }, { ir: "v1" });
    const v2raw = await discover({ exec, env }, { ir: "v2" });
    const want = normalizeInventory(v1raw, DEMO_SPEC);
    const { result, projectionEnv } = normalizeV2(v2raw);
    assert.deepEqual(checkV2(result.spec).errors, []);
    const got = projectV1(result, projectionEnv, { mainApp: g.env?.IMPORT_APP });
    const wantSpec = structuredClone(want.spec) as Raw, gotSpec = structuredClone(got.spec) as Raw;
    for (const k of g.except ?? []) {
      const [a, b] = k.split(".") as [string, string];
      assert.notDeepEqual(wantSpec[a][b], gotSpec[a][b], `예외 ${k} 는 실제로 달라야 함`);
      delete wantSpec[a][b]; delete gotSpec[a][b];
    }
    assert.deepEqual(gotSpec, wantSpec);
    assert.deepEqual(shape(got.fieldMeta), shape(want.fieldMeta));
    assert.equal(AppSpec.safeParse(got.spec).success, AppSpec.safeParse(want.spec).success);
    if (g.name.startsWith("레지스트리")) assert.equal((comp(result.spec, "shop-api")!.props.image as Raw).repository, "registry.local:5000/shop-api");
  });
}

test("JSON 으로 왕복해도 같은 결과 (저장 → 다시 읽기), AppSpecV2 Zod 통과", () => {
  const { result } = normalizeV2(DEMO_INVENTORY_V2.gcp!);
  const back = JSON.parse(JSON.stringify(result));
  assert.deepEqual(back, result);
  assert.equal(AppSpecV2.safeParse(back.spec).success, true);
});
