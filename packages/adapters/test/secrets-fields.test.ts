// T1·SC-1·CA-1·F-1·G-1·A-1·PR-1: 비밀 표·짝 추론, 못 읽은 종류 검토 줄, 자원 이름표·GPU 막기, 노드 CPU 종류 대조, 프로브 칸 전부
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, ImportResultV2, SECRET_TYPE_REQUIRED_KEYS, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { targetBuilderFor, v2Blockers } from "../src/index.js";

const D = "sha256:" + "ab".repeat(32);
const NS = "shop";
type Raw = Record<string, any>;
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items });
const dep = (name: string, c: Raw = {}, extra: Raw = {}): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name } }, ...extra,
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env: [], ...c }] } } },
});
const cnpg = (name: string): Raw => ({ kind: "cnpg.cluster", metadata: { name, namespace: NS }, spec: { instances: 1, imageName: "ghcr.io/cloudnative-pg/postgresql:16", storage: { size: "10Gi" } } });
const comp = (spec: AppSpecV2, id: string) => spec.components.find((c) => c.id === id) as unknown as { props: Raw };
const caps = (p: "aws" | "gcp" | "onprem") => targetBuilderFor(p).capabilities();

test("T1 정상: DB 주소 env 와 접두어가 같은 비밀번호 키 → pairedWith(postgres) 0.9 검토 표시, 나머지 키는 짝 없음, type Opaque", () => {
  const api = dep("shop-api", { env: [
    { name: "DB_HOST", value: "shop-db-rw.shop.svc" },
    { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "shop-db-app", key: "password" } } },
    { name: "API_KEY", valueFrom: { secretKeyRef: { name: "shop-keys", key: "api-key" } } },
  ] });
  const { result } = normalizeV2(inv([api, cnpg("shop-db")]));
  assert.equal(ImportResultV2.safeParse(result).success, true, JSON.stringify(ImportResultV2.safeParse(result).error?.issues?.slice(0, 2)));
  assert.deepEqual(checkV2(result.spec).errors, []);
  assert.deepEqual(result.spec.secrets, [
    { name: "shop-db-app", type: "Opaque", allKeys: false, keys: [{ key: "password", pairedWith: { component: "shop-db", output: "password" } }] },
    { name: "shop-keys", type: "Opaque", allKeys: false, keys: [{ key: "api-key" }] },
  ]);
  const m = result.fieldMeta["secrets.shop-db-app.keys.password.pairedWith"]!;
  assert.equal(m.confidence, 0.9); assert.equal(m.needs_review, true); assert.match(m.rationale!, /DB/);
  assert.equal(result.fieldMeta["secrets.shop-keys.type"]?.needs_review, false, "type 추정은 검토 줄을 안 늘림 (복사 Job 이 필수 키 확인)");
  assert.ok(!JSON.stringify(result).includes("shop-db-rw.shop.svc"), "출발 주소 값이 명세에 안 남음");
});

test("T1·CA-1 거부: 비밀번호 대상이 둘(postgres·AUTH 캐시)인데 이름으로 못 고르면 짝 없이 0.6 / AUTH 끈 캐시는 후보 아님", () => {
  const cache = (auth: boolean): Raw => ({ kind: "elasticache.replicationGroup", ReplicationGroupId: "shop-cache", Engine: "redis", AuthTokenEnabled: auth, TransitEncryptionEnabled: true,
    PrimaryEndpoint: "shop-cache.abc.cache.amazonaws.com" });
  const api = dep("shop-api", { env: [
    { name: "DB_HOST", value: "shop-db-rw.shop.svc" },
    { name: "CACHE_URL", value: "rediss://shop-cache.abc.cache.amazonaws.com:6379" },
    { name: "SECRET_PASSWORD", valueFrom: { secretKeyRef: { name: "app", key: "pw" } } },
    { name: "REDIS_AUTH", valueFrom: { secretKeyRef: { name: "app", key: "redis" } } },
  ] });
  const r = normalizeV2(inv([api, cnpg("shop-db"), cache(true)])).result;
  const cacheId = r.spec.components.find((c) => c.kind === "cache")?.id;
  assert.ok(cacheId && r.spec.links.some((l) => l.to === cacheId), "캐시가 경계 안 + 의존성");
  // REDIS 힌트로 캐시 짝, SECRET_PASSWORD 는 대상 둘 + 접두어·힌트 없음 → 짝 없음 0.6
  const sec = r.spec.secrets!.find((s) => s.name === "app")!;
  assert.deepEqual(sec.keys.find((k) => k.key === "redis")?.pairedWith, { component: cacheId, output: "password" });
  assert.equal(sec.keys.find((k) => k.key === "pw")?.pairedWith, undefined);
  assert.equal(r.fieldMeta["secrets.app.keys.pw.pairedWith"]?.confidence, 0.6);
  // AUTH 끈 캐시는 짝 후보가 아님 → postgres 하나뿐이라 SECRET_PASSWORD 는 postgres 짝
  const r2 = normalizeV2(inv([api, cnpg("shop-db"), cache(false)])).result;
  const sec2 = r2.spec.secrets!.find((s) => s.name === "app")!;
  assert.deepEqual(sec2.keys.find((k) => k.key === "pw")?.pairedWith, { component: "shop-db", output: "password" });
  assert.equal(sec2.keys.find((k) => k.key === "redis")?.pairedWith, undefined);
});

