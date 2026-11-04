// G3b-4: 앱이 큐·버킷·토픽·캐시 읽기 주소를 흔한 다른 모양으로 적어도 의존성이 생긴다. 바꿀 수 있는 모양은 name·url·host 출력으로, 못 바꾸는 모양은 값 그대로 + 검토 줄
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2, type AppSpecV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { tokensOf, bucketToken } from "../src/import/links.js";

const D = "sha256:" + "ef".repeat(32);
type Raw = Record<string, any>;
const inv = (items: Raw[], provider = "aws"): RawInventory => ({ provider, coverage: {}, items } as RawInventory);
const dep = (env: Raw[]): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name: "shop-api", namespace: "shop", labels: { app: "shop-api" } },
  spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } }, template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{
    name: "shop-api", image: "ghcr.io/demo/shop-api:1.0", ports: [{ containerPort: 8080 }], env }] } } },
});
const ACC = "123456789012";
const sqs = (name: string): Raw => ({ kind: "sqs.queue", QueueUrl: `https://sqs.ap-northeast-1.amazonaws.com/${ACC}/${name}`,
  Attributes: { MessageRetentionPeriod: "345600", VisibilityTimeout: "30", QueueArn: `arn:aws:sqs:ap-northeast-1:${ACC}:${name}` } });
const s3 = (name: string): Raw => ({ kind: "s3.bucket", Name: name, Versioning: "Enabled", PublicAccessBlock: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  PolicyStatusIsPublic: false, AclPublic: false, SizeBytes: 1, Lifecycle: null, Cors: [], Arn: `arn:aws:s3:::${name}` });
const ec = (): Raw => ({ kind: "elasticache.replicationGroup", ReplicationGroupId: "shop-cache", Engine: "redis", EngineVersion: "7.1.0", CacheNodeType: "cache.t4g.medium",
  ClusterEnabled: false, NodeGroups: 1, TransitEncryptionEnabled: true, AuthTokenEnabled: false, MultiAZ: "enabled",
  PrimaryEndpoint: "shop-cache.abc.ng.0001.apne1.cache.amazonaws.com", ReaderEndpoint: "shop-cache-ro.abc.ng.0001.apne1.cache.amazonaws.com", ARN: null });
const topic = (): Raw => ({ kind: "pubsub.topic", name: "projects/p1/topics/orders", messageRetentionDuration: "86400s",
  subscription: { name: "projects/p1/subscriptions/orders-worker", ackDeadlineSeconds: 30 } });
const envOf = (spec: AppSpecV2) => (spec.components.find((c) => c.id === "shop-api") as unknown as { props: { env: Raw[] } }).props.env;
const linked = (spec: AppSpecV2, to: string) => spec.links.some((l) => l.from === "shop-api" && l.to === to);

test("G3b-4 정상: 버킷 주소 모양(ARN·가상 호스트·리전 경로·s3://·gs://·GCS 경로) → 같은 버킷 표지", () => {
  for (const v of ["arn:aws:s3:::shop-assets/img/*", "https://shop-assets.s3.amazonaws.com/a.png", "https://shop-assets.s3.ap-northeast-1.amazonaws.com/a",
    "https://s3.ap-northeast-1.amazonaws.com/shop-assets/a", "shop-assets.s3-ap-northeast-1.amazonaws.com", "s3://shop-assets/x"])
    assert.ok(tokensOf(v).has(bucketToken("s3", "shop-assets")), v);
  for (const v of ["https://storage.googleapis.com/shop-assets/a", "https://shop-assets.storage.googleapis.com/a", "gs://shop-assets/x"])
    assert.ok(tokensOf(v).has(bucketToken("gcs", "shop-assets")), v);
});

