import type { AppSpecV2, EntriesV2, FieldMetaV2, UnmappedV2 } from "@svc/contracts";
import type { RawK8sIngress, RawK8sService } from "./raw-k8s.js";
import type { MappedComponent } from "./types.js";

// DRAFT(ai): k8s Service 객체 → service.endpoints, Ingress v1 → 라우팅(HTTPRoute 모양). 설계 20번 4.4장, PoC normalizeV2 입구 부분.
//   포트는 k8s Service 포트(라우팅이 부르는 번호). defaultBackend 는 그 Ingress 의 호스트에만 마지막 "/" 줄.

type Host = EntriesV2["hosts"][number];
type Backend = Host["routes"][number]["backends"][number];

const selects = (sv: RawK8sService, c: MappedComponent) =>
  c.kind === "service" && c.native.namespace === sv.metadata.namespace && !!sv.spec.selector
  && Object.entries(sv.spec.selector).every(([k, v]) => c.native.labels?.[k] === v);

const ENDPOINT_TYPES = new Set(["ClusterIP", "NodePort", "LoadBalancer"]);
const PROTOCOLS = new Set(["TCP", "UDP", "SCTP"]);

// ENT-1: 인터넷 공개용으로 알려진 Ingress 클래스 (정확히 이 이름만)
const PUBLIC_CLASSES = /^(nginx|alb|gce|traefik|haproxy|kong|contour|istio|cilium|public)$/i;

// V-1 DRAFT(ai): ExternalName 대상이 출발 안쪽 주소면(사설 DNS·클러스터 안 이름·벤더 DB 주소·사설 IP) 도착에서 그대로 쓰면 출발을 가리킴 → 검토
const PRIVATE_TARGET = /(\.svc(\.cluster\.local)?$|\.cluster\.local$|\.internal$|\.local$|\.rds\.amazonaws\.com$|\.cache\.amazonaws\.com$|\.compute\.internal$|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.)/;
type Alias = NonNullable<AppSpecV2["serviceAliases"]>[number];

