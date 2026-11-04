// I6: S3·SQS·ElastiCache / GCS·Pub/Sub·Memorystore → objectStore·queue·cache. 매퍼 정상·null·skip, 결정성, DLQ 연결, 링크·env, discover 읽기 전용
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, ImportResultV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { discoverAws, discoverGcp } from "../src/discover/index.js";
import type { Exec } from "../src/terraform/real-runner.js";

type Raw = Record<string, any>;
const D = "sha256:" + "ab".repeat(32);
const inv = (items: Raw[], provider = "aws"): RawInventory => ({ provider, coverage: {}, items } as RawInventory);
const comp = (spec: AppSpecV2, id: string) => spec.components.find((c) => c.id === id) as unknown as { id: string; kind: string; props: Raw } | undefined;
const dep = (name: string, env: Raw[]): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});

const s3 = (o: Raw = {}): Raw => ({ kind: "s3.bucket", Name: "shop-assets", Versioning: "Enabled",
  PublicAccessBlock: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  PolicyStatusIsPublic: false, AclPublic: false, SizeBytes: 5 * 1024 ** 3,
  Lifecycle: [{ Status: "Enabled", Filter: { Prefix: "tmp/" }, Expiration: { Days: 7 } }], Cors: [], Arn: "arn:aws:s3:::shop-assets", ...o });
const sqs = (name: string, attrs: Raw = {}): Raw => ({ kind: "sqs.queue", QueueUrl: `https://sqs.ap-northeast-1.amazonaws.com/123456789012/${name}`,
  Attributes: { MessageRetentionPeriod: "345600", VisibilityTimeout: "30", QueueArn: `arn:aws:sqs:ap-northeast-1:123456789012:${name}`, ...attrs } });
const ec = (o: Raw = {}): Raw => ({ kind: "elasticache.replicationGroup", ReplicationGroupId: "shop-cache", Engine: "redis", EngineVersion: "7.1.0",
  CacheNodeType: "cache.t4g.medium", ClusterEnabled: false, NodeGroups: 1, TransitEncryptionEnabled: true, AuthTokenEnabled: true, MultiAZ: "enabled",
  PrimaryEndpoint: "shop-cache.abc.ng.0001.apne1.cache.amazonaws.com", ARN: "arn:aws:elasticache:ap-northeast-1:123456789012:replicationgroup:shop-cache", ...o });

test("S3: 정상 → objectStore, 공개 false 확실·버전 켜짐·크기·수명 주기", () => {
  const { result } = normalizeV2(inv([s3()]));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  const c = comp(result.spec, "shop-assets")!;
  assert.equal(c.kind, "objectStore");
  assert.equal(c.props.versioning, true);
  assert.equal(c.props.public, false);
  assert.equal(c.props.sizeGb, 5);
  assert.deepEqual(c.props.lifecycle, [{ prefix: "tmp/", expireDays: 7 }]);
  assert.deepEqual(checkV2(result.spec).errors, []);
});

test("S3: 공개 신호 true, 확인 못 하면 null + 신뢰도 0.6 (지어내지 않음), 이름 없음은 skip", () => {
  const pub = normalizeV2(inv([s3({ PolicyStatusIsPublic: true })])).result;
  assert.equal(comp(pub.spec, "shop-assets")!.props.public, true);
  const unk = normalizeV2(inv([s3({ PublicAccessBlock: null, PolicyStatusIsPublic: null, AclPublic: null, SizeBytes: null })])).result;
  const c = comp(unk.spec, "shop-assets")!;
  assert.equal(c.props.public, null);
  assert.equal(c.props.sizeGb, null);
  assert.ok(Object.entries(unk.fieldMeta).some(([k, m]) => /shop-assets/.test(k) && /public/.test(k) && m.confidence === 0.6), JSON.stringify(Object.keys(unk.fieldMeta)));
  const bad = normalizeV2(inv([s3({ Name: undefined })])).result;
  assert.equal(bad.spec.components.length, 0);
  assert.ok(bad.unmapped.length >= 1);
});

test("SQS: 큐 속성 → queue, FIFO 는 ordered, DLQ 는 같은 가져오기 안 큐로 연결", () => {
  const { result } = normalizeV2(inv([
    sqs("orders", { FifoQueue: "true", RedrivePolicy: JSON.stringify({ deadLetterTargetArn: "arn:aws:sqs:ap-northeast-1:123456789012:orders-dlq", maxReceiveCount: 5 }) }),
    sqs("orders-dlq")]));
  const q = comp(result.spec, "orders")!;
  assert.equal(q.kind, "queue");
  assert.equal(q.props.ordered, true);
  assert.equal(q.props.retentionSec, 345600);
  assert.deepEqual(q.props.deadLetter, { to: "orders-dlq", maxReceive: 5 });
  assert.ok(!comp(result.spec, "orders-dlq")!.props.ordered);   // FifoQueue 속성이 없으면 순서 칸을 안 채움
  assert.deepEqual(checkV2(result.spec).errors, []);
});

