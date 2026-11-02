// VI6: I6 데이터 매퍼(S3·SQS·ElastiCache·GCS·Pub/Sub·Memorystore) 경계 시험.
//   빈 버킷·정책/암호화 설정 없음·FIFO·DLQ 못 찾음/이름만 같은 다른 계정·캐시 클러스터 모드·v1 호출 0·결정성·비밀값 미노출
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2, ImportResultV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { discoverAws, discoverGcp } from "../src/discover/index.js";
import type { Exec } from "../src/terraform/real-runner.js";

type Raw = Record<string, any>;
const inv = (items: Raw[], provider = "aws"): RawInventory => ({ provider, coverage: {}, items } as RawInventory);
const comp = (r: { spec: { components: unknown[] } }, id: string) => (r.spec.components as Array<{ id: string; kind: string; props: Raw }>).find((c) => c.id === id);
const meta = (r: { fieldMeta: Record<string, any> }, key: string) => r.fieldMeta[key];
const ACC = "123456789012";
const q = (name: string, attrs: Raw = {}, acc = ACC): Raw => ({ kind: "sqs.queue", QueueUrl: `https://sqs.ap-northeast-1.amazonaws.com/${acc}/${name}`,
  Attributes: { QueueArn: `arn:aws:sqs:ap-northeast-1:${acc}:${name}`, ...attrs } });
const redrive = (arn: string, n = 5) => JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: n });
const bucket = (o: Raw = {}): Raw => ({ kind: "s3.bucket", Name: "b1", Versioning: null, PublicAccessBlock: null, PolicyStatusIsPublic: false, AclPublic: false,
  SizeBytes: 0, Lifecycle: [], Cors: [], Arn: "arn:aws:s3:::b1", ...o });

// ── S3 ──
test("S3: 빈 버킷(크기 0)·정책 없음·버전 한 번도 안 켬 → 유효한 명세, public=false 확실, 크기 0", () => {
  const r = normalizeV2(inv([bucket()])).result;
  assert.equal(ImportResultV2.safeParse(r).success, true);
  const c = comp(r, "b1")!;
  assert.equal(c.props.versioning, false);
  assert.equal(c.props.public, false);
  assert.equal(c.props.sizeGb, 0);
  assert.equal(c.props.lifecycle, undefined);
  assert.equal(c.props.cors, undefined);
  assert.deepEqual(checkV2(r.spec).errors, []);
});

test("S3: 버전 Suspended 는 false, 모르는 원본 칸(암호화 설정·정책 본문·태그)은 명세에 안 새어 나감", () => {
  const r = normalizeV2(inv([bucket({ Versioning: "Suspended", ServerSideEncryption: { Rules: [{ KMSMasterKeyID: "arn:aws:kms:x:1:key/SECRETKEYID" }] },
    Policy: "{\"Statement\":[{\"Principal\":\"*\"}]}", Tags: [{ Key: "token", Value: "tok-SHOULD-NOT-LEAK" }] })])).result;
  assert.equal(comp(r, "b1")!.props.versioning, false);
  const s = JSON.stringify(r);
  for (const bad of ["SECRETKEYID", "tok-SHOULD-NOT-LEAK", "Principal"]) assert.ok(!s.includes(bad), `${bad} 가 새어 나감`);
});

test("S3: 공개 신호 우선순위 — 정책 공개, ACL 공개, 일부만 차단, 못 읽음", () => {
  const pab = (n: number) => ({ BlockPublicAcls: n > 0, IgnorePublicAcls: n > 1, BlockPublicPolicy: n > 2, RestrictPublicBuckets: n > 3 });
  const pub = (o: Raw) => comp(normalizeV2(inv([bucket(o)])).result, "b1")!.props.public;
  assert.equal(pub({ AclPublic: true, PolicyStatusIsPublic: false }), true);
  assert.equal(pub({ PublicAccessBlock: pab(3), PolicyStatusIsPublic: null, AclPublic: null }), null);   // 3/4 차단은 확실한 차단 아님
  assert.equal(pub({ PublicAccessBlock: pab(4), PolicyStatusIsPublic: null, AclPublic: null }), false);
  assert.equal(pub({ PublicAccessBlock: null, PolicyStatusIsPublic: false, AclPublic: null }), null);    // ACL 못 읽음 → 확인 못 함
});

