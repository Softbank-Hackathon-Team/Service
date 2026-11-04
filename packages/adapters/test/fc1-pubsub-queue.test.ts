// fc1: Pub/Sub 구독 전부 읽기(PS-1), 구독 보관·만료(DM-6), push 구독(B-1 일부), 큐 시간 범위(QR-1), 범위 밖 보관 검토 표시(DM-8 큐)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AppSpecV2, ImportResultV2, checkV2, type RawInventory, type TargetEnv } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { targetBuilderFor, v2Blockers } from "../src/index.js";
import { v2PrecheckItems } from "../src/target/plan-v2.js";
import { queueRangeProblems } from "../src/target/data.js";

type Raw = Record<string, any>;
const gcp = (items: Raw[]): RawInventory => ({ provider: "gcp", coverage: {}, items } as unknown as RawInventory);
const comp = (spec: AppSpecV2, id: string) => spec.components.find((c) => c.id === id) as unknown as { id: string; kind: string; props: Raw };
const sub = (n: string, o: Raw = {}): Raw => ({ name: `projects/p/subscriptions/${n}`, ackDeadlineSeconds: 30, enableMessageOrdering: false,
  messageRetentionDuration: "604800s", expirationPolicy: {}, ...o });
const topic = (n: string, subs: Raw[] | null, o: Raw = {}): Raw => ({ kind: "pubsub.topic", name: `projects/p/topics/${n}`, subscriptions: subs, ...o });
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;
const qJson = (p: "aws" | "gcp", spec: AppSpecV2) => JSON.parse(String(targetBuilderFor(p).toTerraformV2(spec, T(p)).vars.queue_json)) as Raw[];
const unsup = (p: "aws" | "gcp", spec: AppSpecV2) => v2Blockers(spec, targetBuilderFor(p).capabilities());
const meta = (r: { fieldMeta: Record<string, any> }, k: string) => r.fieldMeta[k];

test("PS-1·DM-6: pull 구독 하나 → model=queue, 보관·ack·만료는 구독 값 (토픽 보관은 안 씀, 검토 표시) → 도착 변수까지 같은 값", () => {
  const { result } = normalizeV2(gcp([topic("jobs", [sub("jobs-worker", { expirationPolicy: { ttl: "2678400s" }, retainAckedMessages: true })], { messageRetentionDuration: "86400s" })]));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  assert.deepEqual(checkV2(result.spec).errors, []);
  const c = comp(result.spec, "jobs");
  assert.equal(c.props.model, "queue");
  assert.equal(c.props.retentionSec, 604800, "구독 보관 7일 (토픽 보관 1일이 아님)");
  assert.equal(c.props.ackTimeoutSec, 30);
  assert.equal(c.props.idleExpirySec, 2678400);
  assert.equal(c.props.retainAcked, true);
  assert.equal(meta(result, "components.jobs.retentionSec")?.needs_review, true, "토픽 보관을 버린 이유 표시");
  const g = qJson("gcp", result.spec)[0]!;
  assert.equal(g.model, "queue"); assert.equal(g.retention_sec, 604800); assert.equal(g.idle_expiry_sec, 2678400); assert.equal(g.retain_acked, true);
  assert.equal(g.subscriptions_json, "[]");
  // 만료 안 함({}) 은 idleExpirySec 없음 → 모듈 ttl "" (상품 기본 31일 아님)
  const never = normalizeV2(gcp([topic("jobs", [sub("jobs-worker")])])).result;
  assert.equal(comp(never.spec, "jobs").props.idleExpirySec, undefined);
  assert.equal(qJson("gcp", never.spec)[0]!.idle_expiry_sec, null);
  const mod = readFileSync(new URL("../../../infra/modules/gcp/kinds/queue/main.tf", import.meta.url), "utf8");
  assert.match(mod, /ttl = var\.cfg\.idle_expiry_sec == null \? "" :/);
  assert.doesNotMatch(mod, /min\(100, max\(5/, "QR-1: DLQ 재시도 횟수를 조용히 자르지 않음");
  // AWS 도착: retainAcked 는 SQS 에 없음 → 막음 (조용히 버리지 않음)
  assert.ok(unsup("aws", result.spec).unsupported.some((m) => /kind\.queue\.retainAcked/.test(m)));
  assert.ok(!unsup("aws", never.spec).unsupported.some((m) => /kind\.queue/.test(m)), "pull 구독 하나·기본 설정은 AWS(SQS)로 감");
});

test("PS-1: 구독 둘 이상 → topic + 구독 목록, GCP 는 구독마다 만듦, AWS 는 SNS→SQS 가 없어 막음. 구독 0개 = topic, 못 읽음 = 검토", () => {
  const { result } = normalizeV2(gcp([topic("events", [sub("b-audit", { filter: "attributes.kind=\"order\"" }), sub("a-mail", { ackDeadlineSeconds: 60 })])]));
  const c = comp(result.spec, "events");
  assert.equal(c.props.model, "topic");
  assert.deepEqual(c.props.subscriptions.map((s: Raw) => s.name), ["a-mail", "b-audit"]);
  assert.equal(c.props.subscriptions[0].ackTimeoutSec, 60);
  assert.equal(c.props.subscriptions[1].filter, "attributes.kind=\"order\"");
  assert.deepEqual(unsup("gcp", result.spec).unsupported, []);
  const subs = JSON.parse(qJson("gcp", result.spec)[0]!.subscriptions_json) as Raw[];
  assert.equal(subs.length, 2);
  assert.equal(new Set(subs.map((s) => s.name)).size, 2);
  assert.ok(subs.every((s) => /^app-/.test(s.name)));
  assert.ok(unsup("aws", result.spec).unsupported.some((m) => /kind\.queue\.subscriptions/.test(m)));
  // 구독 목록 안 DLQ 는 아직 못 그림 → GCP 도 막음
  const dl = normalizeV2(gcp([topic("events", [sub("a", { deadLetterPolicy: { deadLetterTopic: "projects/p/topics/dlq", maxDeliveryAttempts: 7 } }), sub("b")]), topic("dlq", [])])).result;
  assert.ok(unsup("gcp", dl.spec).unsupported.some((m) => /구독 a 의 DLQ/.test(m)));
  assert.equal(comp(normalizeV2(gcp([topic("t", [])])).result.spec, "t").props.model, "topic");
  const unk = normalizeV2(gcp([topic("t", null)])).result;
  assert.equal(comp(unk.spec, "t").props.model, "topic");
  assert.equal(meta(unk, "components.t.ackTimeoutSec")?.needs_review, true);
});

test("B-1: push 구독 주소가 이 앱 입구면 그대로, 입구가 아니면(출발 Cloud Run URL) 사람에게. AWS 는 push 를 못 그려 막음", () => {
  const withEntry = (endpoint: string) => {
    const r = normalizeV2(gcp([topic("hooks", [sub("hooks-push", { pushConfig: { pushEndpoint: endpoint } })])])).result;
    const s = structuredClone(r.spec) as Raw;
    s.components.push({ id: "web", kind: "service", props: { runtime: "k8s", origin: { runtime: "k8s", product: "unknown" },
      image: { source: "registry", repository: "r/web", digest: "sha256:" + "a".repeat(64) }, ports: [{ port: 8080, protocol: "TCP" }],
      probes: { readiness: { type: "http", path: "/healthz", port: 8080 } }, replicas: { min: 1, max: 1 }, serviceAccount: "default",
      resources: { request: { cpuMilli: 500, memMiB: 1024 } }, env: [] } });
    s.entry = { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], routes: [{ matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "web", port: 8080, weight: 1 }] }] }] };
    return AppSpecV2.parse(s);
  };
  const ok = withEntry("https://shop.example.com/push");
  assert.deepEqual(comp(ok, "hooks").props.push, { endpoint: "https://shop.example.com/push" });
  assert.ok(!unsup("gcp", ok).needsHuman.some((m) => /push/.test(m)));
  assert.equal(qJson("gcp", ok)[0]!.push_endpoint, "https://shop.example.com/push");
  const bad = withEntry("https://hooks-abc-uc.a.run.app/push");
  assert.ok(unsup("gcp", bad).needsHuman.some((m) => /hooks: push 주소 https:\/\/hooks-abc-uc\.a\.run\.app\/push 는 이 앱 입구가 아님/.test(m)));
  assert.ok(unsup("aws", ok).unsupported.some((m) => /kind\.queue\.push/.test(m)));
});

