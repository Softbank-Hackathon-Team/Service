// 검증 VTA12: 도착 데이터 자원(cache·objectStore·queue) 렌더 경계 — TLS·auth, 공개 버킷, FIFO·DLQ, 크기 경계, 결정성, 계약·HCL 1:1, 출발 값 안 섞임, 이름 금지어
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AppSpecV2, TF_KIND_VARS, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, v2Blockers } from "../src/index.js";
import { bucketApp } from "../src/target/data.js";

// 데모 명세 (shop 서비스 1개 + postgres 1개)
const BASE: AppSpecV2 = AppSpecV2.parse({"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["s.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}});
const T = (p: TargetEnv["provider"], mig = "44444444-4444-4444-8444-444444444444") =>
  ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: mig }) as TargetEnv;
type Raw = Record<string, any>;
const P = ["aws", "gcp"] as const;

function withData(mut?: (s: Raw) => void): AppSpecV2 {
  const s: Raw = structuredClone(BASE);
  const svc = s.components.find((c: Raw) => c.kind === "service").id as string;
  s.components.push(
    { id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 1024, tls: true, auth: true } },
    { id: "shop-assets", kind: "objectStore", props: { versioning: false, public: false, sizeGb: 5 } },
    { id: "orders", kind: "queue", props: { model: "queue", deadLetter: { to: "orders-dlq", maxReceive: 5 } } },
    { id: "orders-dlq", kind: "queue", props: { model: "queue" } });
  for (const to of ["shop-cache", "shop-assets", "orders"]) s.links.push({ from: svc, to, intent: "connect" });
  mut?.(s);
  return AppSpecV2.parse(s);
}
const comp = (s: Raw, id: string) => s.components.find((c: Raw) => c.id === id);
const items = (tf: { vars: Record<string, unknown> }, k: string) => JSON.parse(String(tf.vars[k])) as Raw[];
const render = (p: "aws" | "gcp", spec: AppSpecV2, t = T(p)) => targetBuilderFor(p).toTerraformV2(spec, t);

// ── 캐시 TLS·auth ──
test("캐시 tls·auth: false 는 false 그대로, null 은 null 그대로 (모듈이 상품 기본=켬) — 값 안 지어냄", () => {
  for (const p of P) {
    const off = items(render(p, withData((s) => { Object.assign(comp(s, "shop-cache").props, { tls: false, auth: false }); })), "cache_json")[0]!;
    assert.equal(off.tls, false, p); assert.equal(off.auth, false, p);
    const unk = items(render(p, withData((s) => { Object.assign(comp(s, "shop-cache").props, { tls: null, auth: null }); })), "cache_json")[0]!;
    assert.equal(unk.tls, null, p); assert.equal(unk.auth, null, p);
    assert.equal(unk.version, null); assert.equal(unk.ha, null); assert.equal(unk.shards, null);
  }
});

// ── 공개 버킷 ──
test("공개 버킷(public=true): 변수엔 true 그대로, B-2 그대로 이식이라 막지 않음(모듈이 공개로 엶, 승인 줄은 checkV2 public_bucket)", () => {
  const spec = withData((s) => { comp(s, "shop-assets").props.public = true; });
  for (const p of [...P, "azure_mock"] as const) {
    const b = v2Blockers(spec, targetBuilderFor(p).capabilities());
    assert.deepEqual(b.unsupported, [], p);
    assert.ok(!b.needsHuman.some((x) => /shop-assets/.test(x)), `${p}: ${b.needsHuman.join(" | ")}`);
  }
  for (const p of P) assert.equal(items(render(p, spec), "object_store_json")[0]!.public, true);
  // 비공개 버킷은 아무 말 없음
  assert.ok(!v2Blockers(withData(), targetBuilderFor("aws").capabilities()).needsHuman.some((x) => /shop-assets/.test(x)));
  for (const f of ["aws", "gcp"]) assert.match(readFileSync(new URL(`../../../infra/modules/${f}/kinds/object-store/main.tf`, import.meta.url), "utf8"),
    f === "aws" ? /block_public_policy\s*=\s*!local\.open_public/ : /public_access_prevention\s*=\s*var\.cfg\.public == true \? "inherited" : "enforced"/, `${f} 모듈이 공개일 때만 공개 차단을 끔`);
});

