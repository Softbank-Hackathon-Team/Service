// INCL: 클러스터 안(k8s 워크로드)으로 띄운 MinIO·Redis/Valkey·RabbitMQ·Kafka·Postgres → IR 데이터 자원(inCluster) + 앱 링크 + 데이터 복사 검토.
//   도착 Builder·계획 대조는 renderViewV2 로 그 자원을 빼고 워크로드 그대로 그림
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { detectInCluster } from "../src/import/in-cluster-data.js";
import { renderViewV2, requirementsV2, v2Blockers, targetBuilderFor } from "../src/index.js";

type Raw = Record<string, any>;
const D = "sha256:" + "ab".repeat(32);
const inv = (items: Raw[]): RawInventory => ({ provider: "k8s", coverage: {}, items } as unknown as RawInventory);
const dep = (name: string, image: string, o: { env?: Raw[]; ports?: number[]; labels?: Record<string, string>; memory?: string } = {}): Raw & { kind: string } => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name, ...(o.labels ?? {}) } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{
    name, image, ports: (o.ports ?? [8080]).map((p) => ({ containerPort: p })), env: o.env ?? [],
    ...(o.memory ? { resources: { limits: { memory: o.memory } } } : {}) }] } } },
});
const svc = (name: string, port: number): Raw => ({ kind: "k8s.service", metadata: { name, namespace: "shop" },
  spec: { type: "ClusterIP", selector: { app: name }, ports: [{ port, targetPort: port, protocol: "TCP" }] } });

const APP = () => [
  dep("api", "ghcr.io/demo/api:1.0", { env: [
    { name: "REDIS_URL", value: "redis://cache.shop.svc.cluster.local:6379/0" },
    { name: "S3_ENDPOINT", value: "http://minio:9000" },
    { name: "AMQP_HOST", value: "mq.shop.svc" },
    { name: "KAFKA_BROKERS", value: "kafka:9092" },
    { name: "PGHOST", value: "db.shop.svc.cluster.local" },
  ] }),
  dep("cache", "docker.io/library/redis:7.2-alpine", { ports: [6379], memory: "512Mi" }), svc("cache", 6379),
  dep("minio", "quay.io/minio/minio:RELEASE.2024-01-01T00-00-00Z", { ports: [9000, 9001] }), svc("minio", 9000),
  dep("mq", "rabbitmq:3.13-management", { ports: [5672, 15672] }), svc("mq", 5672),
  dep("kafka", "bitnami/kafka:3.7", { ports: [9092] }), svc("kafka", 9092),
  dep("db", "postgres:16.3", { ports: [5432] }), svc("db", 5432),
];

test("INCL: 이미지 이름으로 다섯 종류를 알아봄 (0.9), 도구 이미지(redis-exporter)는 아님", () => {
  const p = (img: string) => detectInCluster(dep("x", img))?.product ?? null;
  assert.equal(p("redis:7"), "redis");
  assert.equal(p("valkey/valkey:8.0"), "valkey");
  assert.equal(p("quay.io/minio/minio:latest"), "minio");
  assert.equal(p("rabbitmq:3-management"), "rabbitmq");
  assert.equal(p("confluentinc/cp-kafka:7.6.0"), "kafka");
  assert.equal(p("bitnami/postgresql:16"), "postgres");
  assert.equal(detectInCluster(dep("x", "redis:7"))!.confidence, 0.9);
  // 거부: 이름이 비슷한 도구·평범한 앱
  assert.equal(p("oliver006/redis_exporter:v1"), null);
  assert.equal(p("rediscommander/redis-commander:latest"), null);
  assert.equal(p("ghcr.io/demo/api:1.0"), null);
});

test("INCL: 라벨·포트로만 알아보면 0.6 (사람 확인), 9000 하나만으로는 MinIO 로 안 봄", () => {
  const byLabel = detectInCluster(dep("x", "my.registry/cache-img:1", { labels: { "app.kubernetes.io/name": "redis" } }))!;
  assert.deepEqual([byLabel.product, byLabel.confidence], ["redis", 0.6]);
  const byPort = detectInCluster(dep("x", "my.registry/mq:1", { ports: [5672] }))!;
  assert.deepEqual([byPort.product, byPort.confidence], ["rabbitmq", 0.6]);
  assert.equal(detectInCluster(dep("x", "my.registry/php:1", { ports: [9000] })), null);
});

