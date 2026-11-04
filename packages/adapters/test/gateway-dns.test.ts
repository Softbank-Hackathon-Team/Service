// GW-1 Gateway API(Gateway·HTTPRoute·GRPCRoute) → IR entry, GW-2 출발 공개 DNS 레코드 → IR 기록 + 계획 줄. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, ImportResultV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { readK8sNamespace } from "../src/discover/k8s.js";
import { cloudDnsRecordsOf, dnsUnreadStub, recordCovers, route53RecordsOf } from "../src/import/dns-records.js";
import { dnsPlanLines } from "../src/target/plan-v2.js";
import type { Exec } from "../src/terraform/real-runner.js";

const D = "sha256:" + "ab".repeat(32);
type Raw = Record<string, any>;
const run = (items: Raw[]) => normalizeV2({ provider: "gcp", coverage: {}, items } as RawInventory).result;
const ok = (r: ReturnType<typeof run>) => assert.equal(ImportResultV2.safeParse(r).success, true, JSON.stringify(ImportResultV2.safeParse(r).error?.issues?.slice(0, 3)));
const dep = (name: string, labels: Record<string, string> = { app: name }): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels },
  spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{ name, image: `ghcr.io/demo/${name}:1`, ports: [{ containerPort: 8080 }], env: [] }] } } },
});
const svc = (name: string, sel: Record<string, string> = { app: name }, port = 80): Raw =>
  ({ kind: "k8s.service", metadata: { name, namespace: "shop" }, spec: { type: "ClusterIP", selector: sel, ports: [{ port, targetPort: 8080 }] } });
const gw = (name: string, cls: string, listeners: Raw[], ns = "shop"): Raw => ({ kind: "k8s.gateway", metadata: { name, namespace: ns }, spec: { gatewayClassName: cls, listeners } });
const http = (name: string, spec: Raw): Raw => ({ kind: "k8s.httpRoute", metadata: { name, namespace: "shop" }, spec });
const grpc = (name: string, spec: Raw): Raw => ({ kind: "k8s.grpcRoute", metadata: { name, namespace: "shop" }, spec });
const host = (r: ReturnType<typeof run>, n: string) => r.spec.entry?.hosts.find((h) => h.hostnames[0] === n);
const HTTPS = { name: "https", hostname: "*.example.com", port: 443, protocol: "HTTPS", tls: { mode: "Terminate", certificateRefs: [{ name: "wild-cert" }] } };

// ── GW-1 ───────────────────────────────────────────────
test("GW-1: HTTPRoute 경로·헤더·메서드·가중치(카나리)를 그대로, 공개 GKE 클래스 = public, HTTPS 리스너 = tls(인증서 이름)", () => {
  const r = run([dep("api"), dep("api-canary"), svc("api"), svc("api-canary"),
    gw("ext", "gke-l7-global-external-managed", [HTTPS]),
    http("api", { parentRefs: [{ name: "ext" }], hostnames: ["shop.example.com"], rules: [
      { matches: [{ path: { type: "PathPrefix", value: "/api" }, headers: [{ name: "x-env", value: "beta" }], method: "get" }],
        backendRefs: [{ name: "api", port: 80, weight: 90 }, { name: "api-canary", port: 80, weight: 10 }] },
      { matches: [{ path: { type: "Exact", value: "/healthz" } }], backendRefs: [{ name: "api", port: 80 }] },
    ] }),
  ]);
  ok(r);
  const h = host(r, "shop.example.com")!;
  assert.deepEqual(h.routes, [
    { matches: [{ path: { type: "PathPrefix", value: "/api" }, headers: [{ name: "x-env", value: "beta" }], method: "GET" }], backends: [{ to: "api", port: 80, weight: 90 }, { to: "api-canary", port: 80, weight: 10 }] },
    { matches: [{ path: { type: "Exact", value: "/healthz" } }], backends: [{ to: "api", port: 80, weight: 1 }] },
  ]);
  assert.equal(h.exposure, "public");
  assert.deepEqual(h.tls, { mode: "terminate", source: "gateway shop/ext listener https(secret wild-cert)" });
  assert.equal(r.fieldMeta["entry.shop.example.com.exposure"], undefined);
  assert.ok(!r.unmapped.some((u) => u.resource.startsWith("k8s.httpRoute")));
});