// ── FIFO · DLQ ──
test("FIFO 큐의 DLQ 가 FIFO 가 아니면(또는 반대) AWS 는 계획 전에 거부, GCP·azure_mock 은 통과 (찾은 버그: SQS 가 apply 에서 실패)", () => {
  const mixed = withData((s) => { comp(s, "orders").props.ordered = true; });
  assert.throws(() => render("aws", mixed), (e: any) => e.code === "UNSUPPORTED_V2" && /kind\.queue\.dlqMixedOrder/.test(e.message));
  const rev = withData((s) => { comp(s, "orders-dlq").props.ordered = true; });
  assert.throws(() => render("aws", rev), (e: any) => e.code === "UNSUPPORTED_V2");
  assert.equal(items(render("gcp", mixed), "queue_json").find((q) => q.id === "orders")!.ordered, true);
  assert.deepEqual(v2Blockers(mixed, targetBuilderFor("azure_mock").capabilities()).unsupported, []);
  // 둘 다 FIFO, 둘 다 표준(ordered false·생략 섞임)은 AWS 도 통과
  const both = render("aws", withData((s) => { comp(s, "orders").props.ordered = true; comp(s, "orders-dlq").props.ordered = true; }));
  assert.deepEqual(items(both, "queue_json").map((q) => [q.id, q.ordered]), [["orders", true], ["orders-dlq", true]]);
  render("aws", withData((s) => { comp(s, "orders").props.ordered = false; }));
  // DLQ 없는 FIFO 큐는 상관없음
  render("aws", withData((s) => { comp(s, "orders").props.ordered = true; delete comp(s, "orders").props.deadLetter; }));
});

test("FIFO 이름: 40자 id 도 큐 이름 60자 이하 → .fifo 붙여도 SQS 80자·모듈 75자 규칙 안", () => {
  const long = "q" + "x".repeat(39);
  const spec = withData((s) => { s.components.push({ id: long, kind: "queue", props: { model: "queue", ordered: true } }); });
  for (const p of P) {
    const q = items(render(p, spec), "queue_json").find((x) => x.id === long)!;
    assert.ok(q.name.length <= 60 && `${q.name}.fifo`.length <= 75 && /^[A-Za-z0-9_-]+$/.test(q.name), q.name);
  }
});

// ── 크기 경계 ──
test("크기 경계: sizeGb 0·아주 큼, memoryMiB 1·최대, retention 최소·최대 → 값 그대로 (반올림·자르기 없음), 범위 밖은 명세 parse 가 거부", () => {
  // SZ-1 (fc2): 도착 급 최대(AWS r7g.16xlarge 429148MiB · Memorystore 300GB)까지는 그대로, 넘으면 줄이지 않고 막음
  for (const [size, mem, ret] of [[0, 1, 60], [1e12, 307200, 2678400], [0.5, null, undefined]] as const) {
    const spec = withData((s) => {
      comp(s, "shop-assets").props.sizeGb = size; comp(s, "shop-cache").props.memoryMiB = mem;
      if (ret !== undefined) comp(s, "orders").props.retentionSec = ret;
    });
    for (const p of P) {
      const tf = render(p, spec);
      assert.equal(items(tf, "object_store_json")[0]!.size_gb, size);
      assert.equal(items(tf, "cache_json")[0]!.memory_mib, mem);
      assert.equal(items(tf, "queue_json").find((q) => q.id === "orders")!.retention_sec, ret ?? null);
    }
  }
  for (const p of P) assert.throws(() => render(p, withData((s) => { comp(s, "shop-cache").props.memoryMiB = 1048576; })), /최대/);
  assert.throws(() => withData((s) => { comp(s, "shop-assets").props.sizeGb = -1; }));
  assert.throws(() => withData((s) => { comp(s, "shop-cache").props.memoryMiB = 0; }));
  assert.throws(() => withData((s) => { comp(s, "orders").props.retentionSec = 59; }));
  assert.throws(() => withData((s) => { comp(s, "orders").props.retentionSec = 2678401; }));
  // sizeGb null(모름) 도 null 그대로
  assert.equal(items(render("aws", withData((s) => { comp(s, "shop-assets").props.sizeGb = null; })), "object_store_json")[0]!.size_gb, null);
});

// ── 결정성 ──
test("결정적: 같은 입력 두 번 → 출력 전체 글자 그대로, 링크·lifecycle 순서를 섞어도 같은 변수", () => {
  const mk = (rev: boolean) => withData((s) => {
    comp(s, "shop-assets").props.lifecycle = rev ? [{ prefix: "b/", expireDays: 1 }, { prefix: "a/", toColdAfterDays: 30 }] : [{ prefix: "a/", toColdAfterDays: 30 }, { prefix: "b/", expireDays: 1 }];
    s.components.push({ id: "worker", kind: "service", props: structuredClone(s.components.find((c: Raw) => c.kind === "service").props) });
    s.links.push({ from: "worker", to: "shop-cache", intent: "connect" });
    if (rev) s.links.reverse();
  });
  for (const p of P) {
    assert.equal(JSON.stringify(render(p, mk(false))), JSON.stringify(render(p, mk(false))), p);
    const a = render(p, mk(false)), b = render(p, mk(true));
    for (const k of ["cache_json", "object_store_json", "queue_json"]) assert.equal(a.vars[k], b.vars[k], `${p} ${k}`);
    assert.deepEqual(JSON.parse(items(a, "cache_json")[0]!.allow_from_json), [...JSON.parse(items(a, "cache_json")[0]!.allow_from_json)].sort());
  }
});

