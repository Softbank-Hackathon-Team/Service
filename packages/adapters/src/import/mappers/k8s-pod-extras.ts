import type { RawK8sContainer, RawK8sPodSpec } from "../raw-k8s.js";
import type { MetaTuple } from "../types.js";
import { envOf, probeOf, resourcesOf, splitImage } from "./k8s-deployment.js";

// N4·N5·N10 DRAFT(ai): 파드 안의 "주 컨테이너 밖" 칸을 IR 로 (그대로 이식).
//   - 사이드카 = containers[1..], 초기화 컨테이너 = initContainers (네이티브 사이드카 restartPolicy Always 그대로)
//   - 파드 볼륨: PVC 참조 → volumes[] (claimName, 크기는 파이프라인이 PVC 객체로 채움), 그 밖 아는 종류 → podVolumes[], 모르는 종류 → 검토
//   - 마운트: 주 컨테이너 volumeMounts, 보조 컨테이너마다 volumeMounts
//   - 배치: nodeSelector·tolerations·affinity·topologySpreadConstraints·priorityClassName 원문. 노드·노드풀·영역 이름이 박힌 값은 도착에서 안 맞을 수 있어 0.6
//   - 파드 annotation: 허용 목록 키만 (discover 가 이미 거름)
//   값을 지어내지 않는다: 없으면 칸을 안 둔다.

const clean = <T extends Record<string, unknown>>(o: T): T => { for (const k of Object.keys(o)) if (o[k] == null) delete o[k]; return o; };

// 메시가 넣는 컨테이너 이름 (출발 파드 템플릿에 굳어 있으면 도착 메시가 다시 넣으므로 injected 로 표시)
const MESH_SIDECAR = /^(istio-proxy|istio-init|linkerd-proxy|linkerd-init|kuma-sidecar|kuma-init)$/;

/** 컨테이너 하나 → IR Container (사이드카·init 공통) */
export function containerIR(c: RawK8sContainer, digest: string | null | undefined, init: boolean): Record<string, unknown> {
  const img = splitImage(c.image, digest ?? null);
  const probes = clean({ readiness: probeOf(c.readinessProbe), liveness: probeOf(c.livenessProbe), startup: probeOf(c.startupProbe) });
  const ports = (c.ports ?? []).map((p) => clean({ name: p.name, port: p.containerPort, protocol: p.protocol ?? "TCP", hostPort: p.hostPort }));
  const res = resourcesOf(c);
  return clean({
    name: c.name ?? "",
    image: { source: "registry", repository: img.repository, digest: img.digest },
    command: c.command, args: c.args,
    ports: ports.length ? ports : undefined,
    env: envOf(c),
    resources: res,
    probes: Object.keys(probes).length ? probes : undefined,
    injected: MESH_SIDECAR.test(c.name ?? "") ? true : undefined,
    volumeMounts: c.volumeMounts?.length ? c.volumeMounts.map((m) => clean({ ...m })) : undefined,
    restartPolicy: init && c.restartPolicy === "Always" ? "Always" : undefined,
    securityContext: c.securityContext,
  });
}

const POD_TYPES = ["configMap", "secret", "emptyDir", "projected", "downwardAPI", "hostPath"] as const;
// 노드·노드풀·영역 이름이 박히는 라벨 키 (도착 클러스터에서 값이 다름)
const NODE_SPECIFIC = /^(kubernetes\.io\/hostname|topology\.kubernetes\.io\/(zone|region)|failure-domain\.beta\.kubernetes\.io\/(zone|region)|node\.kubernetes\.io\/instance-type|beta\.kubernetes\.io\/instance-type|eks\.amazonaws\.com\/nodegroup|alpha\.eksctl\.io\/nodegroup-name|cloud\.google\.com\/gke-nodepool|cloud\.google\.com\/machine-family|karpenter\.sh\/nodepool|kubernetes\.azure\.com\/agentpool)$/;
const keysIn = (x: unknown, out: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(x)) x.forEach((v) => keysIn(v, out));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x as Record<string, unknown>)) { if (k === "key" && typeof v === "string") out.add(v); else keysIn(v, out); if (k !== "key") out.add(k); }
  return out;
};