test("G3b-4 정상(AWS): 큐 이름 → name 출력(맨 이름이라 검토), 큐 ARN·버킷 ARN·가상 호스트 → 의존성 + 값 그대로 검토, 캐시 읽기 주소 → host", () => {
  const { result } = normalizeV2(inv([dep([
    { name: "QUEUE_NAME", value: "orders" },
    { name: "QUEUE_ARN", value: `arn:aws:sqs:ap-northeast-1:${ACC}:orders` },
    { name: "ASSETS_ARN", value: "arn:aws:s3:::shop-assets/*" },
    { name: "ASSETS_URL", value: "https://shop-assets.s3.ap-northeast-1.amazonaws.com/img" },
    { name: "REDIS_RO", value: "shop-cache-ro.abc.ng.0001.apne1.cache.amazonaws.com:6379" },
  ]), sqs("orders"), s3("shop-assets"), ec()]));
  for (const id of ["orders", "shop-assets", "shop-cache"]) assert.ok(linked(result.spec, id), `${id} 의존성`);
  const env = envOf(result.spec);
  const by = (n: string) => env.find((e) => e.name === n)!;
  assert.deepEqual(by("QUEUE_NAME").fromLink, { to: "orders", output: "name" });
  // 같은 큐를 ARN(확실한 근거)으로도 맞췄으니 이 줄은 1. 이름만 있으면 0.9 검토 (아래)
  const only = normalizeV2(inv([dep([{ name: "QUEUE_NAME", value: "orders" }]), sqs("orders")])).result;
  assert.equal(only.fieldMeta["components.shop-api.env.QUEUE_NAME"]?.needs_review, true, "맨 이름만 = 0.9 검토");
  for (const n of ["QUEUE_ARN", "ASSETS_ARN", "ASSETS_URL"]) {
    assert.equal(typeof by(n).value, "string", `${n} 값은 그대로 (도착에 같은 모양 출력 없음)`);
    assert.equal(result.fieldMeta[`components.shop-api.env.${n}`]?.needs_review, true, n);
  }
  assert.equal(by("REDIS_RO").template, "${shop-cache.host}:${shop-cache.port}");
  assert.ok(!result.outOfBoundary?.some((o: Raw) => ["orders", "shop-assets", "shop-cache"].includes(String(o.resource))), "경계 밖으로 안 빠짐");
  assert.deepEqual(checkV2(result.spec).errors, []);
});

test("G3b-4 정상(GCP): 토픽 전체 이름·구독 이름 → 의존성 + 검토, 짧은 토픽 이름 → name 출력", () => {
  const full = normalizeV2(inv([dep([{ name: "TOPIC", value: "projects/p1/topics/orders" }, { name: "SUB", value: "orders-worker" }]), topic()], "gcp")).result;
  assert.ok(linked(full.spec, "orders"));
  assert.equal(envOf(full.spec).find((e) => e.name === "TOPIC")!.value, "projects/p1/topics/orders");
  assert.equal(full.fieldMeta["components.shop-api.env.TOPIC"]?.needs_review, true);
  const short = normalizeV2(inv([dep([{ name: "TOPIC", value: "orders" }]), topic()], "gcp")).result;
  assert.deepEqual(envOf(short.spec).find((e) => e.name === "TOPIC")!.fromLink, { to: "orders", output: "name" });
});

test("G3b-4 거부: 비슷한 이름은 안 잇는다 (orders-v2 큐 이름, 다른 버킷 가상 호스트, 버킷 이름이 경로 둘째 조각)", () => {
  const { result } = normalizeV2(inv([dep([
    { name: "Q", value: "orders-v2" },
    { name: "B", value: "https://shop-assets-old.s3.amazonaws.com/a" },
    { name: "C", value: "https://cdn.example.com/static/shop-assets" },
    { name: "D", value: "arn:aws:sqs:ap-northeast-1:999999999999:orders-dlq" },
  ]), sqs("orders"), s3("shop-assets")]));
  assert.equal(linked(result.spec, "orders"), false);
  assert.equal(linked(result.spec, "shop-assets"), false);
  assert.ok(!tokensOf("https://cdn.example.com/static/shop-assets").has(bucketToken("s3", "shop-assets")));
});
