// TA12c: 데이터 자원 남은 3개 — ① GCP Pub/Sub DLQ(토픽) → queue ② 데이터 링크 의도(read·write·readwrite·admin) 렌더 ③ 사람 확인(needsHuman) 경로
import { test } from "node:test";
import assert from "node:assert/strict";
import { upconvertV1, AppSpec, AppSpecV2, type RawInventory, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, v2Blockers } from "../src/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { awsGrantPlan } from "../src/target/grants.js";

type Raw = Record<string, any>;
const inv = (items: Raw[], provider = "gcp"): RawInventory => ({ provider, coverage: {}, items } as RawInventory);
const comp = (s: AppSpecV2, id: string) => s.components.find((c) => c.id === id) as unknown as { id: string; kind: string; props: Raw };

// ── ① DLQ 대상 = queue ──
const topics = (): Raw[] => [
  { kind: "pubsub.topic", name: "projects/p/topics/orders", subscription: { ackDeadlineSeconds: 30, deadLetterPolicy: { deadLetterTopic: "projects/p/topics/orders-dlq", maxDeliveryAttempts: 5 } } },
  { kind: "pubsub.topic", name: "projects/p/topics/orders-dlq" },
  { kind: "pubsub.topic", name: "projects/p/topics/events" },
];
test("GCP: DLQ 대상 토픽은 queue 로(신뢰도 0.9 + 이유), 그냥 토픽은 topic 그대로", () => {
  const { result } = normalizeV2(inv(topics()));
  assert.equal(comp(result.spec, "orders-dlq").props.model, "queue");
  assert.equal(comp(result.spec, "events").props.model, "topic");
  assert.equal(comp(result.spec, "orders").props.model, "topic");   // DLQ 를 가진 쪽은 바뀌지 않음
  assert.deepEqual(comp(result.spec, "orders").props.deadLetter, { to: "orders-dlq", maxReceive: 5 });
  const m = result.fieldMeta["components.orders-dlq.model"]!;
  assert.equal(m.confidence, 0.9); assert.match(m.rationale ?? "", /DLQ 대상/);
  // 도착 aws·gcp 모두 막힘 없음 (DLQ 규칙 통과)
  for (const p of ["aws", "gcp"] as const) assert.deepEqual(v2Blockers(result.spec, targetBuilderFor(p).capabilities()).unsupported, [], p);
});
test("거부: DLQ 를 못 찾으면(다른 프로젝트) 대상을 만들어 내지 않고 to 비움 → needsHuman, 토픽 그대로", () => {
  const { result } = normalizeV2(inv(topics().slice(0, 1)));
  assert.equal((comp(result.spec, "orders").props.deadLetter as Raw).to, undefined);
  assert.ok(v2Blockers(result.spec, targetBuilderFor("aws").capabilities()).needsHuman.some((x) => /죽은 편지 큐/.test(x)));
});

// ── ② 데이터 링크 의도 ──
const V1 = AppSpec.parse({ schemaVersion: "1", app: { name: "shop" },
  service: { image: `r/shop@sha256:${"a".repeat(64)}`, port: 8080, healthPath: "/healthz", replicas: 1, cpu: "500m", memory: "1Gi", env: [], secretRefs: [] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 }, ingress: { hostname: "s.example.com", entry: "cloudflare-lb" } });
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default" }) as TargetEnv;
function spec(link: Raw, extra?: (s: Raw) => void): AppSpecV2 {
  const s: Raw = structuredClone(upconvertV1(V1).spec);
  const svc = s.components.find((c: Raw) => c.kind === "service").id;
  s.components.push({ id: "shop-assets", kind: "objectStore", props: { versioning: false, public: false, sizeGb: 1 } },
    { id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 256, tls: true, auth: true } });
  s.links.push({ from: svc, to: "shop-assets", ...link });
  extra?.(s);
  return AppSpecV2.parse(s);
}
const GRANT = { effect: "Allow", actions: ["s3:GetObject", "s3:PutObject"], resources: ["arn:aws:s3:::src-bucket/*"] };

for (const intent of ["read", "write", "readwrite", "admin"] as const) for (const p of ["aws", "gcp"] as const) {
  test(`${p}: 데이터 링크 intent=${intent} 는 더 이상 UNSUPPORTED 가 아니다 (권한 원문 없으면 접근 권한은 안 그림)`, () => {
    const s = spec({ intent });
    assert.deepEqual(v2Blockers(s, targetBuilderFor(p).capabilities()).unsupported, []);
    const tf = targetBuilderFor(p).toTerraformV2(s, T(p));
    assert.ok(!JSON.stringify(JSON.parse(String(tf.vars.identity_json))).includes("s3:"));
  });
}

test("권한 원문(grants)이 있으면 intent 와 상관없이 identity grants_json 으로 그려짐 (aws), 도착 ARN 은 IR id 로 다시 잡음", () => {
  const s = spec({ intent: "readwrite", grants: [GRANT] });
  const tf = targetBuilderFor("aws").toTerraformV2(s, T("aws"));
  const id = JSON.parse(String(tf.vars.identity_json))[0];
  const g = JSON.parse(id.grants_json) as Array<{ actions: string[]; targets: Array<{ id: string }> }>;
  assert.deepEqual(g[0]!.actions, ["s3:GetObject", "s3:PutObject"]);
  assert.equal(g[0]!.targets[0]!.id, "shop-assets");
  assert.ok(!JSON.stringify(tf.vars).includes("src-bucket"), "출발 ARN 이 도착 변수에 남음");
});
test("의도만 있는 데이터 링크는 경고만 (막지 않음, 넓게 주지 않음) — connect·call 은 경고 없음", () => {
  assert.ok(awsGrantPlan(spec({ intent: "readwrite" })).warnings.some((w) => /readwrite 의도만 있고 권한 원문이 없어/.test(w)));
  assert.deepEqual(awsGrantPlan(spec({ intent: "connect" })).warnings, []);
});

// ── ③ 사람 확인 경로 ──
const withFirewall = (ingress: unknown, pub = false) => (s: Raw) => { s.posture.network.push({ scope: "component", subject: "shop-cache", mode: "mirror", ingress, public: pub }); };
test("사람 확인: 캐시 출발 방화벽을 못 읽으면 막지 않고 needsHuman, 사람이 허용 목록을 정하면(빈 목록) 사라짐", () => {
  const caps = targetBuilderFor("aws").capabilities();
  const unk = v2Blockers(spec({ intent: "connect" }, withFirewall("unknown")), caps);
  assert.deepEqual(unk.unsupported, []);
  assert.ok(unk.needsHuman.some((x) => /shop-cache: 출발 방화벽을 못 읽음/.test(x)));
  assert.deepEqual(v2Blockers(spec({ intent: "connect" }, withFirewall([])), caps).needsHuman, []);
});
test("사람 확인: 출발이 공개였는데 CIDR 허용이 없거나, 보안 그룹 같은 원본이 있으면 needsHuman", () => {
  const caps = targetBuilderFor("gcp").capabilities();
  assert.ok(v2Blockers(spec({ intent: "connect" }, withFirewall([], true)), caps).needsHuman.some((x) => /공개였는데 허용 주소/.test(x)));
  assert.ok(v2Blockers(spec({ intent: "connect" }, withFirewall([{ from: "sg-0abc" }])), caps).needsHuman.some((x) => /sg-0abc/.test(x)));
  assert.deepEqual(v2Blockers(spec({ intent: "connect" }, withFirewall([{ from: "203.0.113.0/24" }], true)), caps).needsHuman, []);
});
