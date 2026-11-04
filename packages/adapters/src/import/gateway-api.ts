import type { EntriesV2, FieldMetaV2, UnmappedV2 } from "@svc/contracts";
import { serviceTargets } from "./entry.js";
import type { RawK8sBackendRef, RawK8sGateway, RawK8sGrpcRoute, RawK8sHttpRoute, RawK8sParentRef, RawK8sService } from "./raw-k8s.js";
import type { MappedComponent } from "./types.js";

// GW-1 DRAFT(ai): Gateway API(Gateway·HTTPRoute·GRPCRoute) → IR entry. 순수 함수. Ingress 로 만든 entry 뒤에 붙인다 (같은 호스트면 경로가 안 겹치는 줄만).
//   IR 라우팅 모양 자체가 HTTPRoute Standard 라서 거의 그대로: path(Exact·PathPrefix)·headers(Exact)·method·backendRefs(weight).
//   못 옮기는 것 = 검토 줄(fieldMeta 0.6) + unmapped B. 조용히 버리지 않는다:
//     filters(헤더 고치기·URL 바꾸기·리다이렉트·미러·ExtensionRef), RegularExpression 경로·헤더, queryParams, timeouts, sessionPersistence,
//     Service 가 아닌 backendRef, 백엔드 4개 넘음, 호스트 이름을 못 정함(라우트·리스너 둘 다 없음)
//   GRPCRoute: method {service, method} → Exact "/<service>/<method>", service 만 → PathPrefix "/<service>/" (gRPC 는 HTTP/2 경로가 이 모양)
//   공개 여부: GatewayClass 이름 (internal·rilb·ilb·private → internal, 알려진 공개 클래스 → public, 나머지 public + 검토)
//   tls: 리스너 HTTPS → terminate (인증서 이름을 source 에), TLS + Passthrough → passthrough

type Host = EntriesV2["hosts"][number];
type Route = Host["routes"][number];
type Match = Route["matches"][number];
type Backend = Route["backends"][number];
type Listener = NonNullable<RawK8sGateway["spec"]["listeners"]>[number];

const INTERNAL_CLASS = /(internal|rilb|(^|-)ilb($|-)|private|lattice)/i;
const PUBLIC_CLASS = /^(gke-l7-(global-external-managed|regional-external-managed|gxlb)(-mc)?|istio|cilium|envoy-gateway|eg|nginx|kong|traefik|contour|amazon-alb|aws-alb|alb)$/i;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MAX_BACKENDS = 4;

/** 호스트 이름이 리스너 hostname(와일드카드 한 단계 포함)에 맞나. 리스너 hostname 없음 = 아무 이름 */
const fits = (host: string, lh: string | undefined) => {
  if (!lh) return true;
  const h = host.toLowerCase(), l = lh.toLowerCase();
  if (l === h) return true;
  return l.startsWith("*.") && h.endsWith(l.slice(1)) && !h.slice(0, h.length - l.length + 1).includes(".");
};

export interface GatewayInput { gateways: RawK8sGateway[]; httpRoutes: RawK8sHttpRoute[]; grpcRoutes: RawK8sGrpcRoute[] }