test("SQS: DLQ 를 못 찾으면 to 를 비우고 신뢰도 0.6 + 이유 (다른 계정일 수 있음)", () => {
  const { result } = normalizeV2(inv([sqs("orders", { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: "arn:aws:sqs:us-east-1:999999999999:gone", maxReceiveCount: 3 }) })]));
  const q = comp(result.spec, "orders")!;
  assert.equal((q.props.deadLetter as Raw).to, undefined);
  assert.equal(result.fieldMeta["components.orders.props.deadLetter"]?.confidence ?? 0.6, 0.6);
});

test("ElastiCache: 복제 그룹 → cache, 엔진·메모리 표·TLS·인증·HA", () => {
  const { result } = normalizeV2(inv([ec()]));
  const c = comp(result.spec, "shop-cache")!;
  assert.equal(c.kind, "cache");
  assert.equal(c.props.engine, "redis");
  assert.equal(c.props.tls, true);
  assert.equal(c.props.auth, true);
  assert.equal(c.props.ha, true);
  assert.equal(c.props.clusterMode, false);
  assert.ok(typeof c.props.memoryMiB === "number" && c.props.memoryMiB > 0);
});

test("ElastiCache: 모르는 노드 종류는 메모리 null (지어내지 않음)", () => {
  const { result } = normalizeV2(inv([ec({ CacheNodeType: "cache.zz9.mystery" })]));
  assert.equal(comp(result.spec, "shop-cache")!.props.memoryMiB, null);
});

test("GCS·Pub/Sub·Memorystore: GCP 원본 → objectStore·queue·cache", () => {
  const { result } = normalizeV2(inv([
    { kind: "gcs.bucket", name: "shop-gcs", versioning: true, publicAccessPrevention: "enforced", allUsersBinding: false, lifecycleRules: [{ action: { type: "Delete" }, condition: { age: 30 } }], cors: [] },
    { kind: "pubsub.topic", name: "projects/p/topics/events", messageRetentionDuration: "86400s", subscription: { ackDeadlineSeconds: 20, enableMessageOrdering: true } },
    { kind: "memorystore.instance", name: "projects/p/locations/asia-northeast1/instances/shop-redis", redisVersion: "REDIS_7_0", memorySizeGb: 2, tier: "STANDARD_HA", transitEncryptionMode: "SERVER_AUTHENTICATION", authEnabled: true, host: "10.0.0.3", port: 6379 },
  ], "gcp"));
  assert.equal(comp(result.spec, "shop-gcs")!.kind, "objectStore");
  assert.equal(comp(result.spec, "shop-gcs")!.props.public, false);
  assert.equal(comp(result.spec, "shop-gcs")!.props.versioning, true);
  const t = comp(result.spec, "events")!;
  assert.equal(t.kind, "queue");
  assert.equal(t.props.model, "topic");
  assert.equal(t.props.ordered, true);
  assert.equal(t.props.retentionSec, 86400);
  const r = comp(result.spec, "shop-redis")!;
  assert.equal(r.kind, "cache");
  assert.equal(r.props.memoryMiB, 2048);
  assert.equal(r.props.ha, true);
  assert.equal(r.props.auth, true);
  assert.deepEqual(checkV2(result.spec).errors, []);
});

test("GCS: allUsers 바인딩이면 public true, 못 읽으면 null", () => {
  const mk = (all: boolean | null, pap: string | null) => normalizeV2(inv([{ kind: "gcs.bucket", name: "b1", versioning: false, publicAccessPrevention: pap, allUsersBinding: all }], "gcp")).result;
  assert.equal(comp(mk(true, "inherited").spec, "b1")!.props.public, true);
  assert.equal(comp(mk(null, null).spec, "b1")!.props.public, null);
});

test("결정성: 입력 순서를 섞어도 같은 결과", () => {
  const items = [s3(), sqs("orders"), ec(), dep("shop-api", [])];
  const a = normalizeV2(inv(items)).result;
  const b = normalizeV2(inv([...items].reverse())).result;
  assert.deepEqual(a.spec, b.spec);
});