test("S3: 수명 주기 — 비활성 규칙 무시, 태그·크기 필터 규칙은 넣지 않고 검토 표시, 이전만 있는 규칙", () => {
  const r = normalizeV2(inv([bucket({ Lifecycle: [
    { ID: "off", Status: "Disabled", Filter: { Prefix: "x/" }, Expiration: { Days: 1 } },
    { ID: "tag", Status: "Enabled", Filter: { Tag: { Key: "a", Value: "b" } }, Expiration: { Days: 2 } },
    { ID: "size", Status: "Enabled", Filter: { ObjectSizeGreaterThan: 1024 }, Expiration: { Days: 3 } },
    { ID: "cold", Status: "Enabled", Filter: { Prefix: "logs/" }, Transitions: [{ Days: 90, StorageClass: "GLACIER" }, { Days: 30, StorageClass: "STANDARD_IA" }] },
    { ID: "legacy", Status: "Enabled", Prefix: "old/", Expiration: { Days: 365 } },
  ] })])).result;
  assert.deepEqual(comp(r, "b1")!.props.lifecycle, [{ prefix: "logs/", toColdAfterDays: 30 }, { prefix: "old/", expireDays: 365 }]);
  const m = meta(r, "components.b1.lifecycle");
  assert.equal(m?.needs_review, true);
  assert.match(m?.rationale ?? "", /2개/);
});

// ── SQS ──
test("SQS: FIFO 아님(FifoQueue=false)은 ordered=false, 범위 밖 보존 기간·가시성 값은 칸을 비움", () => {
  const r = normalizeV2(inv([q("a", { FifoQueue: "false", MessageRetentionPeriod: "5", VisibilityTimeout: "abc" })])).result;
  const c = comp(r, "a")!;
  assert.equal(c.props.ordered, false);
  assert.equal(c.props.retentionSec, undefined);
  assert.equal(c.props.ackTimeoutSec, undefined);
  assert.deepEqual(checkV2(r.spec).errors, []);
});

test("SQS: FIFO 큐 + FIFO DLQ → ordered 검토 표시(0.9) + DLQ 연결, 끝에 .fifo 이름 유지", () => {
  const r = normalizeV2(inv([q("orders.fifo", { FifoQueue: "true", RedrivePolicy: redrive(`arn:aws:sqs:ap-northeast-1:${ACC}:orders-dlq.fifo`) }),
    q("orders-dlq.fifo", { FifoQueue: "true" })])).result;
  const c = comp(r, "orders.fifo") ?? comp(r, "orders-fifo");
  assert.ok(c, (r.spec.components as Array<{ id: string }>).map((x) => x.id).join());
  assert.equal(c!.props.ordered, true);
  assert.equal((c!.props.deadLetter as Raw).to, (r.spec.components as Array<{ id: string }>).find((x) => /dlq/.test(x.id))!.id);
  assert.equal(meta(r, `components.${c!.id}.ordered`)?.needs_review, true);
});

test("SQS: DLQ 가 다른 계정이고 이름만 같은 큐가 이 가져오기에 있어도 연결하지 않음 (검토 표시)", () => {
  const r = normalizeV2(inv([q("orders", { RedrivePolicy: redrive("arn:aws:sqs:ap-northeast-1:999999999999:orders-dlq") }),
    q("orders-dlq", {}, ACC)])).result;
  const dl = comp(r, "orders")!.props.deadLetter as Raw;
  assert.equal(dl.to, undefined, "다른 계정 DLQ 를 이름만 보고 같은 큐로 연결함");
  const m = meta(r, "components.orders.deadLetter");
  assert.equal(m?.needs_review, true);
  assert.ok(m?.confidence < 1);
});

test("SQS: DLQ 가 자기 자신이거나 서로 가리켜도(순환) 터지지 않고 명세 검사 오류 없음", () => {
  const self = normalizeV2(inv([q("a", { RedrivePolicy: redrive(`arn:aws:sqs:ap-northeast-1:${ACC}:a`) })])).result;
  assert.equal((comp(self, "a")!.props.deadLetter as Raw).to, undefined);
  assert.ok(meta(self, "components.a.deadLetter")?.needs_review);
  const cyc = normalizeV2(inv([q("a", { RedrivePolicy: redrive(`arn:aws:sqs:ap-northeast-1:${ACC}:b`) }), q("b", { RedrivePolicy: redrive(`arn:aws:sqs:ap-northeast-1:${ACC}:a`) })])).result;
  assert.equal(ImportResultV2.safeParse(cyc).success, true);
  assert.equal((comp(cyc, "a")!.props.deadLetter as Raw).to, "b");
});

