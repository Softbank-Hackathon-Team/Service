// VE2EDATA2: E2EDATA2 고침 ① (Pub/Sub DLQ 토픽 → queue 승격) 경계. DLQ 사슬 2단·여러 곳이 같은 DLQ·같은 토픽이 DLQ 이면서 일반 구독·순환·자기 자신·다른 프로젝트
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, ImportResultV2, checkV2, type RawInventory } from "@svc/contracts";
import { applySpecV2Patch } from "@svc/core";
import { normalizeV2 } from "../src/import/pipeline.js";
import { v2Blockers, targetBuilderFor } from "../src/index.js";

type Raw = Record<string, any>;
const topic = (n: string, dl?: string, sub: Raw = {}, p = "p"): Raw => ({ kind: "pubsub.topic", name: `projects/${p}/topics/${n}`, messageRetentionDuration: "86400s",
  subscription: { ackDeadlineSeconds: 20, enableMessageOrdering: false, ...(dl ? { deadLetterPolicy: { deadLetterTopic: dl, maxDeliveryAttempts: 5 } } : {}), ...sub } });
const gcp = (items: Raw[]): RawInventory => ({ provider: "gcp", coverage: {}, items } as unknown as RawInventory);
const T = (n: string, p = "p") => `projects/${p}/topics/${n}`;
const comp = (r: { spec: AppSpecV2 }, id: string) => r.spec.components.find((c) => c.id === id) as unknown as { id: string; kind: string; props: Raw } | undefined;
const blockers = (spec: AppSpecV2) => (["aws", "gcp"] as const).flatMap((p) => v2Blockers(spec, targetBuilderFor(p).capabilities()).unsupported.filter((m) => /DLQ|queue|topic/.test(m)));

test("DLQ 사슬 2단(a→b→c): b·c 모두 queue 로 올라가고 검토 표시, a 는 topic. 도착 검증은 b 의 DLQ 때문에 '한 단계만' 으로 막고 이유가 정확함", () => {
  const { result } = normalizeV2(gcp([topic("a", T("b")), topic("b", T("c")), topic("c")]));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  assert.deepEqual(checkV2(result.spec).errors, []);
  assert.equal(comp(result, "a")!.props.model, "topic");
  assert.equal(comp(result, "b")!.props.model, "queue");
  assert.equal(comp(result, "c")!.props.model, "queue");
  assert.equal((comp(result, "a")!.props.deadLetter as Raw).to, "b");
  assert.equal((comp(result, "b")!.props.deadLetter as Raw).to, "c");
  for (const id of ["b", "c"]) assert.equal(result.fieldMeta[`components.${id}.model`]?.needs_review, true, id);
  const msgs = blockers(result.spec);
  assert.ok(msgs.every((m) => /한 단계만/.test(m)), msgs.join("\n"));
  assert.ok(msgs.length >= 2, "aws·gcp 둘 다 막음");
});

test("사슬은 사람이 b 의 DLQ 를 비우면(components.b.deadLetter = {}) 풀림: PATCH 규칙 → AppSpecV2 → 막힘 0", () => {
  const { result } = normalizeV2(gcp([topic("a", T("b")), topic("b", T("c")), topic("c")]));
  const next = applySpecV2Patch({ spec: result.spec, fieldMeta: result.fieldMeta as never }, { changes: [{ path: "components.b.deadLetter", value: {} }] });
  const spec = AppSpecV2.parse(next.spec);
  assert.deepEqual(checkV2(spec).errors, []);
  assert.deepEqual(blockers(spec), []);
});

test("여러 큐가 같은 DLQ 를 씀: 한 번만 올라가고 검토 이유는 id 순 첫 번째 큐를 가리킴, 입력 순서를 섞어도 같음", () => {
  const items = [topic("x", T("dead")), topic("y", T("dead")), topic("dead")];
  const a = normalizeV2(gcp(items)).result, b = normalizeV2(gcp([...items].reverse())).result;
  assert.deepEqual(a.spec, b.spec);
  assert.deepEqual(a.fieldMeta, b.fieldMeta);
  assert.equal(comp(a, "dead")!.props.model, "queue");
  assert.match(a.fieldMeta["components.dead.model"]!.rationale ?? "", /^x /);
  assert.deepEqual(blockers(a.spec), []);
});

