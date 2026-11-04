import { K8S_RAW_KINDS, type RawK8sContainer, type RawK8sDeployment, type RawK8sPodSpec, type RawK8sProbe } from "../raw-k8s.js";
import { appLabelsOf } from "../app-group.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";
import { podExtrasOf } from "./k8s-pod-extras.js";

// DRAFT(ai): k8s Deployment → service 리소스. 설계 20번 4.2장·6.1장, PoC KIND_MAPPERS["k8s.deployment"].
//   원칙: 출발에 있는 것만 적는다(프로브·requests 없으면 비움). digest 없으면 리소스가 아니라 unmapped B (R9).

// ── 값 다듬기 (k8s 수량) ─────────────────────────────
// 이진(Ki Mi Gi Ti Pi Ei) · 십진(k M G T P E) · 지수 · 밀리(m). 못 읽으면 null (NaN 을 안 낸다)
const SUFFIX: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, m: 1e-3, "": 1 };
export const parseQuantity = (q: unknown): number | null => {
  if (q == null) return null;
  const mt = String(q).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E|m)?$/);
  if (!mt) return null;
  const v = Number(mt[1]) * (SUFFIX[mt[2] ?? ""] ?? 1);
  return Number.isFinite(v) ? v : null;
};
export const cpuMilliOf = (q: unknown): number | null => { const v = parseQuantity(q); return v == null ? null : Math.round(v * 1000); };
export const mibOf = (q: unknown): number | null => { const v = parseQuantity(q); return v == null ? null : Math.ceil(v / 2 ** 20); };

/** "repo:tag" → repository (태그 떼기, 레지스트리 포트 :5000 은 남김). "repo@sha256:…" → 그 digest */
export const splitImage = (ref: string, digest: string | null | undefined): { repository: string; digest: string | null } => {
  const at = ref.indexOf("@");
  // "repo:tag@sha256:…" 는 tag 를 떼고 repository 만 (digest 가 있으면 tag 는 의미 없음). 레지스트리 포트 :5000 은 남김
  if (at >= 0) return { repository: ref.slice(0, at).replace(/:[^/:]+$/, ""), digest: ref.slice(at + 1) };
  return { repository: ref.replace(/:[^/:]+$/, ""), digest: digest ?? null };
};

const clean = <T extends Record<string, unknown>>(o: T): T => { for (const k of Object.keys(o)) if (o[k] == null) delete o[k]; return o; };

// G-1: cpu·memory 말고 적힌 이름은 extended 에 글자 그대로 (단위 바꾸지 않음, 이름순)
const amountOf = (o: { cpu?: string; memory?: string; [name: string]: string | undefined } | undefined) => {
  if (!o) return undefined;
  const ext = Object.entries(o).filter(([k, v]) => k !== "cpu" && k !== "memory" && v != null).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (o.cpu == null && o.memory == null && !ext.length) return undefined;
  return { cpuMilli: cpuMilliOf(o.cpu), memMiB: mibOf(o.memory), ...(ext.length ? { extended: Object.fromEntries(ext.map(([k, v]) => [k, String(v)])) } : {}) };
};
export const resourcesOf = (c: RawK8sContainer): Record<string, unknown> => {
  const r = c.resources ?? {};
  const out: Record<string, unknown> = {};
  const req = amountOf(r.requests), lim = amountOf(r.limits);
  if (req) out.request = req;
  if (lim) out.limit = lim;
  return out;
};

// 프로브: 있는 것만, 있는 칸만. 없으면 만들지 않는다
export const probeOf = (p: RawK8sProbe | undefined): Record<string, unknown> | undefined => {
  if (!p) return undefined;
  // PR-1: 출발 프로브 칸 전부 (timeout·successThreshold·프로브 종료 유예)
  const t = { periodSec: p.periodSeconds, failureThreshold: p.failureThreshold, initialDelaySec: p.initialDelaySeconds,
    timeoutSec: p.timeoutSeconds, successThreshold: p.successThreshold, terminationGracePeriodSec: p.terminationGracePeriodSeconds };
  if (p.httpGet) {
    const scheme = p.httpGet.scheme === "HTTP" || p.httpGet.scheme === "HTTPS" ? p.httpGet.scheme : undefined;
    // DRAFT(ai): k8s httpGet.port 는 필수라 실제 클러스터 원본엔 늘 있다. 손으로 만든 원본(옛 데모)에 없으면 지어내지 않고 프로브를 뺀다
    if (p.httpGet.port == null) return undefined;
    const headers = p.httpGet.httpHeaders?.length ? p.httpGet.httpHeaders.map((h) => ({ name: h.name, value: h.value })) : undefined;
    return clean({ type: "http", path: p.httpGet.path, port: p.httpGet.port, scheme, headers, ...t });
  }
  if (p.tcpSocket?.port != null) return clean({ type: "tcp", port: p.tcpSocket.port, ...t });
  if (p.grpc?.port != null) return clean({ type: "grpc", port: p.grpc.port, service: p.grpc.service, ...t });
  if (p.exec?.command) return clean({ type: "exec", command: p.exec.command, ...t });
  return undefined;
};

