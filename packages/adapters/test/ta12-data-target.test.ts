// TA12: 도착 Builder 가 I6 데이터 자원(cache·objectStore·queue)을 그림. aws·gcp = 종류 변수 + 매트릭스 + 권한, onprem = 거부(TODO(human)), azure_mock = 모양만
import { test } from "node:test";
import assert from "node:assert/strict";
import { upconvertV1, AppSpec, AppSpecV2, TF_KIND_VARS, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, v2Blockers, resourceTypesV2For } from "../src/index.js";
import { mockPlanV2, mockOutputsV2 } from "../src/target/azure-mock.js";

const V1 = AppSpec.parse({ schemaVersion: "1", app: { name: "shop" },
  service: { image: `r/shop@sha256:${"a".repeat(64)}`, port: 8080, healthPath: "/healthz", replicas: 1, cpu: "500m", memory: "1Gi", env: [], secretRefs: [] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 }, ingress: { hostname: "s.example.com", entry: "cloudflare-lb" } });
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;
type Raw = Record<string, any>;

/** 데이터 자원 4개가 붙은 v2 명세 (cache·bucket·orders·orders-dlq). 서비스 shop 이 앞 셋에 connect */
function withData(mut?: (s: Raw) => void): AppSpecV2 {
  const s: Raw = structuredClone(upconvertV1(V1).spec);
  const svc = s.components.find((c: Raw) => c.kind === "service").id as string;
  s.components.push(
    { id: "shop-cache", kind: "cache", props: { engine: "redis", version: "7.1", memoryMiB: 1024, tls: true, auth: true, ha: true } },
    { id: "shop-assets", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 5, lifecycle: [{ prefix: "tmp/", expireDays: 7 }, { prefix: "log/", expireDays: 30 }] } },
    { id: "orders", kind: "queue", props: { model: "queue", ordered: true, retentionSec: 86400, ackTimeoutSec: 30, deadLetter: { to: "orders-dlq", maxReceive: 5 } } },
    { id: "orders-dlq", kind: "queue", props: { model: "queue", ordered: true } });   // VTA12: FIFO 큐의 DLQ 는 FIFO (SQS 규칙)
  for (const to of ["shop-cache", "shop-assets", "orders"]) s.links.push({ from: svc, to, intent: "connect" });
  mut?.(s);
  return AppSpecV2.parse(s);
}
const items = (tf: { vars: Record<string, unknown> }, k: string) => JSON.parse(String(tf.vars[k])) as Raw[];