test("SQS: 깨진 RedrivePolicy·maxReceiveCount 가 글자·대상 ARN 없음 → DLQ 없음 + 검토", () => {
  const broken = normalizeV2(inv([q("a", { RedrivePolicy: "{not json" })])).result;
  assert.equal(comp(broken, "a")!.props.deadLetter, undefined);
  assert.equal(meta(broken, "components.a.deadLetter")?.needs_review, true);
  const noTarget = normalizeV2(inv([q("a", { RedrivePolicy: JSON.stringify({ maxReceiveCount: 3 }) })])).result;
  assert.equal(comp(noTarget, "a")!.props.deadLetter, undefined);
});

test("SQS: 큐 URL 끝 슬래시·이름 없음은 skip 되고 unmapped 에 남음", () => {
  const r = normalizeV2(inv([{ kind: "sqs.queue", QueueUrl: "https://sqs.x.amazonaws.com/1/orders/" }, { kind: "sqs.queue", QueueUrl: "/" }, { kind: "sqs.queue" }])).result;
  assert.deepEqual((r.spec.components as Array<{ id: string }>).map((c) => c.id), ["orders"]);
  assert.equal(r.unmapped.length, 2);
});

// ── ElastiCache / Memorystore ──
const ec = (o: Raw = {}): Raw => ({ kind: "elasticache.replicationGroup", ReplicationGroupId: "rc", Engine: "redis", EngineVersion: "7.1.0", CacheNodeType: "cache.r6g.large",
  ClusterEnabled: false, NodeGroups: 1, TransitEncryptionEnabled: false, AuthTokenEnabled: false, MultiAZ: "disabled", PrimaryEndpoint: "rc.x.cache.amazonaws.com", ConfigurationEndpoint: null, ...o });

test("ElastiCache: 클러스터 모드 켜짐 — 샤드 수·구성 엔드포인트가 연결 근거, 기본 엔드포인트는 별칭", () => {
  const cfg = "rc.clustercfg.x.cache.amazonaws.com";
  const r = normalizeV2(inv([ec({ ClusterEnabled: true, NodeGroups: 3, PrimaryEndpoint: null, ConfigurationEndpoint: cfg }),
    { kind: "k8s.deployment", imageDigest: "sha256:" + "ab".repeat(32), metadata: { name: "api", namespace: "n", labels: { app: "api" } }, spec: { replicas: 1, selector: { matchLabels: { app: "api" } },
      template: { metadata: { labels: { app: "api" } }, spec: { containers: [{ name: "api", image: "ghcr.io/d/api:1", ports: [{ containerPort: 80 }], env: [{ name: "REDIS", value: `${cfg}:6379` }] }] } } } }])).result;
  const c = comp(r, "rc")!;
  assert.equal(c.props.clusterMode, true);
  assert.equal(c.props.shards, 3);
  assert.ok(r.spec.links.some((l) => l.from === "api" && l.to === "rc"), JSON.stringify(r.spec.links));
});

test("ElastiCache: 클러스터 모드 꺼짐이면 shards 칸이 없고, 엔진 memcached·valkey 는 받고 모르는 엔진은 skip", () => {
  const r = normalizeV2(inv([ec({ ReplicationGroupId: "a", NodeGroups: 2 }), ec({ ReplicationGroupId: "v", Engine: "Valkey" }), ec({ ReplicationGroupId: "m", Engine: "dynamodb" }), ec({ ReplicationGroupId: undefined })])).result;
  assert.equal(comp(r, "a")!.props.shards, undefined);
  assert.equal(comp(r, "v")!.props.engine, "valkey");
  assert.equal(comp(r, "m"), undefined);
  assert.equal(r.unmapped.length, 2);
  assert.equal(ImportResultV2.safeParse(r).success, true);
});

test("ElastiCache: 인증·전송 암호화를 못 읽으면 null + 검토(0.6), 읽었으면 값 그대로 (꺼짐도 보임)", () => {
  const r = normalizeV2(inv([ec({ ReplicationGroupId: "u", TransitEncryptionEnabled: null, AuthTokenEnabled: null }), ec()])).result;
  assert.equal(comp(r, "u")!.props.tls, null);
  assert.equal(meta(r, "components.u.tls")?.needs_review, true);
  assert.equal(comp(r, "rc")!.props.tls, false);
  assert.equal(meta(r, "components.rc.tls")?.needs_review, false);
});

