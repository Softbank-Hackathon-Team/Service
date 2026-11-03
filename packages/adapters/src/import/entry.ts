import type { EntriesV2, FieldMetaV2, UnmappedV2 } from "@svc/contracts";
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

/** Service 객체를 셀렉터로 Deployment 에 붙인다 (제자리) */
export function attachEndpoints(components: MappedComponent[], svcObjs: RawK8sService[], unmapped: UnmappedV2[]): void {
  for (const sv of svcObjs) {
    const owners = components.filter((c) => selects(sv, c));
    if (!owners.length) { unmapped.push({ resource: `k8s.service:${sv.metadata.name}`, grade: "B", reason: "셀렉터에 맞는 Deployment 없음" }); continue; }
    // 셀렉터가 여럿을 고르면(카나리·블루그린) 다 같은 Service 뒤에 있다는 뜻 → 각자에 붙이고 라우팅도 여럿으로
    for (const o of owners) {
      const t = sv.spec.type ?? "ClusterIP";
      const ep = {
        name: sv.metadata.name,
        type: ENDPOINT_TYPES.has(t) ? t : "ClusterIP",
        ports: (sv.spec.ports ?? []).map((p) => ({ ...(p.name ? { name: p.name } : {}), port: p.port, targetPort: p.targetPort ?? p.port,
          protocol: PROTOCOLS.has(p.protocol ?? "") ? p.protocol! : "TCP" })),
      };
      const prev = (o.props.endpoints ?? []) as Array<{ name: string }>;
      o.props.endpoints = [...prev, ep].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      o.svcNames = [...(o.svcNames ?? []), sv.metadata.name];
    }
    if (sv.spec.type === "LoadBalancer") unmapped.push({ resource: `k8s.service:${sv.metadata.name}`, grade: "B", reason: "L4 입구(LoadBalancer) → 도착 클러스터 LB 로 같은 포트 (H16)" });
  }
}

const PT: Record<string, "Exact" | "PathPrefix"> = { Exact: "Exact", Prefix: "PathPrefix", ImplementationSpecific: "PathPrefix" };

/** Ingress → 라우팅 호스트 목록 (호스트 이름 순). 없으면 undefined */
export function buildEntry(components: MappedComponent[], svcObjs: RawK8sService[], ingresses: RawK8sIngress[], fieldMeta: FieldMetaV2, unmapped: UnmappedV2[]): EntriesV2 | undefined {
  const serviceFor = (ns: string | undefined, name: string) => {
    const sv = svcObjs.find((x) => x.metadata.name === name && (!ns || x.metadata.namespace === ns));
    if (sv) { const os = components.filter((c) => selects(sv, c)); return os.length ? { cs: os, sv, conf: os.length === 1 ? 1 : 0.6 } : null; }
    const o = components.find((c) => c.kind === "service" && c.native.name === name && (!ns || c.native.namespace === ns));
    return o ? { cs: [o], sv: null, conf: 0.6 } : null;   // Service 객체를 못 읽음 → 이름이 같은 Deployment 로 추측
  };
  const hosts = new Map<string, Host>();
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
    const db = (ing.spec as { defaultBackend?: Record<string, unknown> }).defaultBackend;
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

/** v1 투영 재료: 호스트(v1 readK8sApp 순서)와 포트 보완. 저장 안 함 */
export function fillProjection(components: MappedComponent[], svcObjs: RawK8sService[], ingresses: RawK8sIngress[]): void {
  for (const c of components) {
    if (c.kind !== "service" || !c.projection) continue;
    const ns = c.native.namespace;
    const svc = svcObjs.find((s) => s.metadata.namespace === ns && selects(s, c));
    if (c.projection.port == null && svc) {
      const tp = (svc.spec.ports ?? []).map((p) => Number(p.targetPort ?? p.port)).filter((n) => n > 0);
      if (tp.length) c.projection.port = tp[0]!;
    }
    let hostname = "";
    if (svc) {
      const sname = svc.metadata.name;
      for (const ing of ingresses.filter((i) => i.metadata.namespace === ns))
        for (const r of ing.spec.rules ?? [])
          if (!hostname && (r.http?.paths ?? []).some((p) => p.backend?.service?.name === sname)) hostname = r.host ?? "";
      const lb = svc.status?.loadBalancer?.ingress?.[0];
      if (!hostname && lb) hostname = lb.hostname ?? lb.ip ?? "";
      if (!hostname) hostname = `${sname}.${ns}.svc.cluster.local`;
    } else hostname = `${c.native.name}.${ns}.svc.cluster.local`;
    c.projection.hostname = hostname;
  }
}