test("링크·env: 큐 URL·캐시 주소·버킷 이름이 env 에 있으면 연결 + 값은 fromLink 로 바뀜", () => {
  const q = sqs("orders");
  const cache = ec();
  const { result } = normalizeV2(inv([
    dep("shop-api", [{ name: "QUEUE_URL", value: q.QueueUrl }, { name: "REDIS_HOST", value: cache.PrimaryEndpoint }, { name: "BUCKET", value: "shop-assets" }]),
    q, cache, s3()]));
  const L = result.spec.links.map((l) => `${l.from}->${String(l.to)}`).sort();
  assert.ok(L.includes("shop-api->orders"), L.join());
  assert.ok(L.includes("shop-api->shop-cache"), L.join());
  assert.ok(L.includes("shop-api->shop-assets"), L.join());
  const env = comp(result.spec, "shop-api")!.props.env as Raw[];
  for (const n of ["QUEUE_URL", "REDIS_HOST"]) assert.ok(env.find((e) => e.name === n)?.fromLink, `${n} 가 fromLink 로 안 바뀜: ${JSON.stringify(env)}`);
  assert.ok(!JSON.stringify(result.spec).includes("amazonaws.com"), "출발 주소가 명세에 남음");
});

// ── discover 읽기 ──
type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    return { code: hit[1].code ?? 0, stdout: typeof hit[1].out === "string" ? hit[1].out : JSON.stringify(hit[1].out ?? null), stderr: hit[1].err ?? "", ms: 1 };
  };
  return { exec, calls };
}
const KC: Array<[RegExp, Reply]> = [
  [/^kubectl get deployments/, { out: { items: [{ kind: "Deployment", metadata: { name: "shop-api", namespace: "shop" }, spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } },
    template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{ name: "api", image: "ghcr.io/demo/shop-api:1.0", ports: [{ containerPort: 8080 }] }] } } } }] } }],
  [/^kubectl get pods/, { out: { items: [{ metadata: { name: "shop-api-1", namespace: "shop", labels: { app: "shop-api" } }, status: { containerStatuses: [{ name: "api", imageID: `ghcr.io/demo/shop-api@${D}` }] } }] } }],
  [/^kubectl get nodes/, { out: { items: [] } }],
  [/^kubectl get (services|ingresses|configmaps) /, { out: { items: [] } }],   // F-1: 핵심 종류는 못 읽으면 멈추므로 빈 목록으로 응답
];
const AWS_BASE: Array<[RegExp, Reply]> = [
  [/^aws sts get-caller-identity/, { out: { Account: "123456789012" } }],
  [/^aws eks list-clusters/, { out: { clusters: ["c1"] } }],
  [/^aws eks describe-cluster/, { out: { cluster: { version: "1.31", resourcesVpcConfig: { vpcId: "vpc-1" } } } }],
  [/^aws eks update-kubeconfig/, { out: "ok" }],
  [/^aws rds describe-db-instances/, { out: { DBInstances: [] } }],
  [/^aws ec2 describe-vpcs/, { out: { Vpcs: [] } }], [/^aws elbv2/, { out: { LoadBalancers: [] } }],
  [/^aws ecr/, { out: { repositories: [] } }], [/^aws secretsmanager/, { out: { SecretList: [] } }],
  ...KC,
];
const GCP_BASE: Array<[RegExp, Reply]> = [
  [/^gcloud projects describe/, { out: { projectId: "p" } }],
  [/^gcloud container clusters list/, { out: [{ name: "g1", location: "asia-northeast3" }] }],
  [/^gcloud container clusters get-credentials/, { out: "ok" }],
  [/^gcloud sql instances list/, { out: [] }], [/^gcloud compute/, { out: [] }], [/^gcloud artifacts/, { out: [] }], [/^gcloud secrets/, { out: [] }],
  ...KC,
];
const READ_ONLY = /\b(list|describe|get|head)[-\w]*\b|sts get-caller-identity/;
const WRITE = /\b(create|delete|put|update|modify|remove|set|add|tag|untag|purge|send|receive)-/;