test("ElastiCache: 인증 토큰 값이 원본에 섞여 있어도 명세·메타에 안 나옴", () => {
  const r = normalizeV2(inv([ec({ AuthToken: "tok-NEVER-IN-SPEC", Password: "pw-NEVER" })]));
  assert.ok(!JSON.stringify(r.result).includes("NEVER"));
});

test("Memorystore: 모르는 버전 문자열·tier 없음·암호화 DISABLED", () => {
  const r = normalizeV2(inv([{ kind: "memorystore.instance", name: "projects/p/locations/l/instances/m1", redisVersion: "REDIS_6_X", memorySizeGb: 0, transitEncryptionMode: "DISABLED", authEnabled: false, host: "10.0.0.5", port: 6379 }], "gcp")).result;
  const c = comp(r, "m1")!;
  assert.equal(c.props.version, undefined);
  assert.equal(c.props.memoryMiB, null);
  assert.equal(c.props.tls, false);
  assert.equal(c.props.ha, undefined);
  assert.equal(meta(r, "components.m1.memoryMiB")?.needs_review, true);
});

// ── GCS ──
test("GCS: 수명 주기 — 나이 외 조건(isLive·numNewerVersions·createdBefore)이 있는 규칙은 넣지 않고 검토 표시", () => {
  const r = normalizeV2(inv([{ kind: "gcs.bucket", name: "g", versioning: false, publicAccessPrevention: "inherited", allUsersBinding: false, lifecycleRules: [
    { action: { type: "Delete" }, condition: { age: 30, isLive: false } },
    { action: { type: "Delete" }, condition: { age: 40, numNewerVersions: 3 } },
    { action: { type: "Delete" }, condition: { createdBefore: "2024-01-01" } },
    { action: { type: "Delete" }, condition: { age: 7, matchesPrefix: ["tmp/"] } },
    { action: { type: "SetStorageClass" }, condition: { age: 60 } },
  ] }], "gcp")).result;
  assert.deepEqual(comp(r, "g")!.props.lifecycle, [{ prefix: "", toColdAfterDays: 60 }, { prefix: "tmp/", expireDays: 7 }]);
  assert.match(meta(r, "components.g.lifecycle")?.rationale ?? "", /3개/);
});

test("GCS: 빈 버킷·바인딩 못 읽음·publicAccessPrevention 없음 → public null + 검토, 이름 없음은 skip", () => {
  const r = normalizeV2(inv([{ kind: "gcs.bucket", name: "g", versioning: null }, { kind: "gcs.bucket" }], "gcp")).result;
  assert.equal(comp(r, "g")!.props.public, null);
  assert.equal(comp(r, "g")!.props.versioning, false);
  assert.equal(meta(r, "components.g.public")?.needs_review, true);
  assert.equal(r.unmapped.length, 1);
});

// ── Pub/Sub ──
test("Pub/Sub: DLQ 토픽 연결, 다른 프로젝트의 같은 이름 토픽은 연결하지 않음", () => {
  const topic = (p: string, n: string, dl?: string): Raw => ({ kind: "pubsub.topic", name: `projects/${p}/topics/${n}`, messageRetentionDuration: null,
    subscription: { ackDeadlineSeconds: 10, enableMessageOrdering: false, ...(dl ? { deadLetterPolicy: { deadLetterTopic: dl, maxDeliveryAttempts: 5 } } : {}) } });
  const ok = normalizeV2(inv([topic("p", "ev", "projects/p/topics/ev-dlq"), topic("p", "ev-dlq")], "gcp")).result;
  assert.deepEqual(comp(ok, "ev")!.props.deadLetter, { to: "ev-dlq", maxReceive: 5 });
  const other = normalizeV2(inv([topic("p", "ev", "projects/other/topics/ev-dlq"), topic("p", "ev-dlq")], "gcp")).result;
  assert.equal((comp(other, "ev")!.props.deadLetter as Raw).to, undefined, "다른 프로젝트 토픽을 이름만 보고 연결함");
  assert.equal(meta(other, "components.ev.deadLetter")?.needs_review, true);
});

test("Pub/Sub: 구독 없음 → ack·순서·DLQ 모름 검토 표시, 보존 기간 형식이 깨지면 칸을 비움", () => {
  const r = normalizeV2(inv([{ kind: "pubsub.topic", name: "projects/p/topics/t", messageRetentionDuration: "soon", subscription: null }], "gcp")).result;
  const c = comp(r, "t")!;
  assert.equal(c.props.retentionSec, undefined);
  assert.equal(c.props.ackTimeoutSec, undefined);
  assert.equal(meta(r, "components.t.ackTimeoutSec")?.needs_review, true);
});