test("GW-1 거부: 필터·정규식 경로·queryParams·Service 아닌 백엔드는 조용히 안 버리고 검토 줄 + unmapped B", () => {
  const r = run([dep("api"), svc("api"), gw("ext", "gke-l7-global-external-managed", [HTTPS]),
    http("api", { parentRefs: [{ name: "ext" }], hostnames: ["shop.example.com"], rules: [
      { matches: [{ path: { type: "PathPrefix", value: "/v1" }, queryParams: [{ name: "a", value: "1" }] }],
        filters: [{ type: "URLRewrite" }, { type: "RequestHeaderModifier" }], backendRefs: [{ name: "api", port: 80 }, { name: "bucket", kind: "GCPBackendPolicy", group: "networking.gke.io" }] },
      { matches: [{ path: { type: "RegularExpression", value: "/x/.*" } }], backendRefs: [{ name: "api", port: 80 }] },
    ] }),
  ]);
  ok(r);
  const h = host(r, "shop.example.com")!;
  assert.equal(h.routes.length, 1, "정규식만 있는 규칙은 매치가 없어 안 옮김");
  const m = r.fieldMeta["entry.shop.example.com.routes[0]"]!;
  assert.equal(m.confidence, 0.6);
  assert.match(m.rationale!, /filters\(RequestHeaderModifier,URLRewrite\)/);
  assert.match(m.rationale!, /queryParams/);
  assert.match(m.rationale!, /GCPBackendPolicy\/bucket/);
  const u = r.unmapped.filter((x) => x.resource.startsWith("k8s.httpRoute:shop/api.rules")).map((x) => [x.resource, x.grade]);
  assert.deepEqual(u, [["k8s.httpRoute:shop/api.rules[0]", "B"], ["k8s.httpRoute:shop/api.rules[1]", "B"]]);
  assert.match(r.unmapped.find((x) => x.resource.endsWith("rules[1]"))!.reason, /RegularExpression/);
});

test("GW-1: GRPCRoute method → gRPC 경로, 내부 클래스(rilb) = internal, 리스너 hostname 으로 호스트", () => {
  const r = run([dep("orders"), svc("orders", { app: "orders" }, 50051),
    gw("int", "gke-l7-rilb", [{ name: "h", hostname: "orders.internal.example.com", port: 80, protocol: "HTTP" }]),
    grpc("orders", { parentRefs: [{ name: "int", sectionName: "h" }], rules: [
      { matches: [{ method: { service: "shop.Orders", method: "Get" } }, { method: { service: "shop.Admin" } }], backendRefs: [{ name: "orders", port: 50051 }] },
    ] }),
  ]);
  ok(r);
  const h = host(r, "orders.internal.example.com")!;
  assert.deepEqual(h.routes[0]!.matches, [{ path: { type: "Exact", value: "/shop.Orders/Get" } }, { path: { type: "PathPrefix", value: "/shop.Admin/" } }]);
  assert.equal(h.exposure, "internal");
  assert.equal(h.tls, undefined);
});