test("discover AWS: S3·SQS·ElastiCache 를 list·describe·get 으로만 읽고, 없는 설정은 빈 값", async () => {
  const { exec, calls } = fakeExec([
    [/^aws s3api list-buckets/, { out: { Buckets: [{ Name: "shop-assets" }] } }],
    [/get-bucket-versioning/, { out: { Status: "Enabled" } }],
    [/get-public-access-block/, { code: 254, err: "NoSuchPublicAccessBlockConfiguration" }],
    [/get-bucket-policy-status/, { code: 254, err: "NoSuchBucketPolicy" }],
    [/get-bucket-acl/, { out: { Grants: [{ Grantee: { URI: "http://acs.amazonaws.com/groups/global/AllUsers" } }] } }],
    [/get-bucket-lifecycle-configuration/, { code: 254, err: "NoSuchLifecycleConfiguration" }],
    [/get-bucket-cors/, { code: 254, err: "NoSuchCORSConfiguration" }],
    [/cloudwatch get-metric-statistics/, { out: { Datapoints: [{ Timestamp: "2026-11-01T00:00:00Z", Average: 1073741824 }] } }],
    [/^aws sqs list-queues/, { out: { QueueUrls: ["https://sqs.ap-northeast-1.amazonaws.com/123456789012/orders"] } }],
    [/^aws sqs get-queue-attributes/, { out: { Attributes: { VisibilityTimeout: "30", QueueArn: "arn:aws:sqs:ap-northeast-1:123456789012:orders" } } }],
    [/^aws elasticache describe-replication-groups/, { out: { ReplicationGroups: [{ ReplicationGroupId: "shop-cache", MemberClusters: ["shop-cache-001"], CacheNodeType: "cache.t4g.medium",
      NodeGroups: [{ PrimaryEndpoint: { Address: "shop-cache.abc.cache.amazonaws.com" } }], ClusterEnabled: false }] } }],
    [/^aws elasticache describe-cache-clusters/, { out: { CacheClusters: [{ Engine: "redis", EngineVersion: "7.1.0" }] } }],
    ...AWS_BASE,
  ]);
  const raw: any = await discoverAws({ exec, env: { AWS_REGION: "ap-northeast-1" } }, {});
  const items = (raw.items) as Raw[];
  const kinds = items.map((i) => i.kind);
  assert.ok(kinds.includes("s3.bucket") && kinds.includes("sqs.queue") && kinds.includes("elasticache.replicationGroup"), kinds.join());
  const b = items.find((i) => i.kind === "s3.bucket")!;
  assert.equal(b.AclPublic, true);
  assert.equal(b.PolicyStatusIsPublic, false);
  assert.deepEqual(b.Lifecycle, []);
  assert.equal(b.SizeBytes, 1073741824);
  assert.equal(items.find((i) => i.kind === "elasticache.replicationGroup")!.Engine, "redis");
  for (const c of calls.filter((l) => /^aws (s3api|sqs|elasticache|cloudwatch)/.test(l))) {
    assert.ok(READ_ONLY.test(c) && !WRITE.test(c), `쓰기 의심 명령: ${c}`);
  }
});

test("discover AWS: 권한 없음(S3 목록 실패)이어도 중단 안 하고 나머지는 계속", async () => {
  const { exec } = fakeExec([
    [/^aws s3api list-buckets/, { code: 254, err: "AccessDenied" }],
    [/^aws sqs list-queues/, { out: { QueueUrls: [] } }],
    [/^aws elasticache describe-replication-groups/, { out: { ReplicationGroups: [] } }],
    ...AWS_BASE,
  ]);
  const raw: any = await discoverAws({ exec, env: { AWS_REGION: "ap-northeast-1" } }, {});
  const items = (raw.inventory?.items ?? raw.items ?? []) as Raw[];
  assert.ok(!items.some((i) => i.kind === "s3.bucket"));
});

test("discover GCP v2: gcs·pubsub·memorystore 를 list·get-iam-policy 로만 읽음", async () => {
  const { exec, calls } = fakeExec([
    [/gcloud storage buckets list/, { out: [{ name: "shop-gcs", versioning_enabled: true, public_access_prevention: "enforced" }] }],
    [/gcloud storage buckets get-iam-policy/, { out: { bindings: [{ role: "roles/storage.objectViewer", members: ["allUsers"] }] } }],
    [/gcloud pubsub topics list/, { out: [{ name: "projects/p/topics/events" }] }],
    [/gcloud pubsub subscriptions list/, { out: [{ name: "projects/p/subscriptions/s", topic: "projects/p/topics/events", ackDeadlineSeconds: 20 }] }],
    [/gcloud redis instances list/, { out: [{ name: "projects/p/locations/l/instances/r", redisVersion: "REDIS_7_0", memorySizeGb: 2, tier: "STANDARD_HA" }] }],
    ...GCP_BASE,
  ]);
  const raw: any = await discoverGcp({ exec, env: { GCP_PROJECT: "p" } }, {});
  const items = (raw.inventory?.items ?? raw.items ?? []) as Raw[];
  const kinds = items.map((i) => i.kind);
  assert.ok(kinds.includes("gcs.bucket") && kinds.includes("pubsub.topic") && kinds.includes("memorystore.instance"), kinds.join());
  assert.equal(items.find((i) => i.kind === "gcs.bucket")!.allUsersBinding, true);
  for (const c of calls.filter((l) => /^gcloud (storage|pubsub|redis)/.test(l))) assert.ok(/ (list|get-iam-policy)\b/.test(c), `쓰기 의심: ${c}`);
});