export const envOf = (c: RawK8sContainer): Array<Record<string, unknown>> => (c.env ?? []).map((e) => {
  const vf = e.valueFrom;
  if (e.value !== undefined) return { name: e.name, value: e.value };
  // EV-1: optional·containerName·divisor 그대로 (있을 때만)
  const opt = (o: { optional?: boolean }) => (typeof o.optional === "boolean" ? { optional: o.optional } : {});
  if (vf?.secretKeyRef) return { name: e.name, fromSecret: { secret: vf.secretKeyRef.name, key: vf.secretKeyRef.key, ...opt(vf.secretKeyRef) } };
  if (vf?.configMapKeyRef) return { name: e.name, fromConfig: { config: vf.configMapKeyRef.name, key: vf.configMapKeyRef.key, ...opt(vf.configMapKeyRef) } };
  if (vf?.fieldRef) return { name: e.name, fromField: vf.fieldRef.fieldPath };
  if (vf?.resourceFieldRef) return { name: e.name, fromResource: vf.resourceFieldRef.resource,
    ...(vf.resourceFieldRef.containerName ? { containerName: vf.resourceFieldRef.containerName } : {}),
    ...(vf.resourceFieldRef.divisor != null ? { divisor: String(vf.resourceFieldRef.divisor) } : {}) };
  return { name: e.name, value: "" };
});
const envFromOf = (c: RawK8sContainer): Array<{ config: string; prefix: string } | { secret: string; prefix: string }> => (c.envFrom ?? []).flatMap((f): Array<{ config: string; prefix: string } | { secret: string; prefix: string }> =>
  f.configMapRef ? [{ config: f.configMapRef.name, prefix: f.prefix ?? "", ...(typeof f.configMapRef.optional === "boolean" ? { optional: f.configMapRef.optional } : {}) }]
  : f.secretRef ? [{ secret: f.secretRef.name, prefix: f.prefix ?? "", ...(typeof f.secretRef.optional === "boolean" ? { optional: f.secretRef.optional } : {}) }] : []);

const m = (source: string, confidence: 1 | 0.9 | 0.6 = 1, rationale?: string): MetaTuple =>
  rationale === undefined ? [source, confidence] : [source, confidence, rationale];

/** service·job 공통 필드 (주 컨테이너 = containers[0]). N4·N5·N10: 사이드카·init·볼륨·배치·annotation 은 podExtrasOf */
export function workloadOf(ns: string | undefined, digest: string | null, c: RawK8sContainer, pod: RawK8sPodSpec, src: string, digests?: Record<string, string>, nodeArch?: string[]) {
  const resources = resourcesOf(c);
  const probes = clean({ readiness: probeOf(c.readinessProbe), liveness: probeOf(c.livenessProbe), startup: probeOf(c.startupProbe) });
  const envFrom = envFromOf(c);
  const img = splitImage(c.image, digest);
  const props: Record<string, unknown> = clean({
    namespace: ns,
    image: { source: "registry", repository: img.repository, digest: img.digest },
    command: c.command, args: c.args,
    resources, env: envOf(c),
    envFrom: envFrom.length ? envFrom : undefined,
    serviceAccount: pod.serviceAccountName ?? "default",   // k8s 규칙: 안 적으면 default
    securityContext: c.securityContext,
    probes: Object.keys(probes).length ? probes : undefined,
    nodeArch: nodeArch?.length ? [...nodeArch] : undefined,   // A-1. 노드를 못 읽었으면 칸 없음 (검토 줄은 pipeline 의 unread.Node)
  });
  const extras = podExtrasOf(pod, c, digests, src.replace(/\.containers\[0\]$/, ""));
  Object.assign(props, extras.props);
  const given = c.resources ?? {};
  const unread = [given.requests, given.limits].some((o) => o && ((o.cpu != null && cpuMilliOf(o.cpu) == null) || (o.memory != null && mibOf(o.memory) == null)));
  const meta: Record<string, MetaTuple> = {
    image: c.image.includes("@") ? m(`${src}.image`) : digest ? m(`${src}.image + running pod digest`) : m(`${src}.image`, 0.6, "태그만 있고 digest 못 읽음"),
    resources: unread ? m(`${src}.resources`, 0.6, "값은 있는데 수량을 못 읽음 → 비워 둠")
      : Object.keys(resources).length ? m(`${src}.resources`) : m(`${src}.resources`, 0.9, "출발에 requests·limits 없음(확인됨) → 도착도 없음"),
    probes: Object.keys(probes).length ? m(`${src}.probes`) : m(`${src}.probes`, 0.9, "출발에 프로브 없음(확인됨) → 만들지 않음"),
    serviceAccount: pod.serviceAccountName ? m(`${src}.serviceAccountName`) : m(`${src}.serviceAccountName`, 1, "안 적힘 = k8s 기본 default"),
    ...extras.meta,
    ...(nodeArch?.length ? { nodeArch: m(`${src} running pod nodes kubernetes.io/arch`, 1, nodeArch.length > 1 ? "여러 CPU 종류 노드에서 돎 = multi-arch 이미지" : undefined) } : {}),
  };
  return { props, meta, partial: extras.unmapped };
}