for (const p of ["aws", "gcp"] as const) {
  test(`${p}: 데이터 자원 → cache_json·object_store_json·queue_json 이 계약대로, 매트릭스·DLQ 참조·허용 신원`, () => {
    const b = targetBuilderFor(p), spec = withData(), tf = b.toTerraformV2(spec, T(p));
    const c = items(tf, "cache_json")[0]!, o = items(tf, "object_store_json")[0]!, qs = items(tf, "queue_json");
    assert.deepEqual(TF_KIND_VARS.cache.parse(c), c);
    assert.deepEqual(TF_KIND_VARS.objectStore.parse(o), o);
    qs.forEach((q) => TF_KIND_VARS.queue.parse(q));
    assert.equal(c.engine, "redis"); assert.equal(c.memory_mib, 1024); assert.equal(c.ha, true); assert.equal(c.cluster_mode, null);
    assert.equal(o.public, false); assert.equal(o.versioning, true); assert.equal(o.force_destroy, false);
    assert.deepEqual(JSON.parse(o.lifecycle_json).map((x: Raw) => x.prefix), ["log/", "tmp/"]);   // 접두어 순 (결정적)
    assert.ok(o.name.length <= 63 && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(o.name), o.name);
    assert.ok(c.name.length <= 40);
    const orders = qs.find((q) => q.id === "orders")!;
    assert.equal(orders.dead_letter_to, "orders-dlq");   // 참조는 IR id 그대로
    assert.equal(orders.dead_letter_max_receive, 5); assert.equal(orders.ordered, true); assert.equal(orders.retention_sec, 86400);
    assert.equal(qs.find((q) => q.id === "orders-dlq")!.dead_letter_to, null);
    assert.deepEqual(JSON.parse(c.allow_from_json), ["shop"]);
    assert.deepEqual(JSON.parse(items(tf, "queue_json").find((q) => q.id === "orders-dlq")!.allow_from_json), []);   // 연결 안 한 큐는 아무도 못 씀
    const mods = tf.instances.map((i) => `${i.kind}:${i.id}:${i.module}`);
    assert.ok(mods.includes(`cache:shop-cache:${p}/kinds/cache`) && mods.includes(`objectStore:shop-assets:${p}/kinds/object-store`) && mods.includes(`queue:orders:${p}/kinds/queue`), mods.join());
    assert.ok(tf.modules.some((m) => m.path.endsWith("kinds/object-store")));
  });

  test(`${p}: 결정적 — 컴포넌트 순서를 섞어도 같은 변수·인스턴스, 서로 다른 이전은 이름이 다름`, () => {
    const b = targetBuilderFor(p);
    const a = b.toTerraformV2(withData(), T(p));
    const r = b.toTerraformV2(withData((s) => { s.components.reverse(); }), T(p));
    assert.deepEqual(a.vars, r.vars); assert.deepEqual(a.instances, r.instances);
    const other = b.toTerraformV2(withData(), { ...T(p), migrationId: "55555555-5555-4555-8555-555555555555" } as TargetEnv);
    assert.notEqual(items(a, "object_store_json")[0]!.name, items(other, "object_store_json")[0]!.name);
  });

  test(`${p}: 데이터 자원 종류가 "생길 자원"·권한에 들어감 (apply 에만 쓰기 동작)`, () => {
    const b = targetBuilderFor(p), spec = withData();
    const types = resourceTypesV2For(p, spec);
    const want = p === "aws" ? ["aws_elasticache_replication_group", "aws_s3_bucket", "aws_sqs_queue"] : ["google_redis_instance", "google_storage_bucket", "google_pubsub_topic"];
    for (const t of want) assert.ok(types.includes(t), t);
    const apply = b.operateActionsV2(spec, "apply"), plan = b.operateActionsV2(spec, "plan");
    const w = p === "aws" ? "s3:CreateBucket" : "storage.buckets.create";
    assert.ok(apply.includes(w) && !plan.includes(w));
    assert.ok(plan.every((x) => /(:|\.)(Describe|Get|List|get|list)/.test(x) || x.endsWith("ListBucket")), plan.join());
  });

  test(`${p}: 데이터 자원 없는 명세는 새 변수가 빈 목록 (v1 같은 모양 그대로)`, () => {
    const tf = targetBuilderFor(p).toTerraformV2(upconvertV1(V1).spec, T(p));
    for (const k of ["cache_json", "object_store_json", "queue_json"]) assert.equal(tf.vars[k], "[]");
  });
}

// ── 거부 ──
test("거부: memcached → aws·gcp·azure_mock 모두 UNSUPPORTED_V2 (모듈이 안 만듦)", () => {
  const spec = withData((s) => { s.components.find((c: Raw) => c.id === "shop-cache").props.engine = "memcached"; });
  for (const p of ["aws", "gcp"] as const) assert.throws(() => targetBuilderFor(p).toTerraformV2(spec, T(p)), (e: any) => e.code === "UNSUPPORTED_V2" && /kind\.cache\.memcached/.test(e.message), p);
  assert.ok(v2Blockers(spec, targetBuilderFor("azure_mock").capabilities()).unsupported.some((x) => /memcached/.test(x)));
});

test("거부: GCP 는 캐시 클러스터 모드 불가, AWS 는 가능", () => {
  const spec = withData((s) => { s.components.find((c: Raw) => c.id === "shop-cache").props.clusterMode = true; });
  assert.throws(() => targetBuilderFor("gcp").toTerraformV2(spec, T("gcp")), (e: any) => e.code === "UNSUPPORTED_V2" && /cluster/.test(e.message));
  assert.equal(items(targetBuilderFor("aws").toTerraformV2(spec, T("aws")), "cache_json")[0]!.cluster_mode, true);
});