test("GW-1 거부: 호스트 이름을 못 정하면 unmapped, 모르는 클래스·못 읽은 Gateway 는 public + 검토, Ingress 와 같은 경로는 앞 것만", () => {
  const r = run([dep("api"), svc("api"),
    { kind: "k8s.ingress", metadata: { name: "web", namespace: "shop" }, spec: { ingressClassName: "nginx", rules: [{ host: "a.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "api", port: { number: 80 } } } }] } }] } },
    gw("odd", "my-own-class", [{ name: "h", port: 80, protocol: "HTTP" }]),
    http("nohost", { parentRefs: [{ name: "odd" }], rules: [{ backendRefs: [{ name: "api", port: 80 }] }] }),
    http("dup", { parentRefs: [{ name: "odd" }], hostnames: ["a.example.com"], rules: [{ backendRefs: [{ name: "api", port: 80 }] }] }),
    http("lost", { parentRefs: [{ name: "gone", namespace: "infra" }], hostnames: ["b.example.com"], rules: [{ backendRefs: [{ name: "api", port: 80 }] }] }),
  ]);
  ok(r);
  assert.ok(r.unmapped.some((u) => u.resource === "k8s.httpRoute:shop/nohost" && u.reason.includes("호스트 이름을 못 정함")));
  assert.equal(host(r, "a.example.com")!.routes.length, 1, "Ingress 가 만든 / 만");
  assert.match(r.fieldMeta["entry.a.example.com.routes"]!.rationale!, /앞 것만/);
  assert.equal(host(r, "b.example.com")!.exposure, "public");
  assert.match(r.fieldMeta["entry.b.example.com.exposure"]!.rationale!, /Gateway 를 못 읽음/);
});

test("GW-1 discover: Gateway API 가 있으면 라우트를 읽고, 다른 네임스페이스 공용 Gateway 도 가져온다 (CRD 목록엔 안 넣음)", async () => {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const out = (o: unknown) => ({ code: 0, stdout: typeof o === "string" ? o : JSON.stringify(o), stderr: "", ms: 1 });
    if (/^kubectl api-resources /.test(line)) return out("gateways.gateway.networking.k8s.io\nhttproutes.gateway.networking.k8s.io\ngrpcroutes.gateway.networking.k8s.io\n");
    if (/^kubectl get deployments /.test(line)) return out({ items: [{ metadata: { name: "api", namespace: "shop" }, spec: { selector: { matchLabels: { app: "api" } }, template: { metadata: { labels: { app: "api" } }, spec: { containers: [{ name: "api", image: `ghcr.io/demo/api@${D}` }] } } } }] });
    if (/^kubectl get httproutes\.gateway\.networking\.k8s\.io -n shop /.test(line))
      return out({ items: [{ metadata: { name: "api", namespace: "shop" }, spec: { parentRefs: [{ name: "shared", namespace: "infra" }], hostnames: ["shop.example.com"], rules: [{ backendRefs: [{ name: "api", port: 80 }] }] } }] });
    if (/^kubectl get gateways\.gateway\.networking\.k8s\.io shared -n infra /.test(line))
      return out({ metadata: { name: "shared", namespace: "infra" }, spec: { gatewayClassName: "gke-l7-global-external-managed", listeners: [{ name: "https", port: 443, protocol: "HTTPS", tls: { certificateRefs: [{ name: "c" }] } }] } });
    if (/^kubectl get \S+ -n /.test(line)) return out({ items: [] });
    return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
  };
  const r = await readK8sNamespace({ exec, env: { IMPORT_NAMESPACE: "shop" } }, []);
  assert.deepEqual(r.items.filter((i) => i.kind.startsWith("k8s.g") || i.kind === "k8s.httpRoute").map((i) => `${i.kind}:${(i as any).metadata.namespace}/${(i as any).metadata.name}`).sort(),
    ["k8s.gateway:infra/shared", "k8s.httpRoute:shop/api"]);
  assert.ok(!r.items.some((i) => i.kind === "k8s.crdObject"), "Gateway API 는 CRD 목록(unmapped C)에 안 들어감");
});

test("GW-1 discover 거부: 클러스터에 Gateway API 가 없으면 라우트 목록을 부르지 않는다", async () => {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const out = (o: unknown) => ({ code: 0, stdout: typeof o === "string" ? o : JSON.stringify(o), stderr: "", ms: 1 });
    if (/^kubectl api-resources /.test(line)) return out("pods\n");
    if (/^kubectl get deployments /.test(line)) return out({ items: [{ metadata: { name: "api", namespace: "shop" }, spec: { selector: { matchLabels: { app: "api" } }, template: { metadata: { labels: { app: "api" } }, spec: { containers: [{ name: "api", image: `ghcr.io/demo/api@${D}` }] } } } }] });
    return out({ items: [] });
  };
  const r = await readK8sNamespace({ exec, env: { IMPORT_NAMESPACE: "shop" } }, []);
  assert.ok(!calls.some((c) => c.includes("gateway.networking.k8s.io")));
  assert.ok(!r.notes.some((n) => /Gateway|HTTPRoute/.test(n)));
});

// ── GW-2 ───────────────────────────────────────────────
test("GW-2: Route53·Cloud DNS 읽기 결과 → 원본 (별칭·가중치·와일드카드 \\052, 주소 종류만)", () => {
  const a = route53RecordsOf("example.com.", { ResourceRecordSets: [
    { Name: "shop.example.com.", Type: "A", AliasTarget: { DNSName: "k8s-alb-123.ap-northeast-2.elb.amazonaws.com.", HostedZoneId: "Z1" }, SetIdentifier: "blue", Weight: 90 },
    { Name: "\\052.example.com.", Type: "CNAME", TTL: 60, ResourceRecords: [{ Value: "edge.example.net" }] },
    { Name: "example.com.", Type: "MX", TTL: 300, ResourceRecords: [{ Value: "10 mx" }] },
  ] });
  assert.deepEqual(a, [
    { kind: "dns.record", provider: "route53", zone: "example.com.", name: "shop.example.com.", type: "A", values: [], alias: "k8s-alb-123.ap-northeast-2.elb.amazonaws.com.", weight: 90, setId: "blue" },
    { kind: "dns.record", provider: "route53", zone: "example.com.", name: "*.example.com.", type: "CNAME", ttl: 60, values: ["edge.example.net"] },
  ]);
  assert.deepEqual(cloudDnsRecordsOf("example-com", [{ name: "shop.example.com.", type: "A", ttl: 300, rrdatas: ["34.1.2.3"] }, { name: "x.example.com.", type: "TXT", rrdatas: ["v"] }]),
    [{ kind: "dns.record", provider: "clouddns", zone: "example-com.", name: "shop.example.com.", type: "A", ttl: 300, values: ["34.1.2.3"] }]);
  assert.equal(recordCovers("*.example.com.", "a.example.com"), true);
  assert.equal(recordCovers("*.example.com.", "a.b.example.com"), false);
});

const ingItems = () => [dep("api"), svc("api"),
  { kind: "k8s.ingress", metadata: { name: "web", namespace: "shop" }, spec: { ingressClassName: "nginx", rules: ["shop.example.com", "other.example.com", "far.elsewhere.org"].map((h) => ({ host: h, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "api", port: { number: 80 } } } }] } })) } }];