// ── 계약 1:1 ──
const hclCfgKeys = (f: string) => {
  const src = readFileSync(new URL(`../../../infra/modules/${f}/main.tf`, import.meta.url), "utf8");
  const body = src.slice(src.indexOf('variable "cfg"'), src.indexOf("})", src.indexOf('variable "cfg"')));
  return [...body.matchAll(/^\s+([a-z_]+)\s+=/gm)].map((m) => m[1]!).filter((k) => k !== "type").sort();
};
test("계약 1:1: 렌더 항목 키 = TfVars 계약 키 = 모듈 cfg 키 (aws·gcp 각 3종류)", () => {
  const spec = withData();
  const map = { cache_json: ["cache", "cache"], object_store_json: ["objectStore", "object-store"], queue_json: ["queue", "queue"] } as const;
  for (const p of P) {
    const tf = render(p, spec);
    for (const [v, [kind, dir]] of Object.entries(map)) {
      const want = Object.keys(TF_KIND_VARS[kind].shape).sort();
      for (const it of items(tf, v)) assert.deepEqual(Object.keys(it).sort(), want, `${p} ${v} 항목`);
      assert.deepEqual(hclCfgKeys(`${p}/kinds/${dir}`), want, `${p}/kinds/${dir} cfg`);
    }
  }
});

// ── 출발 값 안 섞임 ──
test("출발 주소·계정 ID·출발 이름이 데이터 변수에 안 섞임 (이름은 해시, 허용은 도착 신원 id 만)", () => {
  const acct = "123456789012";
  const spec = withData((s) => {
    s.app.name = `shop-${acct}`;
    s.posture.network.push({ scope: "component", subject: "shop-cache", mode: "mirror", public: false, ingress: [{ from: "10.9.8.0/24" }, { from: `sg-0abc${acct}` }] });
  });
  for (const p of P) {
    const tf = render(p, spec);
    const txt = ["cache_json", "object_store_json", "queue_json"].map((k) => String(tf.vars[k])).join("\n");
    for (const bad of [acct, "10.9.8.0", "sg-0abc", "s.example.com"]) assert.ok(!txt.includes(bad), `${p}: ${bad}`);
    // 서로 다른 도착(이전 번호)이면 이름이 다름 = 출발 이름 재사용 아님
    const other = render(p, spec, T(p, "55555555-5555-4555-8555-555555555555"));
    assert.notEqual(items(tf, "cache_json")[0]!.name, items(other, "cache_json")[0]!.name);
  }
});

// ── 버킷 이름 금지어 ──
test("버킷 이름: id 가 google·goog·sthree 여도 GCS·S3 금지어 안 씀 (찾은 버그), 해시는 원래 id 기준, 다른 id 이름은 그대로", () => {
  const ids = ["google-assets", "goog", "my-google-x", "sthree", "gogoogle"];
  const spec = withData((s) => { for (const id of ids) s.components.push({ id, kind: "objectStore", props: { versioning: false, public: false, sizeGb: 1 } }); });
  for (const p of P) {
    for (const o of items(render(p, spec), "object_store_json")) {
      assert.ok(!/^goog/.test(o.name) && !o.name.includes("google") && !o.name.startsWith("sthree-"), `${p} ${o.id} → ${o.name}`);
      assert.ok(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(o.name), o.name);
    }
  }
  assert.equal(bucketApp("shop-assets"), "shopassets");
  assert.equal(bucketApp("sthreex"), "sthreex");
  // 금지어 없는 id 의 이름은 VTA12 전과 같은 규칙 (앞부분 = id 문자, 뒤 = 해시6)
  // 금지어 없는 id 의 이름은 VTA12 전과 같은 규칙 (앞부분 = id 문자, 뒤 = 해시6). TA12b 가 앞에 "app-" 를 붙인다 ("app-" 는 GCS·S3 금지어가 아님)
  // 금지어 없는 id 의 이름은 VTA12 전과 같은 규칙 (앞부분 = id 문자, 뒤 = 해시6, 앞에 TA12b 의 app- 접두어)
  assert.match(items(render("aws", withData()), "object_store_json")[0]!.name, /^app-shopassets-[0-9a-f]{6}$/);
});
