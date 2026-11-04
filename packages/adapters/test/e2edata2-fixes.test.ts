// E2EDATA2 고친 것 고정: ① Pub/Sub DLQ 토픽은 queue 로 ② 흉내 길 apply 출력에 데이터 자원 link.* ③ posture 를 사람이 고치는 경로
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, SpecFieldPath, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { stubTfOutputsV2, v2Blockers, targetBuilderFor } from "../src/index.js";

const inv: RawInventory = { provider: "gcp", coverage: {}, items: [
  { kind: "pubsub.topic", name: "projects/p/topics/orders", subscription: { ackDeadlineSeconds: 30, deadLetterPolicy: { deadLetterTopic: "projects/p/topics/orders-dlq", maxDeliveryAttempts: 5 } } },
  { kind: "pubsub.topic", name: "projects/p/topics/orders-dlq" },
  { kind: "pubsub.topic", name: "projects/p/topics/events" },
] } as unknown as RawInventory;
const comp = (s: AppSpecV2, id: string) => s.components.find((c) => c.id === id) as unknown as { kind: string; props: Record<string, any> };

test("Pub/Sub DLQ 대상 토픽은 queue 로 올라가고 검토 표시, 일반 토픽은 topic 그대로, 도착 검증이 DLQ 때문에 막지 않는다", () => {
  const { result } = normalizeV2(inv);
  assert.equal(comp(result.spec, "orders").props.deadLetter.to, "orders-dlq");
  assert.equal(comp(result.spec, "orders-dlq").props.model, "queue");
  assert.equal(comp(result.spec, "orders").props.model, "topic");
  assert.equal(comp(result.spec, "events").props.model, "topic");
  assert.equal(result.fieldMeta["components.orders-dlq.model"]?.needs_review, true);
  for (const p of ["aws", "gcp"] as const) {
    const b = v2Blockers(result.spec, targetBuilderFor(p).capabilities());
    assert.ok(!b.unsupported.some((m) => /DLQ/.test(m)), b.unsupported.join());
  }
});

test("거부: DLQ 가 이 가져오기에 없으면 to 를 안 채우고(지어내지 않음) 사람 확인", () => {
  const { result } = normalizeV2({ ...inv, items: (inv.items as any[]).filter((i) => !/orders-dlq/.test(i.name)) } as RawInventory);
  assert.equal(comp(result.spec, "orders").props.deadLetter.to, undefined);
  assert.equal(result.fieldMeta["components.orders.deadLetter"]?.needs_review, true);
});

test("흉내 apply 출력(stubTfOutputsV2): cache·objectStore·queue 가 LINK_OUTPUTS 칸 그대로 나오고 결정적", () => {
  const { result } = normalizeV2({ provider: "aws", coverage: {}, items: [
    { kind: "s3.bucket", Name: "b1", Versioning: "Enabled", PublicAccessBlock: null, PolicyStatusIsPublic: false, AclPublic: false, SizeBytes: 1024 ** 3, Lifecycle: [], Cors: [], Arn: "arn:aws:s3:::b1" },
    { kind: "sqs.queue", QueueUrl: "https://sqs.ap-northeast-1.amazonaws.com/123456789012/q1", Attributes: { VisibilityTimeout: "30", QueueArn: "arn:aws:sqs:ap-northeast-1:123456789012:q1" } },
    { kind: "elasticache.replicationGroup", ReplicationGroupId: "c1", Engine: "redis", EngineVersion: "7.1.0", CacheNodeType: "cache.t4g.medium", ClusterEnabled: false, NodeGroups: 1,
      TransitEncryptionEnabled: true, AuthTokenEnabled: true, MultiAZ: "enabled", PrimaryEndpoint: "c1.x.cache.amazonaws.com", ARN: "arn:aws:elasticache:ap-northeast-1:123456789012:replicationgroup:c1" },
  ] } as unknown as RawInventory);
  const spec = result.spec;
  assert.deepEqual(checkV2(spec).errors, []);
  const a = stubTfOutputsV2(spec), b = stubTfOutputsV2(spec);
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).filter((k) => k.startsWith("link.c1.")).sort(), ["link.c1.host", "link.c1.port", "link.c1.url"]);
  assert.deepEqual(Object.keys(a).filter((k) => k.startsWith("link.b1.")).sort(), ["link.b1.name", "link.b1.url"]);
  assert.deepEqual(Object.keys(a).filter((k) => k.startsWith("link.q1.")).sort(), ["link.q1.name", "link.q1.url"]);
});

test("PATCH 경로: posture 통째는 받고, posture.network 같은 깊은 경로·모르는 경로는 거부", () => {
  assert.ok(SpecFieldPath.safeParse("posture").success);
  assert.ok(SpecFieldPath.safeParse("security").success);   // 보안 요구사항 통째 (보안 판정 연결)
  // G3b-5 (팀 결정): 앱 이름은 "app.name" 으로만 고친다. 통째 "app"·다른 app 칸은 거부
  assert.ok(SpecFieldPath.safeParse("app.name").success);
  for (const p of ["posture.network", "security.requirements", "securityFacts", "posture ", "app", "app.owner"]) assert.equal(SpecFieldPath.safeParse(p).success, false, p);
});