test("SC-1: Ingress tls 비밀 → kubernetes.io/tls, envFrom·secretMounts → allKeys, 필수 키 표는 k8s 규칙과 같음", () => {
  const api = dep("shop-api", { envFrom: [{ secretRef: { name: "bulk" } }], env: [{ name: "CERT", valueFrom: { secretKeyRef: { name: "shop-tls", key: "tls.crt" } } }] });
  const ing: Raw = { kind: "k8s.ingress", metadata: { name: "shop", namespace: NS }, spec: { tls: [{ hosts: ["shop.example.com"], secretName: "shop-tls" }], rules: [] } };
  const { spec } = normalizeV2(inv([api, ing])).result;
  assert.deepEqual(spec.secrets!.map((s) => [s.name, s.type, s.allKeys]), [["bulk", "Opaque", true], ["shop-tls", "kubernetes.io/tls", false]]);
  assert.deepEqual(SECRET_TYPE_REQUIRED_KEYS["kubernetes.io/tls"], ["tls.crt", "tls.key"]);
  assert.equal(SECRET_TYPE_REQUIRED_KEYS["kubernetes.io/basic-auth"], undefined, "basic-auth 는 키 하나만 있어도 k8s 가 받음 → 필수 아님");
});

test("SC-1 거부: checkV2 — 쓰는 비밀이 표에 없음·짝 대상이 postgres·cache 아님·짝인데 binary·키 중복", () => {
  const { spec } = normalizeV2(inv([dep("shop-api", { env: [{ name: "X", valueFrom: { secretKeyRef: { name: "s1", key: "k" } } }] })])).result;
  const bad = structuredClone(spec);
  bad.secrets = [{ name: "s1", type: "Opaque", allKeys: false, keys: [{ key: "k", binary: true, pairedWith: { component: "shop-api", output: "password" } }, { key: "k" }] }];
  const e = checkV2(bad).errors.join("\n");
  assert.match(e, /짝 대상이 postgres·cache 아님/); assert.match(e, /binary/); assert.match(e, /키 중복/);
  bad.secrets = [];
  assert.match(checkV2(bad).errors.join(), /s1 이 secrets 표에 없음/);
  assert.equal(AppSpecV2.safeParse({ ...spec, secrets: [{ name: "s1", type: "Opaque", allKeys: false, keys: [{ key: "k", pairedWith: { component: "x", output: "host" } }] }] }).success, false, "짝 출력은 password 만");
});

test("F-1: 목록을 못 읽은 종류 → unread.<종류> 검토 줄 0.6 (있는데 비어 있음과 구별), 없으면 줄 없음", () => {
  const r = normalizeV2(inv([dep("shop-api"), { kind: "k8s.unread", resource: "HPA", reason: "Forbidden" }])).result;
  assert.deepEqual(r.fieldMeta["unread.HPA"] && { c: r.fieldMeta["unread.HPA"].confidence, n: r.fieldMeta["unread.HPA"].needs_review }, { c: 0.6, n: true });
  assert.deepEqual(r.unmapped, [], "unmapped C 로 세지 않음");
  assert.ok(!Object.keys(normalizeV2(inv([dep("shop-api")])).result.fieldMeta).some((k) => k.startsWith("unread.")));
});

test("PR-1: 프로브 칸 전부 (timeout·successThreshold·종료 유예·httpGet 헤더·grpc service)", () => {
  const api = dep("shop-api", {
    livenessProbe: { httpGet: { path: "/healthz", port: 8080, httpHeaders: [{ name: "X-Probe", value: "1" }] }, timeoutSeconds: 5, successThreshold: 1, failureThreshold: 3, terminationGracePeriodSeconds: 20 },
    readinessProbe: { grpc: { port: 9090, service: "shop.Health" }, timeoutSeconds: 3, successThreshold: 2 },
  });
  const p = comp(normalizeV2(inv([api])).result.spec, "shop-api").props.probes;
  assert.deepEqual(p.liveness, { type: "http", path: "/healthz", port: 8080, headers: [{ name: "X-Probe", value: "1" }], failureThreshold: 3, timeoutSec: 5, successThreshold: 1, terminationGracePeriodSec: 20 });
  assert.deepEqual(p.readiness, { type: "grpc", port: 9090, service: "shop.Health", timeoutSec: 3, successThreshold: 2 });
});