test("GW-2: 호스트마다 레코드를 붙이고(정확한 이름이 와일드카드를 이김), 못 찾으면 0.9 검토, 계획 줄은 TTL·가중치를 알린다", () => {
  const recs = [
    ...route53RecordsOf("example.com.", { ResourceRecordSets: [
      { Name: "shop.example.com.", Type: "A", TTL: 3600, ResourceRecords: [{ Value: "3.3.3.3" }] },
      { Name: "\\052.example.com.", Type: "CNAME", TTL: 60, ResourceRecords: [{ Value: "edge.example.net" }] }] }),
  ];
  const r = run([...ingItems(), ...recs]);
  ok(r);
  assert.deepEqual(host(r, "shop.example.com")!.dns, { read: true, records: [{ provider: "route53", zone: "example.com.", name: "shop.example.com.", type: "A", ttl: 3600, values: ["3.3.3.3"] }] });
  assert.equal(host(r, "other.example.com")!.dns!.records[0]!.name, "*.example.com.");
  assert.deepEqual(host(r, "far.elsewhere.org")!.dns, { read: true, records: [] });
  assert.equal(r.fieldMeta["entry.far.elsewhere.org.dns"]?.confidence, 0.9);
  const lines = dnsPlanLines(AppSpecV2.parse(r.spec));
  assert.equal(lines.length, 3);
  const shop = lines.find((l) => l.message.startsWith("shop.example.com"))!;
  assert.equal(shop.warn, true);
  assert.match(shop.message, /route53 example\.com\. shop\.example\.com\. A 3\.3\.3\.3 TTL 3600/);
  assert.match(shop.message, /미리 줄여 둘 것/);
  assert.equal(lines.find((l) => l.message.startsWith("other.example.com"))!.warn, false);
});

test("GW-2 거부: DNS 를 못 읽었으면 read:false + 0.6 검토 + warn 계획 줄, DNS 원본이 없는 출발(온프레)은 dns 칸 자체가 없다", () => {
  const r = run([...ingItems(), { ...dnsUnreadStub("clouddns") }]);
  ok(r);
  assert.deepEqual(host(r, "shop.example.com")!.dns, { read: false, records: [] });
  assert.equal(r.fieldMeta["entry.shop.example.com.dns"]?.confidence, 0.6);
  assert.match(r.fieldMeta["entry.shop.example.com.dns"]!.rationale!, /dns\.managedZones\.list/);
  const lines = dnsPlanLines(AppSpecV2.parse(r.spec));
  assert.ok(lines.every((l) => l.warn && l.message.includes("못 읽음")));
  const none = run(ingItems());
  assert.equal(host(none, "shop.example.com")!.dns, undefined);
  assert.deepEqual(dnsPlanLines(AppSpecV2.parse(none.spec)), []);
});
