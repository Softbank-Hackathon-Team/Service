// B-1b: 버킷 이벤트 알림 → objectStore.notifications(to = IR 큐) / B-2: SNS 토픽·구독 → queue(topic) + subscriptions / B-3: Memcached → cache(engine memcached)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2, ImportResultV2, type AppSpecV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { readAwsData } from "../src/discover/data.js";
import { targetBuilderFor, v2Blockers } from "../src/index.js";

const D = "sha256:" + "34".repeat(32);
type Raw = Record<string, any>;
const ACC = "123456789012", R = "ap-northeast-2";
const inv = (items: Raw[], provider = "aws"): RawInventory => ({ provider, coverage: {}, items } as RawInventory);
const dep = (env: Raw[]): Raw => ({ kind: "k8s.deployment", imageDigest: D, metadata: { name: "shop-api", namespace: "shop", labels: { app: "shop-api" } },
  spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } }, template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{
    name: "shop-api", image: "ghcr.io/demo/shop-api:1.0", ports: [{ containerPort: 8080 }], env }] } } } });
const qArn = (n: string) => `arn:aws:sqs:${R}:${ACC}:${n}`, tArn = (n: string) => `arn:aws:sns:${R}:${ACC}:${n}`;
const sqs = (n: string): Raw => ({ kind: "sqs.queue", QueueUrl: `https://sqs.${R}.amazonaws.com/${ACC}/${n}`, Attributes: { QueueArn: qArn(n), VisibilityTimeout: "30" } });
const s3 = (n: string, Notification: unknown): Raw => ({ kind: "s3.bucket", Name: n, Versioning: "Enabled", PublicAccessBlock: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  PolicyStatusIsPublic: false, AclPublic: false, SizeBytes: 1, Lifecycle: null, Cors: [], Arn: `arn:aws:s3:::${n}`, Notification });
const comp = (s: AppSpecV2, id: string) => s.components.find((c) => c.id === id) as unknown as { kind: string; props: Raw } | undefined;
const caps = (p: "aws" | "gcp" | "onprem") => targetBuilderFor(p).capabilities();

test("B-1b·B-2 정상(AWS): 버킷 → 큐·토픽 알림, 토픽 → SQS 구독, 앱 env 의 토픽 ARN → 링크. 대상 큐는 경계 안으로 따라옴", () => {
  const { result } = normalizeV2(inv([
    dep([{ name: "UPLOADS", value: "shop-uploads" }, { name: "EVENTS_TOPIC", value: tArn("shop-events") }]),
    s3("shop-uploads", { QueueConfigurations: [{ QueueArn: qArn("upload-jobs"), Events: ["s3:ObjectCreated:*"], Filter: { Key: { FilterRules: [{ Name: "Prefix", Value: "in/" }, { Name: "Suffix", Value: ".jpg" }] } } }],
      TopicConfigurations: [{ TopicArn: tArn("shop-events"), Events: ["s3:ObjectRemoved:*"] }] }),
    sqs("upload-jobs"), sqs("audit-q"), sqs("unrelated-q"),
    { kind: "sns.topic", TopicArn: tArn("shop-events"), Subscriptions: [{ Protocol: "sqs", Endpoint: qArn("audit-q") }, { Protocol: "https", Endpoint: "https://hooks.example.com/x?token=abc" }] },
  ]));
  assert.equal(ImportResultV2.safeParse(result).success, true, JSON.stringify(ImportResultV2.safeParse(result).error?.issues?.slice(0, 2)));
  assert.deepEqual(checkV2(result.spec).errors, []);
  assert.deepEqual(comp(result.spec, "shop-uploads")!.props.notifications, [
    { target: "queue", events: ["s3:ObjectCreated:*"], prefix: "in/", suffix: ".jpg", to: "upload-jobs" },
    { target: "topic", events: ["s3:ObjectRemoved:*"], to: "shop-events" }]);
  const topic = comp(result.spec, "shop-events")!;
  assert.equal(topic.props.model, "topic");
  assert.deepEqual(topic.props.subscriptions, [{ protocol: "sqs", to: "audit-q" }, { protocol: "https" }]);
  assert.equal(result.fieldMeta["components.shop-events.subscriptions"]?.needs_review, true, "https 구독(IR 밖)은 검토");
  assert.ok(result.spec.links.some((l) => l.from === "shop-api" && l.to === "shop-events"), "env 토픽 ARN → 링크");
  assert.equal(result.fieldMeta["components.shop-api.env.EVENTS_TOPIC"]?.needs_review, true, "ARN 은 값 그대로 + 검토");
  for (const id of ["upload-jobs", "audit-q"]) assert.ok(comp(result.spec, id), `${id} 경계 안으로 따라옴`);
  assert.equal(comp(result.spec, "unrelated-q"), undefined);
  assert.ok(!JSON.stringify(result.spec).includes("hooks.example.com"), "http 구독 주소는 안 담음");
  // 도착 렌더는 아직 없음 → capability 로 막음
  for (const p of ["aws", "gcp", "onprem"] as const) {
    const u = v2Blockers(result.spec, caps(p)).unsupported.join("\n");
    assert.match(u, /objectStore\.notifications/, p); assert.match(u, /queue\.subscriptions/, p);
  }
});