test("INCL: 앱 env 가 가리키는 클러스터 안 데이터 서비스 → 데이터 자원 + 링크 + 데이터 복사 검토, 워크로드·env 글자는 그대로", () => {
  const { result } = normalizeV2(inv(APP()));
  const spec = AppSpecV2.parse(result.spec);
  const byProduct = (p: string) => spec.components.find((c) => (c.props as Raw).inCluster?.product === p) as unknown as { id: string; kind: string; props: Raw };
  const cache = byProduct("redis"), minio = byProduct("minio"), mq = byProduct("rabbitmq"), kafka = byProduct("kafka"), db = byProduct("postgres");
  assert.deepEqual([cache.kind, minio.kind, mq.kind, kafka.kind, db.kind], ["cache", "objectStore", "queue", "queue", "postgres"]);
  assert.deepEqual(cache.props.inCluster, { workload: "cache", product: "redis" });
  assert.equal(cache.props.engine, "redis"); assert.equal(cache.props.version, "7.2"); assert.equal(cache.props.memoryMiB, 512);
  assert.equal(kafka.props.model, "topic"); assert.equal(mq.props.model, "queue");
  assert.equal(db.props.majorVersion, "16");
  // 워크로드는 그대로 남음
  for (const w of ["cache", "minio", "mq", "kafka", "db"]) assert.ok(spec.components.some((c) => c.id === w && c.kind === "service"), w);
  // 앱 → 데이터 자원 링크 (캐시·DB = connect, 버킷·큐 = readwrite + 검토)
  const link = (to: string) => spec.links.find((l) => l.from === "api" && l.to === to);
  assert.equal(link(cache.id)?.intent, "connect");
  assert.equal(link(db.id)?.intent, "connect");
  for (const x of [minio, mq, kafka]) assert.equal(link(x.id)?.intent, "readwrite", x.id);
  assert.equal(result.fieldMeta[`links.api->${minio.id}`]?.needs_review, true);
  // 앱 → 워크로드 링크·env 다시 쓰기(fromLink·template 은 워크로드를 가리킴)도 그대로
  assert.equal(link("cache")?.intent, "call");
  const api = spec.components.find((c) => c.id === "api")!;
  const redisEnv = (api.props as Raw).env.find((e: Raw) => e.name === "REDIS_URL");
  assert.ok(JSON.stringify(redisEnv).includes("${cache.host}") || redisEnv.fromLink?.to === "cache", JSON.stringify(redisEnv));
  // 검토 줄: 알아본 근거(0.9) + 데이터 복사 필요
  assert.equal(result.fieldMeta[`components.${cache.id}.inCluster`]?.confidence, 0.9);
  assert.match(result.fieldMeta[`components.${cache.id}.dataCopy`]!.rationale!, /데이터 복사 필요/);
  assert.equal(result.fieldMeta[`components.${cache.id}.dataCopy`]!.needs_review, true);
  const chk = checkV2(spec);
  assert.deepEqual(chk.errors, []);
  assert.ok(chk.reviews.some((r) => r.startsWith(`${cache.id} 는 클러스터 안 redis`) && /데이터 복사 필요/.test(r)), chk.reviews.join("\n"));
});

test("INCL: 도착 Builder·계획 대조는 클러스터 안 데이터 자원을 빼고 워크로드 그대로 (관리형 캐시·버킷을 새로 요구하지 않음)", () => {
  const spec = AppSpecV2.parse(normalizeV2(inv(APP())).result.spec);
  const view = renderViewV2(spec);
  assert.ok(view.components.every((c) => !(c.props as Raw).inCluster));
  assert.ok(view.links.every((l) => typeof l.to !== "string" || view.components.some((c) => c.id === l.to)));
  const req = requirementsV2(spec);
  for (const k of ["kind.cache.redis", "kind.objectStore", "kind.queue", "kind.postgres.16"]) assert.ok(!req.includes(k), `${k} 요구: ${req.join()}`);
  assert.deepEqual(requirementsV2(spec), requirementsV2(view));
  const b = v2Blockers(spec, targetBuilderFor("onprem").capabilities());
  assert.ok(!b.unsupported.some((x) => /cache|objectStore|queue|postgres/.test(x)), b.unsupported.join());
  // 렌더(온프레 Terraform 입력)에도 데이터 자원 id 가 안 나옴
  const tf = JSON.stringify(targetBuilderFor("onprem").toTerraformV2(spec, { provider: "onprem", region: "local", accountId: "lab", namespace: "app-shop" } as never));
  const twins = spec.components.filter((c) => (c.props as Raw).inCluster).map((c) => c.id);
  for (const id of twins) assert.ok(!tf.includes(`"${id}"`), id);
});

test("INCL 거부: inCluster.workload 가 없는 워크로드를 가리키면 checkV2 오류", () => {
  const spec = AppSpecV2.parse(normalizeV2(inv(APP())).result.spec);
  const bad = { ...spec, components: spec.components.map((c) => (c.props as Raw).inCluster?.product === "redis"
    ? { ...c, props: { ...c.props, inCluster: { workload: "nope", product: "redis" } } } : c) } as AppSpecV2;
  assert.ok(checkV2(bad).errors.some((e) => /inCluster\.workload 가 service 아님: nope/.test(e)));
});

test("INCL: 아무도 안 가리키는 클러스터 안 캐시는 경계 밖으로 (워크로드는 남음)", () => {
  const { result } = normalizeV2(inv([dep("api", "ghcr.io/demo/api:1.0"), dep("cache", "redis:7", { ports: [6379] }), svc("cache", 6379)]));
  assert.ok(result.spec.components.some((c) => c.id === "cache" && c.kind === "service"));
  assert.ok(!result.spec.components.some((c) => c.kind === "cache"));
  assert.ok(result.outOfBoundary?.some((o) => o.kind === "cache"));
});