// ── 이름 충돌·결정성 ──
test("이름 충돌: 같은 이름의 S3 버킷·SQS 큐·앱이 있어도 id 가 겹치지 않고 DLQ 는 큐끼리만 연결", () => {
  const r = normalizeV2(inv([bucket({ Name: "orders", Arn: "arn:aws:s3:::orders" }), q("orders", { RedrivePolicy: redrive(`arn:aws:sqs:ap-northeast-1:${ACC}:orders-dlq`) }), q("orders-dlq")])).result;
  const ids = (r.spec.components as Array<{ id: string }>).map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, ids.join());
  assert.equal(ids.length, 3);
  const queue = (r.spec.components as Array<{ id: string; kind: string; props: Raw }>).find((c) => c.kind === "queue" && (c.props.deadLetter as Raw | undefined))!;
  assert.equal((queue.props.deadLetter as Raw).to, "orders-dlq");
  assert.deepEqual(checkV2(r.spec).errors, []);
});

test("결정성: 6종 자원을 섞어 넣는 순서 3가지가 명세·메타·unmapped 모두 같음", () => {
  const items = [bucket({ Name: "z" }), bucket({ Name: "a", Arn: "arn:aws:s3:::a" }), q("m", { RedrivePolicy: redrive(`arn:aws:sqs:ap-northeast-1:${ACC}:n`) }), q("n"), ec(),
    { kind: "gcs.bucket", name: "g", versioning: true, allUsersBinding: false }, { kind: "pubsub.topic", name: "projects/p/topics/t" },
    { kind: "memorystore.instance", name: "projects/p/locations/l/instances/m2", redisVersion: "REDIS_7_0", memorySizeGb: 1, tier: "BASIC" }];
  const base = normalizeV2(inv(items));
  for (const order of [[...items].reverse(), [...items.slice(3), ...items.slice(0, 3)]]) {
    const o = normalizeV2(inv(order));
    assert.deepEqual(o.result.spec, base.result.spec);
    assert.deepEqual(o.result.fieldMeta, base.result.fieldMeta);
    assert.deepEqual(o.result.unmapped, base.result.unmapped);
  }
});

// ── discover ──
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
  [/^kubectl get pods/, { out: { items: [{ metadata: { name: "p1", namespace: "shop", labels: { app: "shop-api" } }, status: { containerStatuses: [{ name: "api", imageID: "ghcr.io/demo/shop-api@sha256:" + "ab".repeat(32) }] } }] } }],
  [/^kubectl get nodes/, { out: { items: [] } }],
];
const AWS_BASE: Array<[RegExp, Reply]> = [
  [/^aws sts get-caller-identity/, { out: { Account: ACC } }], [/^aws eks list-clusters/, { out: { clusters: ["c1"] } }],
  [/^aws eks describe-cluster/, { out: { cluster: { version: "1.31", resourcesVpcConfig: { vpcId: "vpc-1" } } } }], [/^aws eks update-kubeconfig/, { out: "ok" }],
  [/^aws rds describe-db-instances/, { out: { DBInstances: [] } }], [/^aws ec2 describe-vpcs/, { out: { Vpcs: [] } }], [/^aws elbv2/, { out: { LoadBalancers: [] } }],
  [/^aws ecr/, { out: { repositories: [] } }], [/^aws secretsmanager/, { out: { SecretList: [] } }], ...KC,
];
const GCP_BASE: Array<[RegExp, Reply]> = [
  [/^gcloud projects describe/, { out: { projectId: "p" } }], [/^gcloud container clusters list/, { out: [{ name: "g1", location: "asia-northeast3" }] }],
  [/^gcloud container clusters get-credentials/, { out: "ok" }], [/^gcloud sql instances list/, { out: [] }], [/^gcloud compute/, { out: [] }],
  [/^gcloud artifacts/, { out: [] }], [/^gcloud secrets/, { out: [] }], ...KC,
];
const itemsOf = (raw: any): Raw[] => (raw.inventory?.items ?? raw.items ?? []) as Raw[];
const DATA_CMD = /^aws (s3api|sqs|elasticache|cloudwatch)|^gcloud (storage|pubsub|redis)/;