export function mergeGatewayRoutes(entry: EntriesV2 | undefined, components: MappedComponent[], svcObjs: RawK8sService[], gw: GatewayInput,
  fieldMeta: FieldMetaV2, unmapped: UnmappedV2[]): EntriesV2 | undefined {
  if (!gw.httpRoutes.length && !gw.grpcRoutes.length) {
    for (const g of gw.gateways) unmapped.push({ resource: `k8s.gateway:${g.metadata.namespace ?? ""}/${g.metadata.name}`, grade: "B", reason: "라우트(HTTPRoute·GRPCRoute)가 안 붙은 Gateway → 옮길 라우팅 없음. TLSRoute·TCPRoute 는 아직 안 읽음" });
    return entry;
  }
  const hosts = new Map<string, Host>((entry?.hosts ?? []).map((h) => [h.hostnames[0]!, h]));
  const review = (key: string, source: string, rationale: string) => {
    const prev = fieldMeta[key];
    fieldMeta[key] = { source, confidence: 0.6, needs_review: true, rationale: prev?.rationale && prev.rationale !== rationale ? `${prev.rationale} / ${rationale}` : rationale };
  };
  const gwOf = (ns: string | undefined, p: RawK8sParentRef) =>
    (p.kind ?? "Gateway") === "Gateway" ? gw.gateways.find((g) => g.metadata.name === p.name && (g.metadata.namespace ?? "") === (p.namespace ?? ns ?? "")) : undefined;

  type AnyRoute = { kind: "http"; r: RawK8sHttpRoute } | { kind: "grpc"; r: RawK8sGrpcRoute };
  const all: AnyRoute[] = [
    ...gw.httpRoutes.map((r) => ({ kind: "http" as const, r })),
    ...gw.grpcRoutes.map((r) => ({ kind: "grpc" as const, r })),
  ].sort((a, b) => `${a.r.metadata.namespace ?? ""}/${a.kind}/${a.r.metadata.name}`.localeCompare(`${b.r.metadata.namespace ?? ""}/${b.kind}/${b.r.metadata.name}`));

  for (const { kind, r } of all) {
    const ns = r.metadata.namespace;
    const label = `k8s.${kind === "http" ? "httpRoute" : "grpcRoute"}:${ns ? `${ns}/` : ""}${r.metadata.name}`;
    const src = `k8s:${kind === "http" ? "httproute" : "grpcroute"}/${r.metadata.name}`;
    // 붙은 리스너들 (sectionName 이 있으면 그 리스너만)
    const listeners: Array<{ g: RawK8sGateway; l: Listener }> = [];
    let missingParent = false;
    for (const p of r.spec.parentRefs ?? []) {
      const g = gwOf(ns, p);
      if (!g) { missingParent = true; continue; }
      for (const l of g.spec.listeners ?? []) if (!p.sectionName || l.name === p.sectionName) listeners.push({ g, l });
    }
    if (!(r.spec.parentRefs ?? []).length) missingParent = true;
    // 호스트 이름: 라우트 hostnames (리스너에 맞는 것), 없으면 리스너 hostname
    let names = (r.spec.hostnames ?? []).filter((h) => !listeners.length || listeners.some((x) => fits(h, x.l.hostname)));
    if (!(r.spec.hostnames ?? []).length) names = [...new Set(listeners.map((x) => x.l.hostname).filter((h): h is string => !!h))];
    if (!names.length) {
      unmapped.push({ resource: label, grade: "B", reason: "호스트 이름을 못 정함 (라우트 hostnames·리스너 hostname 둘 다 없음 = 모든 호스트) → 도착 호스트 이름을 사람이 정함" });
      continue;
    }
    const rules = r.spec.rules ?? [{}];
    for (const [i, rule] of rules.entries()) {
      const where = `${label}.rules[${i}]`;
      const ruleLost: string[] = [];
      const filters = [...(rule.filters ?? []), ...(rule.backendRefs ?? []).flatMap((b) => b.filters ?? [])].map((f) => f.type).filter(Boolean);
      if (filters.length) ruleLost.push(`filters(${[...new Set(filters)].sort().join(",")})`);
      if ("timeouts" in rule && rule.timeouts) ruleLost.push("timeouts");
      if (rule.sessionPersistence) ruleLost.push("sessionPersistence");
      // 백엔드
      const backends: Backend[] = [];
      const refs = rule.backendRefs ?? [];
      for (const b of refs as RawK8sBackendRef[]) {
        if ((b.kind ?? "Service") !== "Service" || (b.group ?? "") !== "") { ruleLost.push(`backendRef ${b.kind ?? "?"}/${b.name}(Service 아님)`); continue; }
        const f = serviceTargets(components, svcObjs, b.namespace ?? ns, b.name);
        if (!f) { unmapped.push({ resource: `${where}.backend:${b.name}`, grade: "C", reason: "대상 Service 가 IR 서비스로 안 이어짐" }); continue; }
        const sports = f.sv?.spec.ports ?? [];
        const port = b.port ?? (sports.length === 1 ? sports[0]!.port : undefined);
        if (port == null) { ruleLost.push(`backendRef ${b.name} 포트를 못 정함`); continue; }
        const w = b.weight ?? 1;
        // Service 하나가 Deployment 여럿을 고르면 가중치를 똑같이 나눈다 (출발도 파드 수 비율)
        for (const c of f.cs) backends.push({ to: c.id!, port, weight: w });
        if (f.conf < 1) ruleLost.push(!f.sv ? `Service ${b.name} 객체를 못 읽어 같은 이름 Deployment 로 추측` : `Service ${b.name} 가 Deployment 여럿을 고름`);
      }
      if (!refs.length) ruleLost.push("backendRefs 없음(필터만 있는 규칙)");
      if (backends.length > MAX_BACKENDS) { ruleLost.push(`백엔드 ${backends.length}개 → 앞 ${MAX_BACKENDS}개만`); backends.splice(MAX_BACKENDS); }
      // 매치
      const matches: Match[] = [];
      const rawMatches = (rule.matches ?? []) as Array<Record<string, any>>;
      for (const m of rawMatches.length ? rawMatches : [{}]) {
        let path: Match["path"] = { type: "PathPrefix", value: "/" };
        if (kind === "http") {
          const pt = m.path?.type ?? "PathPrefix";
          if (m.path && pt !== "Exact" && pt !== "PathPrefix") { ruleLost.push(`경로 ${pt} ${m.path.value ?? ""}`); continue; }
          if (m.path?.value) path = { type: pt, value: m.path.value };
          if (m.queryParams?.length) ruleLost.push("queryParams");
        } else {
          const gm = m.method as { type?: string; service?: string; method?: string } | undefined;
          if (gm && (gm.type ?? "Exact") !== "Exact") { ruleLost.push(`gRPC method ${gm.type}`); continue; }
          if (gm?.service && gm.method) path = { type: "Exact", value: `/${gm.service}/${gm.method}` };
          else if (gm?.service) path = { type: "PathPrefix", value: `/${gm.service}/` };
          else if (gm?.method) { ruleLost.push(`gRPC method 이름만(${gm.method}, 서비스 없음)`); continue; }
        }
        const headers = ((m.headers ?? []) as Array<{ type?: string; name: string; value: string }>).filter((h) => {
          if ((h.type ?? "Exact") !== "Exact") { ruleLost.push(`헤더 ${h.name} ${h.type}`); return false; }
          return true;
        }).map((h) => ({ name: h.name, value: h.value }));
        if (headers.length > 8) { ruleLost.push("헤더 매치 8개 넘음"); headers.splice(8); }
        const method = typeof m.method === "string" ? m.method.toUpperCase() : undefined;
        if (method && !METHODS.has(method)) ruleLost.push(`메서드 ${method}`);
        matches.push({ path, ...(headers.length ? { headers } : {}), ...(method && METHODS.has(method) ? { method: method as Match["method"] } : {}) });
      }
      if (matches.length > 8) { ruleLost.push("매치 8개 넘음"); matches.splice(8); }
      if (ruleLost.length) {
        unmapped.push({ resource: where, grade: "B", reason: `IR 에 없는 칸: ${[...new Set(ruleLost)].join(" / ")} → 도착 라우팅이 출발과 다를 수 있음. 사람이 확인` });
      }
      if (!backends.length || !matches.length) continue;
      for (const host of names) {
        const h: Host = hosts.get(host) ?? { hostnames: [host], routes: [] };
        hosts.set(host, h);
        // Ingress 가 이미 같은 경로를 만들었으면 안 겹친다 (첫 것 유지 + 검토)
        const dup = h.routes.some((x) => x.matches.some((mm) => matches.some((m2) => mm.path.type === m2.path.type && mm.path.value === m2.path.value && !mm.headers && !m2.headers && !mm.method && !m2.method)));
        if (dup) { review(`entry.${host}.routes`, src, "같은 호스트·경로를 다른 라우트(Ingress·HTTPRoute)도 받음 → 앞 것만. 사람이 확인"); continue; }
        if (h.routes.length >= 20) { review(`entry.${host}.routes`, src, "경로 줄 20개 넘음 → 뒤 줄은 안 옮김"); continue; }
        h.routes.push({ matches: matches.map((m) => structuredClone(m)), backends: backends.map((b) => ({ ...b })) });
        if (ruleLost.length) review(`entry.${host}.routes[${h.routes.length - 1}]`, `${src}.rules[${i}]`, `옮기지 못한 칸: ${[...new Set(ruleLost)].join(" / ")}`);
      }
    }
    // 호스트 단위: 공개 여부·tls
    for (const host of names) {
      const h = hosts.get(host);
      if (!h) continue;
      const mine = listeners.filter((x) => fits(host, x.l.hostname));
      const classes = [...new Set(mine.map((x) => x.g.spec.gatewayClassName ?? ""))];
      const internal = classes.some((c) => INTERNAL_CLASS.test(c));
      const sure = !missingParent && classes.length > 0 && classes.every((c) => INTERNAL_CLASS.test(c) || PUBLIC_CLASS.test(c));
      const ex = internal ? "internal" : "public";
      if (!h.exposure) h.exposure = ex;
      else if (h.exposure !== ex) { h.exposure = "internal"; review(`entry.${host}.exposure`, src, "같은 호스트를 공개·내부 입구가 같이 받음 → 내부로 둠. 사람이 확인"); }
      if (!sure && !internal) review(`entry.${host}.exposure`, `${src}.parentRefs`,
        missingParent ? "라우트가 가리키는 Gateway 를 못 읽음 → 공개로 둠. 사내망 전용이었으면 internal 로" : `GatewayClass ${classes.join(",") || "?"} 가 공개용인지 모름 → 공개로 둠`);
      const https = mine.find((x) => x.l.protocol === "HTTPS");
      const pass = mine.find((x) => x.l.protocol === "TLS" && (x.l.tls?.mode ?? "Terminate") === "Passthrough");
      if (!h.tls && (https || pass)) {
        const x = (https ?? pass)!;
        const cert = x.l.tls?.certificateRefs?.map((c) => c.name).join(",");
        h.tls = { mode: https ? "terminate" : "passthrough", source: `gateway ${x.g.metadata.namespace ?? ""}/${x.g.metadata.name} listener ${x.l.name}${cert ? `(secret ${cert})` : ""}` };
      }
    }
  }
  const list = [...hosts.values()].filter((h) => h.routes.length).sort((a, b) => (a.hostnames[0]! < b.hostnames[0]! ? -1 : 1));
  if (list.length > 10) {
    for (const h of list.slice(10)) unmapped.push({ resource: `entry:${h.hostnames[0]}`, grade: "B", reason: "입구 호스트 10개 넘음 → 명세 상한. 사람이 나눠서 옮김" });
    list.splice(10);
  }
  return list.length ? { via: "cloudflare-lb", hosts: list } : undefined;
}