/** PL-2: 파드 템플릿 라벨 (없으면 칸 없음, 키 순서 고정) */
export const podLabelsOf = (l: Record<string, string> | undefined): { podLabels?: Record<string, string> } =>
  l && Object.keys(l).length ? { podLabels: Object.fromEntries(Object.entries(l).sort(([a], [b]) => a.localeCompare(b))) } : {};

/** D6: Deployment·StatefulSet·DaemonSet 공통 (파드 모양 같음). 종류별 칸은 부르는 쪽이 extra 로 */
export interface K8sPodOwner {
  type: string; label: "deployment" | "statefulset" | "daemonset";
  name: string; namespace?: string; labels?: Record<string, string>;
  podLabels: Record<string, string>; pod: RawK8sPodSpec; imageDigest: string | null; replicas: number;
  containerDigests?: Record<string, string>; digestReview?: string;   // G3-4
  nodeArch?: string[];   // A-1
}
export function serviceFromPodOwner(o: K8sPodOwner, extra: { props?: Record<string, unknown>; meta?: Record<string, MetaTuple> } = {}): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
  const pod = o.pod;
  const c = pod.containers[0];
  if (!c) return { skip: "컨테이너 없음", grade: "C" };
  const ns = o.namespace;
  const digest = o.imageDigest ?? null;
  // R9: digest 없는 워크로드는 리소스가 아니라 unmapped B (도착에 같은 이미지를 못 박음)
  if (!digest && !c.image.includes("@sha256:")) return { skip: `이미지 digest 를 못 읽음 (실행 중 Pod 없음, 태그 ${c.image}) → 사람이 확인`, grade: "B" };
  const base = `k8s:${ns ?? ""}/${o.label}/${o.name}`;
  const src = `${base}.containers[0]`;
  const w = workloadOf(ns, digest, c, pod, src, o.containerDigests, o.nodeArch);
  if (o.digestReview && !c.image.includes("@")) w.meta.image = m(`${src}.image + running pod digest`, 0.6, o.digestReview);   // G3-4
  const ports = (c.ports ?? []).map((p) => clean({ name: p.name, port: p.containerPort, protocol: p.protocol ?? "TCP", hostPort: p.hostPort }));
  const replicas = o.replicas;
  return {
    name: o.name, ...(ns ? { ns } : {}), kind: "service",
    native: { type: o.type, name: o.name, ...(ns ? { namespace: ns } : {}), labels: o.podLabels,
      ...(appLabelsOf(o.labels) ? { appLabels: appLabelsOf(o.labels) } : {}) },
    props: { runtime: "k8s", origin: { runtime: "k8s", product: "k8s" }, ...w.props, ...podLabelsOf(o.podLabels), ...(ports.length ? { ports } : {}), replicas: { min: replicas, max: replicas }, ...extra.props },
    ...(w.partial.length ? { partial: w.partial } : {}),
    meta: {
      ...w.meta,
      origin: m(base, 1, "k8s 출발 → 도착도 k8s (재현성)"),
      ports: ports.length ? m(`${src}.ports`) : m(`${src}.ports`, 0.9, "포트 선언 없음 (Service targetPort 로 보완)"),
      replicas: m(`${base}.spec.replicas`),
      ...extra.meta,
    },
  };
}

export const k8sDeploymentMapper: KindMapper = {
  nativeTypes: [K8S_RAW_KINDS.deployment],
  kind: "service",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const it = item as unknown as RawK8sDeployment;
    // D6: workloadKind 는 deployment 일 때 칸을 안 둔다 (옛 IR·지문 그대로)
    return serviceFromPodOwner({ type: K8S_RAW_KINDS.deployment, label: "deployment", name: it.metadata.name, namespace: it.metadata.namespace,
      labels: it.metadata.labels, podLabels: it.spec.template.metadata?.labels ?? {}, pod: it.spec.template.spec,
      imageDigest: it.imageDigest ?? null, replicas: it.spec.replicas ?? 1,
      containerDigests: it.containerDigests, digestReview: it.digestReview, nodeArch: it.nodeArch });
  },
};