/** V-1·NP-1: Service 동작 칸 (출발에 적힌 것만). 없으면 칸 없음 = k8s 기본 */
function behaviourOf(sv: RawK8sService): Record<string, unknown> {
  const s = sv.spec;
  const o: Record<string, unknown> = {
    publishNotReadyAddresses: s.publishNotReadyAddresses === true ? true : undefined,
    sessionAffinity: s.sessionAffinity === "ClientIP" ? "ClientIP" : undefined,   // None 은 기본이라 칸 안 둠
    sessionAffinityTimeoutSec: s.sessionAffinity === "ClientIP" ? s.sessionAffinityTimeoutSec : undefined,
    externalTrafficPolicy: s.externalTrafficPolicy === "Local" || s.externalTrafficPolicy === "Cluster" ? (s.type === "NodePort" || s.type === "LoadBalancer" ? s.externalTrafficPolicy : undefined) : undefined,
    internalTrafficPolicy: s.internalTrafficPolicy === "Local" ? "Local" : undefined,
    loadBalancerSourceRanges: s.type === "LoadBalancer" && s.loadBalancerSourceRanges?.length ? [...s.loadBalancerSourceRanges].sort() : undefined,
    loadBalancerIP: s.type === "LoadBalancer" ? s.loadBalancerIP : undefined,
  };
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** Service 객체를 셀렉터로 Deployment·StatefulSet·DaemonSet 에 붙인다 (제자리). V-1: ExternalName 은 serviceAliases 로 돌려준다 */
export function attachEndpoints(components: MappedComponent[], svcObjs: RawK8sService[], unmapped: UnmappedV2[], fieldMeta: FieldMetaV2 = {}): Alias[] {
  const aliases: Alias[] = [];
  for (const sv of svcObjs) {
    if (sv.spec.type === "ExternalName") {
      const target = sv.spec.externalName ?? "";
      if (!target) { unmapped.push({ resource: `k8s.service:${sv.metadata.name}`, grade: "B", reason: "ExternalName 인데 대상 주소가 없음" }); continue; }
      const ports = (sv.spec.ports ?? []).map((p) => ({ ...(p.name ? { name: p.name } : {}), port: p.port, ...(PROTOCOLS.has(p.protocol ?? "") ? { protocol: p.protocol as "TCP" } : {}) }));
      aliases.push({ name: sv.metadata.name, ...(sv.metadata.namespace ? { namespace: sv.metadata.namespace } : {}), externalName: target, ...(ports.length ? { ports } : {}) });
      fieldMeta[`serviceAliases.${sv.metadata.name}`] = PRIVATE_TARGET.test(target)
        ? { source: `k8s:${sv.metadata.namespace ?? ""}/service/${sv.metadata.name}.spec.externalName`, confidence: 0.6, needs_review: true,
          rationale: `대상 ${target} 이 출발 안쪽 주소로 보임 → 도착에서 그대로 두면 출발을 가리킴. 도착 주소로 바꿀지 확인` }
        : { source: `k8s:${sv.metadata.namespace ?? ""}/service/${sv.metadata.name}.spec.externalName`, confidence: 1, needs_review: false };
      continue;
    }
    const owners = components.filter((c) => selects(sv, c));
    if (!owners.length) { unmapped.push({ resource: `k8s.service:${sv.metadata.name}`, grade: "B", reason: "셀렉터에 맞는 워크로드 없음" }); continue; }
    // 셀렉터가 여럿을 고르면(카나리·블루그린) 다 같은 Service 뒤에 있다는 뜻 → 각자에 붙이고 라우팅도 여럿으로
    for (const o of owners) {
      const t = sv.spec.type ?? "ClusterIP";
      const headless = sv.spec.clusterIP === "None";
      const ep: { name: string; type: string; ports: Array<Record<string, unknown>>; loadBalancerIP?: string } = {
        name: sv.metadata.name,
        // V-1: clusterIP None = Headless (StatefulSet 파드별 DNS). 그 밖은 원래 종류
        type: headless ? "Headless" : ENDPOINT_TYPES.has(t) ? t : "ClusterIP",
        ports: (sv.spec.ports ?? []).map((p) => ({ ...(p.name ? { name: p.name } : {}), port: p.port, targetPort: p.targetPort ?? p.port,
          protocol: PROTOCOLS.has(p.protocol ?? "") ? p.protocol! : "TCP",
          ...(p.appProtocol ? { appProtocol: p.appProtocol } : {}),
          ...((t === "NodePort" || t === "LoadBalancer") && typeof p.nodePort === "number" ? { nodePort: p.nodePort } : {}) })),
        ...behaviourOf(sv),
      };
      // N10: 허용 목록 annotation (discover 가 이미 거름)
      if (sv.metadata.annotations) (ep as Record<string, unknown>).annotations = sv.metadata.annotations;
      const base = `components.${o.id}.endpoints.${sv.metadata.name}`;
      if (ep.loadBalancerIP) fieldMeta[`${base}.loadBalancerIP`] = { source: `k8s:${sv.metadata.namespace ?? ""}/service/${sv.metadata.name}.spec.loadBalancerIP`, confidence: 0.6, needs_review: true,
        rationale: "출발 고정 IP 는 다른 클라우드·클러스터에서 같게 못 받음 → 도착 IP 를 새로 받고 바깥 허용 목록·DNS 를 바꿔야 함" };
      if (ep.ports.some((p) => "nodePort" in p)) fieldMeta[`${base}.nodePort`] = { source: `k8s:${sv.metadata.namespace ?? ""}/service/${sv.metadata.name}.spec.ports.nodePort`, confidence: 0.9, needs_review: true,
        rationale: "출발 NodePort 번호 그대로. 도착 노드 IP 는 바뀌므로 바깥 장비(L4·방화벽)가 가리키는 노드 주소를 바꿔야 함" };
      const prev = (o.props.endpoints ?? []) as Array<{ name: string }>;
      o.props.endpoints = [...prev, ep].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      o.svcNames = [...(o.svcNames ?? []), sv.metadata.name];
    }
    // N11 (11/3 결정): L4 입구(LoadBalancer)는 도착에도 같은 LoadBalancer Service 로 옮긴다 (endpoints type 그대로). 가중치 전환은 HTTP 입구만 →
    //   주소가 바뀐다는 건 사전 점검 warn 줄이 알린다 (target/shared.ts l4Warnings). 그래서 unmapped 로 안 셈
  }
  return aliases.sort((a, b) => `${a.namespace ?? ""}/${a.name}`.localeCompare(`${b.namespace ?? ""}/${b.name}`));
}

/** Service 이름 → 그 Service 가 고르는 IR 서비스들. Service 객체를 못 읽었으면 이름이 같은 Deployment 로 추측(0.6). GW-1 도 씀 */
export function serviceTargets(components: MappedComponent[], svcObjs: RawK8sService[], ns: string | undefined, name: string) {
  const sv = svcObjs.find((x) => x.metadata.name === name && (!ns || x.metadata.namespace === ns));
  if (sv) { const os = components.filter((c) => selects(sv, c)); return os.length ? { cs: os, sv, conf: (os.length === 1 ? 1 : 0.6) as 1 | 0.6 } : null; }
  const o = components.find((c) => c.kind === "service" && c.native.name === name && (!ns || c.native.namespace === ns));
  return o ? { cs: [o], sv: null, conf: 0.6 as const } : null;
}

const PT: Record<string, "Exact" | "PathPrefix"> = { Exact: "Exact", Prefix: "PathPrefix", ImplementationSpecific: "PathPrefix" };

/** Ingress → 라우팅 호스트 목록 (호스트 이름 순). 없으면 undefined */
export function buildEntry(components: MappedComponent[], svcObjs: RawK8sService[], ingresses: RawK8sIngress[], fieldMeta: FieldMetaV2, unmapped: UnmappedV2[]): EntriesV2 | undefined {
  const serviceFor = (ns: string | undefined, name: string) => serviceTargets(components, svcObjs, ns, name);
  const hosts = new Map<string, Host>();
  // ENT-1 DRAFT(ai): Ingress 공개 여부. 내부 표시(클래스 이름에 internal·private, ALB scheme internal)면 internal,
  //   공개로 알려진 클래스(nginx·alb·gce·traefik 등)·internet-facing 이면 public, 그 밖의 클래스는 public 으로 두고 검토 표시
  const exposureOf = (ing: RawK8sIngress): { v: "public" | "internal"; sure: boolean; why: string } => {
    const ann = ing.metadata.annotations ?? {};
    const cls = ing.spec.ingressClassName ?? ann["kubernetes.io/ingress.class"] ?? "";
    const scheme = ann["alb.ingress.kubernetes.io/scheme"];
    if (scheme === "internal" || /internal|private/i.test(cls)) return { v: "internal", sure: true, why: scheme === "internal" ? "alb scheme internal" : `클래스 ${cls}` };
    if (scheme === "internet-facing" || !cls || PUBLIC_CLASSES.test(cls)) return { v: "public", sure: true, why: scheme ? `alb scheme ${scheme}` : cls ? `클래스 ${cls}` : "클래스 없음(기본 컨트롤러)" };
    return { v: "public", sure: false, why: `클래스 ${cls} 가 공개용인지 모름` };
  };
  // 같은 입력이면 같은 출력: Ingress 를 (네임스페이스, 이름) 순으로
  const ings = [...ingresses].sort((a, b) => `${a.metadata.namespace ?? ""}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace ?? ""}/${b.metadata.name}`));
  for (const ing of ings) {
    const ns = ing.metadata.namespace;
    const tlsHosts = new Set((ing.spec.tls ?? []).flatMap((t) => t.hosts ?? []));
    const own = new Set<string>();
    type Be = { service?: { name: string; port?: { number?: number; name?: string } } } | undefined;
    const toBackend = (b: Be | Record<string, unknown>, where: string, i: number, hostKey: string): Backend[] | null => {
      const bs = (b as Be)?.service;
      if (!bs) { unmapped.push({ resource: `k8s.ingress.${where}`, grade: "B", reason: "backend.resource → IR 에 없음" }); return null; }
      const f = serviceFor(ns, bs.name);
      if (!f) { unmapped.push({ resource: `k8s.ingress.${where}`, grade: "C", reason: "대상 Service 가 IR 서비스로 안 이어짐" }); return null; }
      const sports = f.sv?.spec.ports ?? [];
      const sp = f.sv ? (bs.port?.name ? sports.find((p) => p.name === bs.port!.name) : bs.port?.number ? sports.find((p) => p.port === bs.port!.number) : sports[0]) : undefined;
      const port = sp?.port ?? bs.port?.number ?? null;
      if (f.conf < 1 || port == null) fieldMeta[`entry.${hostKey}.routes[${i}].backend`] = { source: `k8s:ingress.${where}`, confidence: 0.6, needs_review: true,
        rationale: !f.sv ? "Service 객체를 못 읽어 같은 이름 Deployment 로 추측" : f.cs.length > 1 ? "Service 하나가 Deployment 여럿을 고름 → 출발 비율은 파드 수에 따름. weight 는 사람이 확인" : "Service 포트를 못 정함" };
      if (port == null) { unmapped.push({ resource: `k8s.ingress.${where}`, grade: "B", reason: "Service 포트를 못 정함 → 사람이 확인" }); return null; }
      return f.cs.map((c) => ({ to: c.id!, port, weight: 1 }));
    };
    for (const r of ing.spec.rules ?? []) {
      if (!r.host) { unmapped.push({ resource: `k8s.ingress.rule:${ing.metadata.name}(호스트 없음)`, grade: "B", reason: "호스트 없는 규칙 = 모든 호스트. 도착 호스트 이름을 사람이 정함" }); continue; }
      const h: Host = hosts.get(r.host) ?? { hostnames: [r.host], ...(tlsHosts.has(r.host) ? { tls: { mode: "terminate" as const, source: "ingress.spec.tls" } } : {}), routes: [] };
      hosts.set(r.host, h); own.add(r.host);
      // ENT-1: 같은 호스트를 공개·내부 Ingress 가 같이 받으면 안전한 쪽(internal) + 검토
      const ex = exposureOf(ing);
      if (!h.exposure) h.exposure = ex.v;
      else if (h.exposure !== ex.v) {
        h.exposure = "internal";
        fieldMeta[`entry.${r.host}.exposure`] = { source: `k8s:ingress/${ing.metadata.name}`, confidence: 0.6, needs_review: true, rationale: "같은 호스트를 공개·내부 Ingress 가 같이 받음 → 내부로 둠. 사람이 확인" };
      }
      if (!ex.sure && !fieldMeta[`entry.${r.host}.exposure`])
        fieldMeta[`entry.${r.host}.exposure`] = { source: `k8s:ingress/${ing.metadata.name}.ingressClassName`, confidence: 0.6, needs_review: true,
          rationale: `${ex.why} → 공개로 둠. 사내망 전용이었으면 internal 로 고친다 (공개 입구로 열리면 보안이 약해짐)` };
      // N10: Ingress 동작 annotation (허용 목록). 같은 호스트를 다른 Ingress 가 다른 값으로 적었으면 앞 것 유지 + 검토
      const ann = ing.metadata.annotations;
      if (ann) {
        if (!h.annotations) h.annotations = { ...ann };
        else if (JSON.stringify(h.annotations) !== JSON.stringify({ ...h.annotations, ...ann }))
          fieldMeta[`entry.${r.host}.annotations`] = { source: `k8s:ingress/${ing.metadata.name}.annotations`, confidence: 0.6, needs_review: true,
            rationale: "같은 호스트의 Ingress 여럿이 annotation 을 다르게 적음 → 첫 Ingress 값만. 경로별로 다르면 사람이 확인" };
      }
      if (r.host.startsWith("*.")) fieldMeta[`entry.${r.host}.hostnames`] = { source: `k8s:ingress.${r.host}`, confidence: 0.6, needs_review: true,
        rationale: "와일드카드 호스트: Ingress 는 레이블 하나만, HTTPRoute 는 더 넓게 맞을 수 있음 → 출발과 달라짐 줄(승인)" };
      for (const p of r.http?.paths ?? []) {
        const i = h.routes.length;
        const be = toBackend(p.backend, `${r.host}${p.path ?? ""}`, i, r.host);
        if (!be) continue;
        h.routes.push({ matches: [{ path: { type: PT[p.pathType ?? "ImplementationSpecific"] ?? "PathPrefix", value: p.path ?? "/" } }], backends: be });
        if (p.pathType !== "Exact" && p.pathType !== "Prefix")
          fieldMeta[`entry.${r.host}.routes[${i}]`] = { source: `k8s:ingress.${r.host}${p.path ?? ""}`, confidence: 0.6, needs_review: true,
            rationale: "pathType 이 ImplementationSpecific(또는 없음, 컨트롤러마다 뜻이 다름) → PathPrefix 로 둠" };
      }
    }
    const db = ing.spec.defaultBackend;
    if (db) {
      for (const host of [...own].sort()) {
        const h = hosts.get(host)!;
        const be = toBackend(db, "defaultBackend", h.routes.length, host);
        if (!be) break;
        if (!h.routes.some((x) => x.matches[0]?.path.value === "/")) h.routes.push({ matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: be });
      }
      unmapped.push({ resource: `k8s.ingress.defaultBackend:${ing.metadata.name}`, grade: "B", reason: "호스트 밖 요청을 받던 기본 백엔드 → 도착 호스트 이름을 사람이 정함" });
    }
  }
  const list = [...hosts.values()].filter((h) => h.routes.length).sort((a, b) => (a.hostnames[0]! < b.hostnames[0]! ? -1 : 1));
  return list.length ? { via: "cloudflare-lb", hosts: list } : undefined;
}

