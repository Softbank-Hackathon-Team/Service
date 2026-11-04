// G3b-4: 큐 이름·ARN, 버킷 ARN·가상 호스트·경로 주소, 토픽 전체 이름·구독 이름, 캐시 읽기 주소도 의존성 근거로 알아본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2, type ImportResultV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/index.js";
import { tokensOf } from "../src/import/links.js";

type Raw = Record<string, any>;
const D = "sha256:" + "ab".repeat(32);
const ACC = "000000000000";
const inv = (items: Raw[], provider: "aws" | "gcp" = "aws"): RawInventory => ({ provider, coverage: {}, items });
const dep = (name: string, env: Raw[] = []): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});
const bucket = (name: string): Raw => ({ kind: "s3.bucket", Name: name, Arn: `arn:aws:s3:::${name}` });
const queue = (name: string): Raw => ({ kind: "sqs.queue", QueueUrl: `https://sqs.ap-northeast-2.amazonaws.com/${ACC}/${name}`,
  Attributes: { QueueArn: `arn:aws:sqs:ap-northeast-2:${ACC}:${name}` } });
const cache = (id: string): Raw => ({ kind: "elasticache.replicationGroup", ReplicationGroupId: id, Engine: "redis", ClusterEnabled: false,
  PrimaryEndpoint: `${id}.abc.ng.0001.apn2.cache.amazonaws.com`, ReaderEndpoint: `${id}-ro.abc.ng.0001.apn2.cache.amazonaws.com` });
const env = (r: ImportResultV2, id: string, n: string) => ((r.spec.components.find((c) => c.id === id)!.props as any).env as Raw[]).find((e) => e.name === n)!;
const linked = (r: ImportResultV2, from: string, to: string) => r.spec.links.some((l) => l.from === from && l.to === to);

test("G3b-4 정상(AWS): 큐 이름·큐 ARN·버킷 ARN·가상 호스트·경로 주소·캐시 읽기 주소로 링크가 생기고, 바꿀 수 있는 꼴만 다시 씀", () => {
  const { result: r } = normalizeV2(inv([
    dep("api", [
      { name: "SQS_QUEUE", value: "orders" },
      { name: "SQS_ARN", value: `arn:aws:sqs:ap-northeast-2:${ACC}:jobs` },
      { name: "BUCKET_ARN", value: "arn:aws:s3:::shop-assets/*" },
      { name: "IMG_BASE", value: "https://shop-img.s3.ap-northeast-2.amazonaws.com/public/" },
      { name: "DOC_BASE", value: "https://s3.ap-northeast-2.amazonaws.com/shop-docs/v1" },
      { name: "REDIS_RO", value: "redis://shop-cache-ro.abc.ng.0001.apn2.cache.amazonaws.com:6379" },
    ]),
    queue("orders"), queue("jobs"), bucket("shop-assets"), bucket("shop-img"), bucket("shop-docs"), cache("shop-cache"),
  ]));
  for (const to of ["orders", "jobs", "shop-assets", "shop-img", "shop-docs", "shop-cache"]) assert.ok(linked(r, "api", to), to);
  assert.equal((r.outOfBoundary ?? []).length, 0, JSON.stringify(r.outOfBoundary));
  // 큐 이름 = name 출력 (맨 이름이라 0.9 검토)
  assert.deepEqual(env(r, "api", "SQS_QUEUE").fromLink, { to: "orders", output: "name" });
  assert.equal(r.fieldMeta["components.api.env.SQS_QUEUE"]?.needs_review, true);
  // ARN·가상 호스트·경로 주소는 도착 출력 칸이 없음 → 출발 값 그대로 + 검토 (조용히 버리지 않음)
  for (const n of ["SQS_ARN", "BUCKET_ARN", "IMG_BASE", "DOC_BASE"]) {
    assert.equal(typeof env(r, "api", n).value, "string", n);
    assert.equal(r.fieldMeta[`components.api.env.${n}`]?.needs_review, true, n);
  }
  // 캐시 읽기 주소는 캐시 host 로
  assert.equal(env(r, "api", "REDIS_RO").template, "redis://${shop-cache.host}:${shop-cache.port}");
  assert.deepEqual(checkV2(r.spec).errors, []);
});

test("G3b-4 정상(GCP): 토픽 전체 이름·구독 이름, Memorystore 읽기 주소, storage.googleapis.com 경로 주소", () => {
  const { result: r } = normalizeV2(inv([
    dep("api", [
      { name: "TOPIC", value: "projects/p1/topics/orders" },
      { name: "SUB", value: "orders-worker" },
      { name: "GCS_URL", value: "https://storage.googleapis.com/shop-media/a.png" },
      { name: "REDIS_READ", value: "10.0.0.9" },
    ]),
    { kind: "pubsub.topic", name: "projects/p1/topics/orders", subscription: { name: "projects/p1/subscriptions/orders-worker", ackDeadlineSeconds: 30 } },
    { kind: "gcs.bucket", name: "shop-media", versioning: false },
    { kind: "memorystore.instance", name: "projects/p1/locations/r/instances/shop-cache", redisVersion: "REDIS_7_0", host: "10.0.0.8", port: 6379, readEndpoint: "10.0.0.9" },
  ], "gcp"));
  const ids = r.spec.components.map((c) => c.id);
  const queueId = r.spec.components.find((c) => c.kind === "queue")!.id, bucketId = r.spec.components.find((c) => c.kind === "objectStore")!.id;
  const cacheId = r.spec.components.find((c) => c.kind === "cache")?.id;
  assert.ok(cacheId, ids.join(","));
  for (const to of [queueId, bucketId, cacheId!]) assert.ok(linked(r, "api", to), to);
  assert.equal(r.fieldMeta["components.api.env.TOPIC"]?.needs_review, true, "토픽 전체 이름은 출발 값 그대로 + 검토");
  assert.deepEqual(env(r, "api", "REDIS_READ").fromLink, { to: cacheId, output: "host" });
});

test("G3b-4 거부: 비슷한 이름은 근거가 아니다 (orders-archive·shop-assets-old·ARN 다른 계정 꼴 아님)", () => {
  const { result: r } = normalizeV2(inv([
    dep("api", [{ name: "Q", value: "orders-archive" }, { name: "B", value: "https://shop-assets-old.s3.amazonaws.com/x" },
      { name: "A", value: "arn:aws:s3:::shop-assets-old" }]),
    queue("orders"), bucket("shop-assets"),
  ]));
  assert.ok(!linked(r, "api", "orders"));
  assert.ok(!linked(r, "api", "shop-assets"));
  assert.deepEqual((r.outOfBoundary ?? []).map((o) => o.resource).sort(), ["s3.bucket:shop-assets", "sqs.queue:orders"]);
  // 토큰: 리전 붙은 S3 주소 → 리전 없는 꼴, ARN 뒤 경로 → 자원 ARN
  const t = tokensOf("https://bkt.s3.ap-northeast-2.amazonaws.com/k arn:aws:s3:::bkt/*");
  assert.ok(t.has("bkt.s3.amazonaws.com") && t.has("arn:aws:s3:::bkt"));
  assert.ok(!tokensOf("https://bkt-old.s3.amazonaws.com/k").has("bkt.s3.amazonaws.com"));
});