test("B-1b 거부: 알림을 못 읽으면(null) 칸 없이 검토 줄, 대상을 못 찾으면 to 없이 검토, 알림 없는 버킷은 막지 않음", () => {
  const { result } = normalizeV2(inv([dep([{ name: "A", value: "a-bkt" }, { name: "B", value: "b-bkt" }, { name: "C", value: "c-bkt" }]),
    s3("a-bkt", null), s3("b-bkt", { QueueConfigurations: [{ QueueArn: qArn("other-account-q"), Events: ["s3:ObjectCreated:*"] }] }), s3("c-bkt", {})]));
  assert.equal(comp(result.spec, "a-bkt")!.props.notifications, undefined);
  assert.equal(result.fieldMeta["components.a-bkt.notifications"]?.needs_review, true);
  assert.match(result.fieldMeta["components.a-bkt.notifications"]?.rationale ?? "", /못 읽음/);
  assert.deepEqual(comp(result.spec, "b-bkt")!.props.notifications, [{ target: "queue", events: ["s3:ObjectCreated:*"] }]);
  assert.equal(result.fieldMeta["components.b-bkt.notifications"]?.needs_review, true);
  assert.equal(comp(result.spec, "c-bkt")!.props.notifications, undefined);
  assert.deepEqual(checkV2(result.spec).errors, []);
  const bad = structuredClone(result.spec) as Raw;
  bad.components.find((c: Raw) => c.id === "c-bkt").props.notifications = [{ target: "queue", events: [], to: "a-bkt" }];
  assert.ok(checkV2(bad as AppSpecV2).errors.some((e) => /notifications\.to 가 queue 아님/.test(e)));
});

test("B-1b GCP: 버킷 → Pub/Sub 토픽 알림 (토픽 전체 이름으로 이음)", () => {
  const { result } = normalizeV2(inv([dep([{ name: "B", value: "gs://shop-media/x" }]),
    { kind: "gcs.bucket", name: "shop-media", versioning: false, publicAccessPrevention: "enforced", allUsersBinding: false,
      notifications: [{ topic: "//pubsub.googleapis.com/projects/p1/topics/media-events", event_types: ["OBJECT_FINALIZE"], object_name_prefix: "up/" }] },
    { kind: "pubsub.topic", name: "projects/p1/topics/media-events" }], "gcp"));
  assert.deepEqual(comp(result.spec, "shop-media")!.props.notifications, [{ target: "topic", events: ["OBJECT_FINALIZE"], prefix: "up/", to: "media-events" }]);
  assert.ok(comp(result.spec, "media-events"));
});

test("B-2·B-3 읽기: SNS 목록 실패 → unread.SNS, Memcached 클러스터 → cache(memcached), 도착에 없으면 계획에서 막힘", async () => {
  const ok = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "", ms: 1 });
  const exec = async (_b: string, args: string[]) => {
    const s = args.join(" ");
    if (/^sns list-topics/.test(s)) return { code: 254, stdout: "", stderr: "AccessDenied: sns:ListTopics", ms: 1 };
    if (/^elasticache describe-cache-clusters/.test(s)) return ok({ CacheClusters: [
      { CacheClusterId: "sess-mc", Engine: "memcached", EngineVersion: "1.6.22", CacheNodeType: "cache.t4g.small", NumCacheNodes: 2, ConfigurationEndpoint: { Address: "sess-mc.abc.cfg.apn2.cache.amazonaws.com" } },
      { CacheClusterId: "rg-001", Engine: "redis", ReplicationGroupId: "rg" }] });
    if (/^s3api list-buckets/.test(s)) return ok({ Buckets: [] });
    return ok({});
  };
  const notes: string[] = [];
  const items = await readAwsData({ exec: exec as never, env: {} }, R, notes);
  assert.deepEqual(items.filter((i) => i.kind === "k8s.unread").map((i) => [i.resource, i.source]), [["SNS", "aws:sns"]]);
  const mc = items.filter((i) => i.kind === "elasticache.replicationGroup");
  assert.deepEqual(mc.map((i) => [i.ReplicationGroupId, i.Engine]), [["sess-mc", "memcached"]], "redis 구성원 클러스터는 복제 그룹 쪽에서 읽음 (중복 없음)");
  const { result } = normalizeV2(inv([dep([{ name: "MEMCACHED", value: "sess-mc.abc.cfg.apn2.cache.amazonaws.com:11211" }]), ...items]));
  assert.equal(result.fieldMeta["unread.SNS"]?.needs_review, true);
  const c = comp(result.spec, "sess-mc")!;
  assert.equal(c.kind, "cache"); assert.equal(c.props.engine, "memcached"); assert.equal(c.props.auth, false);
  assert.ok(result.spec.links.some((l) => l.from === "shop-api" && l.to === "sess-mc"));
  for (const p of ["aws", "gcp", "onprem"] as const) assert.match(v2Blockers(result.spec, caps(p)).unsupported.join("\n"), /kind\.cache\.memcached/, p);
});