test("QR-1: 도착 범위 밖 시간 값은 자르지 않고 계획 전 사람 확인 (SQS 가시성 900·보관 14일 → GCP)", () => {
  const sqs = { kind: "sqs.queue", QueueUrl: "https://sqs.ap-northeast-1.amazonaws.com/1/work", Attributes: { MessageRetentionPeriod: "1209600", VisibilityTimeout: "900" } };
  const r = normalizeV2({ provider: "aws", coverage: {}, items: [sqs] } as unknown as RawInventory).result;
  assert.deepEqual(queueRangeProblems("aws", r.spec), [], "SQS → SQS 는 범위 안");
  const g = queueRangeProblems("gcp", r.spec);
  assert.ok(g.some((m) => /work: retentionSec=1209600 은 gcp 도착 범위 600~604800 밖/.test(m)), g.join("\n"));
  assert.ok(g.some((m) => /work: ackTimeoutSec=900 은 gcp 도착 범위 10~600 밖/.test(m)), g.join("\n"));
  const items = v2PrecheckItems("gcp", { specV2: r.spec });
  assert.ok(items.some((i) => i.level === "block" && /ackTimeoutSec=900/.test(i.message)), items.map((i) => i.message).join("\n"));
});

test("QR-1·DM-8 거부: 범위 안 값은 아무 말 없음, SQS 보관이 IR 범위 밖이면 칸은 비우되 검토 표시", () => {
  const ok = normalizeV2(gcp([topic("jobs", [sub("jobs-worker", { messageRetentionDuration: "86400s", ackDeadlineSeconds: 60 })])])).result;
  assert.deepEqual(queueRangeProblems("gcp", ok.spec), []);
  assert.deepEqual(queueRangeProblems("aws", ok.spec), []);
  const sqs = { kind: "sqs.queue", QueueUrl: "https://sqs.ap-northeast-1.amazonaws.com/1/w", Attributes: { MessageRetentionPeriod: "30" } };
  const r = normalizeV2({ provider: "aws", coverage: {}, items: [sqs] } as unknown as RawInventory).result;
  assert.equal(comp(r.spec, "w").props.retentionSec, undefined);
  assert.equal(meta(r, "components.w.retentionSec")?.needs_review, true);
});