test("G-1: GPU·임시 디스크 요청이 extended 로 그대로, 큰 CPU·메모리도 받음 / GPU 노드풀 없는 도착은 계획 단계에서 막음", () => {
  const api = dep("shop-api", { resources: { requests: { cpu: "96", memory: "512Gi", "ephemeral-storage": "10Gi" }, limits: { "nvidia.com/gpu": "1" } } });
  const { result } = normalizeV2(inv([api]));
  assert.equal(ImportResultV2.safeParse(result).success, true, "64코어·256GiB 상한 없음");
  const r = comp(result.spec, "shop-api").props.resources;
  assert.deepEqual(r, { request: { cpuMilli: 96000, memMiB: 524288, extended: { "ephemeral-storage": "10Gi" } }, limit: { cpuMilli: null, memMiB: null, extended: { "nvidia.com/gpu": "1" } } });
  for (const p of ["aws", "gcp", "onprem"] as const)
    assert.match(v2Blockers(result.spec, caps(p)).unsupported.join(), /nvidia\.com\/gpu .*resource\.gpu/, p);
  const noGpu = structuredClone(result.spec);
  (comp(noGpu, "shop-api").props.resources as Raw).limit = undefined;
  delete (comp(noGpu, "shop-api").props.resources as Raw).limit;
  assert.deepEqual(v2Blockers(noGpu, caps("gcp")).unsupported, [], "ephemeral-storage 만이면 막지 않음");
});

test("A-1: 노드 CPU 종류가 nodeArch 로 / arm64 만 돌던 워크로드는 x86 노드풀 도착에서 막고, multi-arch(amd64+arm64)는 통과", () => {
  const arm = normalizeV2(inv([dep("shop-api", {}, { nodeArch: ["arm64"] })])).result;
  assert.deepEqual(comp(arm.spec, "shop-api").props.nodeArch, ["arm64"]);
  assert.match(v2Blockers(arm.spec, caps("gcp")).unsupported.join(), /CPU 종류 arm64 .*amd64/);
  const multi = normalizeV2(inv([dep("shop-api", {}, { nodeArch: ["amd64", "arm64"] })])).result;
  assert.deepEqual(v2Blockers(multi.spec, caps("aws")).unsupported, []);
  const none = normalizeV2(inv([dep("shop-api")])).result;
  assert.equal(comp(none.spec, "shop-api").props.nodeArch, undefined, "못 읽었으면 칸 없음 (지어내지 않음)");
});

test("SC-1: 사람이 켠 binary 는 다시 가져와도 유지 (출발 그대로일 때), 확인·바꾸기 경로가 secrets·unread 를 받음", async () => {
  const { carryHumanEdits } = await import("../src/import/carry.js");
  const { SpecPatchInput } = await import("@svc/contracts");
  const raw = inv([dep("shop-api", { env: [{ name: "KS", valueFrom: { secretKeyRef: { name: "jks", key: "keystore.jks" } } }] })]);
  const base = normalizeV2(raw).result;
  const human = structuredClone(base);
  human.spec.secrets![0]!.keys[0]!.binary = true;
  human.fieldMeta.secrets = { source: "human", confidence: 1, needs_review: false };
  const { result, report } = carryHumanEdits(normalizeV2(raw).result, [{ spec: human.spec, fieldMeta: human.fieldMeta }, { spec: base.spec, fieldMeta: base.fieldMeta }]);
  assert.equal(result.spec.secrets![0]!.keys[0]!.binary, true);
  assert.ok(report.kept.includes("secrets"));
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 1, changes: [{ path: "secrets", value: [] }] }).success, true);
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 1, confirm: ["secrets.shop-db-app.keys.password.pairedWith", "unread.HPA"] }).success, true);
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 1, changes: [{ path: "secretsX", value: [] }] }).success, false);
});

test("G-1 렌더: 확장 자원은 도착 requests·limits 에 같은 이름·같은 글자로 (없으면 키 없음)", async () => {
  const { k8sResources } = await import("../src/target/shared.js");
  assert.deepEqual(k8sResources({ request: { cpuMilli: 500, memMiB: null, extended: { "hugepages-2Mi": "1Gi", "ephemeral-storage": "10Gi" } } }),
    { requests: { cpu: "500m", "ephemeral-storage": "10Gi", "hugepages-2Mi": "1Gi" } });
  assert.equal(k8sResources({ request: { cpuMilli: null, memMiB: null } }), undefined);
});