/** I9: 매퍼가 넘긴 라우팅 재료(ECS ALB 규칙)를 entry 에 더한다. 같은 호스트면 k8s 줄 뒤에 붙인다. 경로가 같은 줄은 안 겹친다 */
export function mergeRoutes(entry: EntriesV2 | undefined, components: MappedComponent[], fieldMeta: FieldMetaV2): EntriesV2 | undefined {
  if (!components.some((c) => c.routes?.length)) return entry;   // k8s 만이면 그대로 (같은 객체)
  const hosts = new Map<string, Host>((entry?.hosts ?? []).map((h) => [h.hostnames[0]!, h]));
  const touched = new Set<Host>();
  for (const c of [...components].sort((a, b) => (a.id! < b.id! ? -1 : 1))) {
    for (const r of c.routes ?? []) {
      const h: Host = hosts.get(r.host) ?? { hostnames: [r.host], routes: [] };
      hosts.set(r.host, h); touched.add(h);
      // EA-1: 출발 HTTPS 리스너 → 도착도 TLS 끝냄. 호스트 조건 없는 규칙 → ALB 주소가 임시 호스트라 사람이 도착 호스트를 정함
      if (r.tls && !h.tls) h.tls = { mode: "terminate", source: "alb.listener HTTPS" };
      if (r.hostUnknown) fieldMeta[`entry.${r.host}.hostnames`] = { source: `ecs:${c.native.name}.alb.rule`, confidence: 0.6, needs_review: true,
        rationale: "ALB 규칙에 호스트 조건이 없음(기본 규칙) → ALB 주소를 임시 호스트로. 손님이 쓰는 도메인을 사람이 적을 것" };
      // ALB path-pattern: "/api/*" → PathPrefix "/api", 끝 * 없는 글자 → Exact. 없으면 "/"
      const raw = r.path ?? "/";
      const prefix = raw.endsWith("*");
      const value = prefix ? (raw.replace(/\/?\*+$/, "") || "/") : raw;
      const type = prefix || raw === "/" ? "PathPrefix" as const : "Exact" as const;
      if (h.routes.some((x) => x.matches.some((mm) => mm.path.value === value && mm.path.type === type))) continue;
      h.routes.push({ matches: [{ path: { type, value } }], backends: [{ to: c.id!, port: r.port, weight: 1 }] });
      if (r.path == null) fieldMeta[`entry.${r.host}.routes[${h.routes.length - 1}]`] = { source: `ecs:${c.native.name}.hostname`, confidence: 0.9, needs_review: true,
        rationale: "ALB 규칙을 못 읽고 호스트만 앎 → \"/\" 전체를 이 서비스로" };
    }
  }
  // 긴 경로 먼저 (ALB 우선순위 대신 HTTPRoute 최장 일치 규칙과 같은 순서)
  for (const h of touched) h.routes.sort((a, b) => b.matches[0]!.path.value.length - a.matches[0]!.path.value.length);
  const list = [...hosts.values()].filter((h) => h.routes.length).sort((a, b) => (a.hostnames[0]! < b.hostnames[0]! ? -1 : 1));
  return list.length ? { via: "cloudflare-lb", hosts: list } : undefined;
}