test("같은 토픽이 DLQ 이면서 자기 구독(ack·순서·보존)도 있음: 큐로 올라가도 그 값은 그대로, 앱 env 로 이어진 링크도 유지", () => {
  const dead = topic("dead", undefined, { ackDeadlineSeconds: 45, enableMessageOrdering: true });
  const app: Raw = { kind: "k8s.deployment", imageDigest: "sha256:" + "ab".repeat(32), metadata: { name: "worker", namespace: "n", labels: { app: "worker" } },
    spec: { replicas: 1, selector: { matchLabels: { app: "worker" } }, template: { metadata: { labels: { app: "worker" } }, spec: { containers: [{
      name: "w", image: "ghcr.io/d/worker:1", ports: [{ containerPort: 80 }], env: [{ name: "DEAD_TOPIC", value: "dead" }] }] } } } };
  const { result } = normalizeV2(gcp([topic("orders", T("dead"), { enableMessageOrdering: true }), dead, app]));
  const d = comp(result, "dead")!;
  assert.equal(d.props.model, "queue");
  assert.equal(d.props.ackTimeoutSec, 45);
  assert.equal(d.props.ordered, true);
  assert.equal(d.props.retentionSec, 86400);
  assert.deepEqual(checkV2(result.spec).errors, []);
  assert.deepEqual(blockers(result.spec), []);
  assert.ok(result.spec.links.some((l) => l.from === "worker" && l.to === "dead"), JSON.stringify(result.spec.links));
  // 원본 큐는 순서 없음인데 DLQ 만 순서 있음 → 도착이 못 그리는 조합이라 계획 전에 막힘 (승격이 이 불일치를 만들지는 않음, 원본 설정 그대로)
  const mixed = normalizeV2(gcp([topic("orders", T("dead")), dead])).result;
  const mb = blockers(mixed.spec).map((m) => m.replace(/^.*: /, ""));
  assert.ok(mb.length >= 1 && mb.every((m) => m === "kind.queue.dlqMixedOrder"), mb.join());
});

test("순환(a↔b)·자기 자신(c→c)은 터지지 않음: 순환은 둘 다 queue 가 되고 '한 단계만' 으로 막힘, 자기 자신은 못 찾음 처리(topic 그대로·to 없음)", () => {
  const { result } = normalizeV2(gcp([topic("a", T("b")), topic("b", T("a")), topic("c", T("c"))]));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  assert.equal(comp(result, "a")!.props.model, "queue");
  assert.equal(comp(result, "b")!.props.model, "queue");
  assert.equal(comp(result, "c")!.props.model, "topic");
  assert.equal((comp(result, "c")!.props.deadLetter as Raw).to, undefined);
  assert.equal(result.fieldMeta["components.c.deadLetter"]?.needs_review, true);
  assert.ok(blockers(result.spec).some((m) => /한 단계만/.test(m)));
});

test("거부: DLQ 가 다른 프로젝트의 같은 이름 토픽이면 연결도 승격도 안 함 (이 가져오기의 그 이름 토픽은 topic 그대로)", () => {
  const { result } = normalizeV2(gcp([topic("orders", T("dead", "other-project")), topic("dead")]));
  assert.equal((comp(result, "orders")!.props.deadLetter as Raw).to, undefined);
  assert.equal(comp(result, "dead")!.props.model, "topic");
  assert.equal(result.fieldMeta["components.orders.deadLetter"]?.needs_review, true);
  assert.equal(result.fieldMeta["components.dead.model"]?.needs_review ?? false, false);
});

test("SQS(AWS 출발)는 승격 없음: 사슬 2단도 model 칸이 안 생기고 같은 '한 단계만' 규칙으로 막힘", () => {
  const q = (n: string, dl?: string): Raw => ({ kind: "sqs.queue", QueueUrl: `https://sqs.ap-northeast-1.amazonaws.com/123456789012/${n}`,
    Attributes: { QueueArn: `arn:aws:sqs:ap-northeast-1:123456789012:${n}`, ...(dl ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: `arn:aws:sqs:ap-northeast-1:123456789012:${dl}`, maxReceiveCount: 3 }) } : {}) } });
  const { result } = normalizeV2({ provider: "aws", coverage: {}, items: [q("a", "b"), q("b", "c"), q("c")] } as unknown as RawInventory);
  for (const id of ["a", "b", "c"]) assert.equal(comp(result, id)!.props.model, "queue", id);
  assert.equal(result.fieldMeta["components.b.model"]?.needs_review ?? false, false);
  assert.ok(blockers(result.spec).some((m) => /한 단계만/.test(m)));
});

test("posture: 방화벽 못 읽음(unknown)은 사람이 정할 때까지 needsHuman, 항목을 지우거나 ingress 를 배열로 바꾸면 풀리고 다른 항목은 영향 없음", () => {
  const cache: Raw = { kind: "memorystore.instance", name: "projects/p/locations/l/instances/c1", redisVersion: "REDIS_7_0", memorySizeGb: 1, tier: "BASIC", transitEncryptionMode: "SERVER_AUTHENTICATION", authEnabled: true, host: "10.0.0.3", port: 6379 };
  const { result } = normalizeV2(gcp([cache]));
  const caps = targetBuilderFor("gcp").capabilities();
  const human = (s: AppSpecV2) => v2Blockers(s, caps).needsHuman.filter((m) => /방화벽/.test(m));
  assert.equal(human(result.spec).length, 1);
  const set = (network: unknown[]) => AppSpecV2.parse({ ...result.spec, posture: { ...result.spec.posture, network } });
  assert.equal(human(set([])).length, 0, "항목을 지우면 풀림 (= 의존성만 연다고 사람이 정함)");
  assert.equal(human(set([{ scope: "component", subject: "c1", mode: "mirror", ingress: [], public: false }])).length, 0);
  assert.equal(human(set([{ scope: "component", subject: "c1", mode: "mirror", ingress: "unknown", public: null }])).length, 1);
});