test("거부: DLQ 대상이 없는 큐·topic·또 DLQ 를 가진 큐·자기 자신이면 계획 전에 막음", () => {
  const caps = targetBuilderFor("aws").capabilities();
  const bad = (f: (s: Raw) => void) => v2Blockers(withData(f), caps).unsupported.join(" | ");
  assert.match(bad((s) => { s.components.find((c: Raw) => c.id === "orders").props.deadLetter.to = "shop-cache"; }), /orders DLQ 대상 shop-cache/);
  assert.match(bad((s) => { s.components.find((c: Raw) => c.id === "orders-dlq").props.model = "topic"; }), /topic 이라 DLQ/);
  assert.match(bad((s) => { s.components.find((c: Raw) => c.id === "orders-dlq").props.deadLetter = { to: "orders" }; }), /또 DLQ/);
  assert.match(bad((s) => { s.components.find((c: Raw) => c.id === "orders").props.deadLetter.to = "orders"; }), /orders DLQ 대상 orders/);
  assert.equal(bad(() => undefined), "");
});

test("사람에게 묻기: 공개 여부 모름(null) 버킷은 막지 않고 needsHuman, 변수엔 null 그대로(공개로 안 엶). DLQ 못 찾음도 needsHuman", () => {
  const spec = withData((s) => { s.components.find((c: Raw) => c.id === "shop-assets").props.public = null; delete s.components.find((c: Raw) => c.id === "orders").props.deadLetter.to; });
  const b = v2Blockers(spec, targetBuilderFor("aws").capabilities());
  assert.deepEqual(b.unsupported, []);
  assert.ok(b.needsHuman.some((x) => /shop-assets: 버킷 공개 여부/.test(x)) && b.needsHuman.some((x) => /orders: 죽은 편지 큐/.test(x)));
  assert.equal(items(targetBuilderFor("aws").toTerraformV2(spec, T("aws")), "object_store_json")[0]!.public, null);
});

test("거부: 온프레는 아직 데이터 자원을 못 그림 (TODO(human) — 조용히 빼지 않고 UNSUPPORTED_V2)", () => {
  const spec = withData();
  assert.throws(() => targetBuilderFor("onprem").toTerraformV2(spec, T("onprem")), (e: any) => e.code === "UNSUPPORTED_V2" && /kind\.(cache|objectStore|queue)/.test(e.message));
  // 데이터 자원 없는 명세는 그대로 그려짐
  targetBuilderFor("onprem").toTerraformV2(upconvertV1(V1).spec, T("onprem"));
});

test("azure_mock: 모양만 — 데이터 자원 계획 줄·link 출력이 결정적, 순서 무관", () => {
  const spec = withData();
  const p1 = mockPlanV2(spec, T("azure_mock")), p2 = mockPlanV2(withData((s) => { s.components.reverse(); }), T("azure_mock"));
  assert.deepEqual(p1.resources, p2.resources);
  const types = p1.resources.map((r) => r.type);
  for (const t of ["azurerm_redis_cache", "azurerm_storage_account", "azurerm_servicebus_namespace", "azurerm_servicebus_queue"]) assert.ok(types.includes(t), t);
  assert.equal(p1.resources.filter((r) => r.type === "azurerm_servicebus_queue").length, 2);
  assert.equal(p1.summary.add, p1.resources.length);
  const out = mockOutputsV2(spec, T("azure_mock"));
  assert.match(out["link.shop-cache.url"]!, /^rediss:\/\/.+\.redis\.cache\.windows\.net:6380$/);
  assert.ok(out["link.shop-assets.name"] && out["link.orders.url"]!.startsWith("sb://"));
  assert.deepEqual(out, mockOutputsV2(spec, T("azure_mock")));
});