test("discover v1(깃발 없음·ir:v1): AWS·GCP 모두 데이터 자원 명령 0번, 원본에 데이터 종류 없음", async () => {
  for (const opts of [undefined, { ir: "v1" as const }]) {
    const a = fakeExec(AWS_BASE);
    const rawA = await discoverAws({ exec: a.exec, env: { AWS_REGION: "ap-northeast-1" } }, opts);
    assert.deepEqual(a.calls.filter((c) => DATA_CMD.test(c)), []);
    assert.ok(!itemsOf(rawA).some((i) => /^(s3|sqs|elasticache)\./.test(String(i.kind))));
    const g = fakeExec(GCP_BASE);
    const rawG = await discoverGcp({ exec: g.exec, env: { GCP_PROJECT: "p" } }, opts);
    assert.deepEqual(g.calls.filter((c) => DATA_CMD.test(c)), []);
    assert.ok(!itemsOf(rawG).some((i) => /^(gcs|pubsub|memorystore)\./.test(String(i.kind))));
  }
});

test("discover AWS v2: 버킷 목록이 비어(출력 없음·Buckets 없음) 있어도 오류 없이 계속, 정렬은 이름순, 비밀 안 읽음", async () => {
  for (const out of [null, {}, { Buckets: [] }] as unknown[]) {
    const { exec, calls } = fakeExec([[/^aws s3api list-buckets/, { out }], [/^aws sqs list-queues/, { out: {} }],
      [/^aws elasticache describe-replication-groups/, { out: { ReplicationGroups: [] } }], ...AWS_BASE]);
    const raw: any = await discoverAws({ exec, env: { AWS_REGION: "ap-northeast-1" } }, { ir: "v2" });
    assert.ok(!itemsOf(raw).some((i) => i.kind === "s3.bucket" || i.kind === "sqs.queue"));
    assert.ok(!calls.some((c) => /get-bucket-policy |get-secret|get-parameter|receive-message|get-object/.test(c)), calls.join("\n"));
  }
});

test("discover AWS v2: 큐 하나의 속성 읽기가 실패해도 그 큐만 빠지고, 오류 글에 계정 번호가 안 남음", async () => {
  const { exec } = fakeExec([
    [/^aws s3api list-buckets/, { out: { Buckets: [] } }],
    [/^aws sqs list-queues/, { out: { QueueUrls: [`https://sqs.x.amazonaws.com/${ACC}/z`, `https://sqs.x.amazonaws.com/${ACC}/a`] } }],
    [/get-queue-attributes.*\/z/, { code: 254, err: `AccessDenied arn:aws:sqs:x:${ACC}:z` }],
    [/get-queue-attributes.*\/a/, { out: { Attributes: { QueueArn: `arn:aws:sqs:x:${ACC}:a` } } }],
    [/^aws elasticache describe-replication-groups/, { out: { ReplicationGroups: [] } }], ...AWS_BASE]);
  const raw: any = await discoverAws({ exec, env: { AWS_REGION: "ap-northeast-1" } }, { ir: "v2" });
  const qs = itemsOf(raw).filter((i) => i.kind === "sqs.queue");
  assert.equal(qs.length, 1);
  assert.match(qs[0]!.QueueUrl, /\/a$/);
  const notes = itemsOf(raw).filter((i) => i.kind === "import.note").map((i) => JSON.stringify(i)).join("\n");
  assert.match(notes, /SQS z 속성 못 읽음/, notes);
  assert.ok(!notes.includes(ACC), "오류 글에 계정 번호가 남음");
});

test("discover GCP v2: 버킷 IAM 정책 읽기 실패 → allUsersBinding null(=확인 못 함), 구독 목록 실패 → 구독 없이 토픽만", async () => {
  const { exec } = fakeExec([
    [/gcloud storage buckets list/, { out: [{ name: "b" }] }], [/gcloud storage buckets get-iam-policy/, { code: 1, err: "403" }],
    [/gcloud pubsub topics list/, { out: [{ name: "projects/p/topics/t" }] }], [/gcloud pubsub subscriptions list/, { code: 1, err: "403" }],
    [/gcloud redis instances list/, { out: [] }], ...GCP_BASE]);
  const raw: any = await discoverGcp({ exec, env: { GCP_PROJECT: "p" } }, { ir: "v2" });
  const it = itemsOf(raw);
  assert.equal(it.find((i) => i.kind === "gcs.bucket")!.allUsersBinding, null);
  assert.equal(it.find((i) => i.kind === "pubsub.topic")!.subscription, null);
  const r = normalizeV2({ provider: "gcp", coverage: {}, items: it } as RawInventory).result;
  assert.equal(comp(r, "b")!.props.public, null);
});