export interface PodExtras {
  props: Record<string, unknown>;
  meta: Record<string, MetaTuple>;
  /** 옮기지 못한 볼륨 종류 등 (unmapped B 재료) */
  unmapped: Array<{ resource: string; reason: string }>;
}

/** 주 컨테이너 c 밖의 파드 칸. digests = 컨테이너 이름 → 실행 중 Pod 의 digest */
export function podExtrasOf(pod: RawK8sPodSpec, c: RawK8sContainer, digests: Record<string, string> | undefined, src: string): PodExtras {
  const props: Record<string, unknown> = {};
  const meta: Record<string, MetaTuple> = {};
  const unmapped: PodExtras["unmapped"] = [];
  const dg = (x: RawK8sContainer) => (x.name ? digests?.[x.name] : undefined) ?? null;

  // 사이드카·init
  // DRAFT(ai): digest 를 못 박는 컨테이너(태그만 있고 실행 중 Pod 에도 없음)는 0.6 검토와 이유를 남긴다 (ECS·Cloud Run 과 같은 표시).
  //   ECS·Cloud Run 과 달리 빼지는 않는다: 인자가 DB 연결 근거(Cloud SQL Auth Proxy 등)라 빼면 연결이 조용히 사라짐. 사전 점검이 그리기 전에 막는다.
  //   메시 주입형은 도착이 그리지 않고 도착 메시가 다시 넣으므로 검토 이유가 아니다
  const others = pod.containers.filter((x) => x !== c);
  const extras = (key: "sidecars" | "initContainers", xs: RawK8sContainer[], init: boolean, path: string) => {
    if (!xs.length) return;
    const ir = xs.map((x) => containerIR(x, dg(x), init));
    props[key] = ir;
    const unpinned = ir.filter((x) => x.injected !== true && !(x.image as { digest: string | null }).digest).map((x) => String(x.name));
    meta[key] = unpinned.length ? [path, 0.6, `태그만 있고 digest 를 못 찾은 ${unpinned.join(",")} 은 도착에 같은 이미지를 못 박음 → digest 를 넣거나 빼야 계획이 통과 (사람이 확인)`] : [path, 1];
  };
  extras("sidecars", others, false, `${src}.containers[1..]`);
  extras("initContainers", pod.initContainers ?? [], true, `${src}.initContainers`);

  // 볼륨
  const mountsOf = (name: string) => [c, ...others, ...(pod.initContainers ?? [])].flatMap((x) => (x.volumeMounts ?? []).filter((m) => m.name === name));
  const pvcs: Array<Record<string, unknown>> = [];
  const podVolumes: Array<Record<string, unknown>> = [];
  const secretMounts: Array<{ secret: string; mountPath: string }> = [];
  let odd = false;
  for (const v of pod.volumes ?? []) {
    const pvc = v.persistentVolumeClaim as { claimName?: string; readOnly?: boolean } | undefined;
    if (pvc?.claimName) {
      const mm = (c.volumeMounts ?? []).find((m) => m.name === v.name) ?? mountsOf(v.name)[0];
      if (!mm) { unmapped.push({ resource: `volume:${v.name}`, reason: "PVC 볼륨인데 마운트하는 컨테이너가 없음 → 사람이 확인" }); odd = true; continue; }
      pvcs.push(clean({ name: v.name, mountPath: mm.mountPath, claimName: pvc.claimName }));
      continue;
    }
    const t = POD_TYPES.find((k) => v[k] !== undefined);
    if (!t) {
      unmapped.push({ resource: `volume:${v.name}`, reason: `볼륨 종류 ${String(v.other ?? "?")} 은 IR 에 칸이 없음 → 도착에 그대로 못 옮김 (사람이 확인)` });
      odd = true;
      continue;
    }
    const source = (v[t] && typeof v[t] === "object" ? v[t] : {}) as Record<string, unknown>;
    podVolumes.push({ name: v.name, type: t, source });
    if (t === "hostPath") odd = true;
    // 예전 칸(secretMounts)도 채운다: 비밀 이름 목록(N2 복사·도착 ExternalSecret)이 이 칸을 본다
    if (t === "secret" && typeof source.secretName === "string") {
      const mm = (c.volumeMounts ?? []).find((m) => m.name === v.name) ?? mountsOf(v.name)[0];
      if (mm) secretMounts.push({ secret: source.secretName, mountPath: mm.mountPath });
    }
  }
  if (pvcs.length) { props.volumes = pvcs; meta.volumes = [`${src}.volumes(persistentVolumeClaim)`, 0.6, "디스크 데이터는 안 따라옴(리플랫폼) → 도착은 같은 이름의 빈 PVC. 데이터가 필요하면 사람이 확인"]; }
  if (podVolumes.length) {
    props.podVolumes = podVolumes;
    meta.podVolumes = odd ? [`${src}.volumes`, 0.6, "hostPath·모르는 볼륨 종류가 있음 → 도착 노드에 같은 경로·장치가 없을 수 있음"] : [`${src}.volumes`, 1];
  } else if (odd) meta.podVolumes = [`${src}.volumes`, 0.6, "모르는 볼륨 종류가 있어 못 옮김 → 사람이 확인"];
  if (secretMounts.length) props.secretMounts = secretMounts;
  if (c.volumeMounts?.length) { props.volumeMounts = c.volumeMounts.map((m) => clean({ ...m })); meta.volumeMounts = [`${src}.volumeMounts`, 1]; }

  // 배치
  const sch = clean({
    nodeSelector: pod.nodeSelector, tolerations: pod.tolerations, affinity: pod.affinity,
    topologySpreadConstraints: pod.topologySpreadConstraints, priorityClassName: pod.priorityClassName,
  });
  if (Object.keys(sch).length) {
    props.scheduling = sch;
    const specific = [...new Set([...Object.keys(pod.nodeSelector ?? {}), ...keysIn(pod.affinity)].filter((k) => NODE_SPECIFIC.test(k)))].sort();
    meta.scheduling = specific.length
      ? [`${src}.nodeSelector·affinity`, 0.6, `노드·노드풀·영역 이름 키(${specific.join(",")})가 있음 → 도착 노드 라벨이 달라 파드가 안 뜰 수 있음. 사람이 확인`]
      : [`${src}.nodeSelector·tolerations·affinity`, 1];
  }
  // HN-1: 노드 네트워크·프로세스 공유는 그대로 옮기되 보안 낮음 → checkV2 가 host_access 승인 줄
  const host = clean({ network: pod.hostNetwork || undefined, pid: pod.hostPID || undefined, ipc: pod.hostIPC || undefined });
  if (Object.keys(host).length) { props.host = host; meta.host = [`${src}.hostNetwork·hostPID·hostIPC`, 1]; }
  if (pod.podAnnotations) { props.podAnnotations = pod.podAnnotations; meta.podAnnotations = [`${src}.template.metadata.annotations(허용 목록)`, 1]; }
  // SS-V: Vault Agent 주입 → secretSources (경로·파일 이름만)
  const va = pod.podAnnotations ?? {};
  if (va["vault.hashicorp.com/agent-inject"] === "true") {
    const refs = Object.keys(va).filter((k) => k.startsWith("vault.hashicorp.com/agent-inject-secret-")).sort().map((k) => {
      const file = k.slice("vault.hashicorp.com/agent-inject-secret-".length);
      return { key: va[`vault.hashicorp.com/agent-inject-file-${file}`] ?? file, remote: va[k]! };
    });
    props.secretSources = [{ via: "vault-agent", provider: "vault", ...(va["vault.hashicorp.com/role"] ? { role: va["vault.hashicorp.com/role"] } : {}), refs }];
    meta.secretSources = [`${src}.template.metadata.annotations(vault.hashicorp.com)`, 0.6, "Vault Agent 가 /vault/secrets 아래에 비밀 파일을 넣음 → 도착에 Vault 연결·같은 경로가 있어야 함. 사람이 확인"];
  }
  return { props, meta, unmapped };
}
