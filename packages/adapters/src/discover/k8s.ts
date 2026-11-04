import { arr, classifyCliError, CliError, get, incomplete, runJson, runText, sourceFail, str, type CliDeps } from "../common/cli.js";
import { NS_ANNOTATION_KEYS, NS_LABEL_KEYS, type RawK8sContainer, type RawK8sItem, type RawK8sMeta, type RawK8sPodSpec } from "../import/raw-k8s.js";
import { allowAnnotations, droppedAnnotations, type AnnotationScope } from "../import/annotations.js";
import { pickItem, type RawPick } from "../common/unread.js";

// Z88: 쿠버네티스(EKS·GKE·k3s 공통) 앱 네임스페이스 읽기 (전부 get -o json).
// 비밀값은 안 읽는다(secretKeyRef 이름만, Secret 객체는 안 봄)

const SYSTEM_NS = /^(kube-|cnpg-system$|cert-manager$|argocd$|external-secrets$|ingress-nginx$|monitoring$|gmp-|gke-)/;
type Obj = Record<string, unknown>;

const meta = (o: Obj, k: "name" | "namespace") => str(get(o, "metadata", k)) ?? "";
const labelsMatch = (sel: Obj | undefined, labels: Obj | undefined) =>
  !!sel && Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels?.[k] === v);

// ── I2: 네임스페이스 전체 읽기 (공통 명세의 재료) ──────────────────────────────
// 같은 네임스페이스의 모든 워크로드·연결 재료를 kube 원문에 가깝게 읽는다.
// 종류별로 kubectl 을 따로 부른다 → 하나가 403 이어도 나머지는 계속, 실패는 notes 에 남는다. Deployment 목록만 못 읽으면 멈춘다(CliError).
// 허용 목록 방식: metadata.annotations 는 허용 키만(N10), Pod 항목·Secret 객체는 안 읽고, ConfigMap 은 data 값까지(N3)·binaryData 는 키만.

export interface K8sNamespaceOpts { namespace?: string; extraEnv?: Record<string, string> }
export interface K8sNamespaceRead {
  items: RawK8sItem[];
  namespace: string;
  /** N9: 읽은 네임스페이스 전부 (첫 번째 = namespace) */
  namespaces?: string[];
  counts: Record<string, number>;
  notes: string[];
}

const defined = <T extends Obj>(o: T): T => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };
const strMap = (x: unknown): Record<string, string> | undefined => {
  if (!x || typeof x !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(x as Obj)) if (typeof v === "string") out[k] = v;
  return Object.keys(out).length ? out : undefined;
};
const allow = (x: unknown, keys: readonly string[]): Record<string, string> | undefined => {
  const m = strMap(x);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const k of keys) if (m[k] !== undefined) out[k] = m[k]!;
  return Object.keys(out).length ? out : undefined;
};
// AN-1: 버린 annotation 은 키 이름만 남긴다 (값은 안 읽음). podTpl = 파드 템플릿 annotation 도 "pod:" 로
const metaOf = (o: Obj, scope?: AnnotationScope, podTpl?: unknown): RawK8sMeta => {
  const dropped = [...(scope ? droppedAnnotations(scope, get(o, "metadata", "annotations")) : []),
    ...(podTpl ? droppedAnnotations("pod", get(podTpl, "metadata", "annotations")).map((k) => `pod:${k}`) : [])];
  return defined({ name: meta(o, "name"), namespace: meta(o, "namespace") || undefined, labels: strMap(get(o, "metadata", "labels")),
    annotations: scope ? allowAnnotations(scope, get(o, "metadata", "annotations")) : undefined, droppedAnnotations: dropped.length ? dropped : undefined });
};
const pick = (o: unknown, keys: string[]): Obj | undefined => {
  if (!o || typeof o !== "object") return undefined;
  const out: Obj = {};
  for (const k of keys) if ((o as Obj)[k] !== undefined) out[k] = (o as Obj)[k];
  return Object.keys(out).length ? out : undefined;
};
/** G3-2: Ingress 백엔드. service 는 이름·포트, resource 백엔드(버킷 등)는 종류·이름만 표시 (매퍼가 unmapped B 로) */
const backendOf = (b: unknown) => defined({ service: pick(get(b, "service"), ["name", "port"]),
  resource: pick(get(b, "resource"), ["apiGroup", "kind", "name"]) } as Obj);
const probeOf = (p: unknown) => {
  if (!p || typeof p !== "object") return undefined;
  const o = p as Obj;
  return defined({
    httpGet: pick(o.httpGet, ["path", "port", "scheme", "httpHeaders"]), tcpSocket: pick(o.tcpSocket, ["port"]),
    grpc: pick(o.grpc, ["port", "service"]), exec: pick(o.exec, ["command"]),
    initialDelaySeconds: o.initialDelaySeconds, periodSeconds: o.periodSeconds, timeoutSeconds: o.timeoutSeconds,
    successThreshold: o.successThreshold, failureThreshold: o.failureThreshold,
    terminationGracePeriodSeconds: o.terminationGracePeriodSeconds,   // PR-1
  } as Obj);
};
const envOf = (e: Obj) => {
  const vf = get(e, "valueFrom") as Obj | undefined;
  return defined({
    name: String(e.name), value: typeof e.value === "string" ? e.value : undefined,
    // EV-1: optional·divisor 도 읽는다
    valueFrom: vf ? defined({ secretKeyRef: pick(vf.secretKeyRef, ["name", "key", "optional"]), configMapKeyRef: pick(vf.configMapKeyRef, ["name", "key", "optional"]),
      fieldRef: pick(vf.fieldRef, ["fieldPath"]), resourceFieldRef: pick(vf.resourceFieldRef, ["resource", "containerName", "divisor"]) }) : undefined,
  } as Obj);
};
const containerOf = (c: Obj): RawK8sContainer => defined({
  name: str(c.name) ?? undefined, image: str(c.image) ?? "",
  command: Array.isArray(c.command) ? c.command : undefined, args: Array.isArray(c.args) ? c.args : undefined,
  ports: arr(c.ports).length ? arr(c.ports).map((p) => defined({ name: str(p.name) ?? undefined, containerPort: Number(p.containerPort), protocol: str(p.protocol) ?? undefined,
    hostPort: Number(p.hostPort) > 0 ? Number(p.hostPort) : undefined })) : undefined,
  env: arr(c.env).length ? arr(c.env).map(envOf) : undefined,
  envFrom: arr(c.envFrom).length ? arr(c.envFrom).map((f) => defined({ configMapRef: pick(f.configMapRef, ["name", "optional"]), secretRef: pick(f.secretRef, ["name", "optional"]), prefix: str(f.prefix) ?? undefined })) : undefined,
  resources: pick(c.resources, ["requests", "limits"]),
  readinessProbe: probeOf(c.readinessProbe), livenessProbe: probeOf(c.livenessProbe), startupProbe: probeOf(c.startupProbe),
  securityContext: (c.securityContext && typeof c.securityContext === "object") ? c.securityContext as Obj : undefined,
  volumeMounts: arr(c.volumeMounts).length ? arr(c.volumeMounts).map((v) => defined({ name: String(v.name), mountPath: String(v.mountPath),
    subPath: str(v.subPath) ?? undefined, readOnly: typeof v.readOnly === "boolean" ? v.readOnly : undefined })) : undefined,
  restartPolicy: str(c.restartPolicy) ?? undefined,   // N4: 네이티브 사이드카
} as Obj) as unknown as RawK8sContainer;
// N4 DRAFT(ai): 파드 볼륨은 아는 종류만 원문으로. 모르는 종류(csi·nfs·iscsi …)는 종류 이름만 남긴다 (값을 지어내지 않고 매퍼가 막음)
const VOLUME_TYPES = ["configMap", "secret", "emptyDir", "persistentVolumeClaim", "projected", "downwardAPI", "hostPath"];
const volumeOf = (v: Obj): Obj => {
  const t = VOLUME_TYPES.find((k) => v[k] !== undefined);
  if (t) return { name: String(v.name), [t]: v[t] };
  const other = Object.keys(v).filter((k) => k !== "name").sort()[0] ?? "unknown";
  return { name: String(v.name), other };
};
const podSpecOf = (s: unknown): RawK8sPodSpec => {
  const o = (s ?? {}) as Obj;
  return defined({
    serviceAccountName: str(o.serviceAccountName) ?? undefined, restartPolicy: str(o.restartPolicy) ?? undefined,
    // SC-1: 이미지 받기 비밀 이름만 (비밀 type 추정 재료. 도착 렌더는 P-1 몫)
    imagePullSecrets: arr(o.imagePullSecrets).length ? arr(o.imagePullSecrets).map((x) => str(x.name) ?? "").filter(Boolean) : undefined,
    initContainers: arr(o.initContainers).length ? arr(o.initContainers).map(containerOf) : undefined,
    containers: arr(o.containers).map(containerOf),
    volumes: arr(o.volumes).length ? arr(o.volumes).map(volumeOf) : undefined,
    // N5: 배치 칸 원문 (노드 이름 검토는 매퍼)
    nodeSelector: strMap(o.nodeSelector),
    tolerations: arr(o.tolerations).length ? arr(o.tolerations) : undefined,
    affinity: o.affinity && typeof o.affinity === "object" && Object.keys(o.affinity).length ? o.affinity as Obj : undefined,
    topologySpreadConstraints: arr(o.topologySpreadConstraints).length ? arr(o.topologySpreadConstraints) : undefined,
    priorityClassName: str(o.priorityClassName) ?? undefined,
    // HN-1: 노드 네트워크·프로세스 공유 (켜진 것만)
    hostNetwork: o.hostNetwork === true ? true : undefined, hostPID: o.hostPID === true ? true : undefined, hostIPC: o.hostIPC === true ? true : undefined,
  }) as unknown as RawK8sPodSpec;
};
/** N10: 파드 템플릿 annotation 허용 키를 podSpec 에 붙인다 */
const withPodAnnotations = (spec: RawK8sPodSpec, tpl: unknown): RawK8sPodSpec => {
  const a = allowAnnotations("pod", get(tpl, "metadata", "annotations"));
  return a ? { ...spec, podAnnotations: a } : spec;
};

// N12 DRAFT(ai): 기본 API 그룹(k8s 내장). 이 밖의 네임스페이스 종류 = 앱 쪽 CRD → "있지만 안 옮김" 목록. 이미 다른 데서 읽는 CRD 는 뺀다
const BUILTIN_GROUP = /^(apps|batch|autoscaling|policy|networking\.k8s\.io|rbac\.authorization\.k8s\.io|coordination\.k8s\.io|discovery\.k8s\.io|events\.k8s\.io|storage\.k8s\.io|metrics\.k8s\.io|node\.k8s\.io|scheduling\.k8s\.io|authorization\.k8s\.io|authentication\.k8s\.io|admissionregistration\.k8s\.io|apiextensions\.k8s\.io|apiregistration\.k8s\.io|certificates\.k8s\.io|flowcontrol\.apiserver\.k8s\.io|resource\.k8s\.io|internal\.apiserver\.k8s\.io)$/;
// GW-1: Gateway API 는 라우팅으로 읽는다 (CRD 목록 아님)
const GATEWAY_API = { gateway: "gateways.gateway.networking.k8s.io", http: "httproutes.gateway.networking.k8s.io", grpc: "grpcroutes.gateway.networking.k8s.io" } as const;
// SS-V: External Secrets Operator 객체는 비밀 출처로 읽는다 (값은 없음: 원격 키 이름·store 이름만)
const ESO = { es: "externalsecrets.external-secrets.io", store: "secretstores.external-secrets.io" } as const;
// PF-A16 DRAFT(ai): 출발에서 온 이름을 kubectl 위치 인자로 넘기기 전에 k8s 이름 모양(DNS subdomain)인지 본다.
//   HTTPRoute parentRefs.name 은 CRD 검사가 길이만 보고, api-resources 는 집계 API 서버가 아무 이름이나 낼 수 있다 → "--…" 이면 kubectl 옵션으로 읽힘
export const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
export const CRD_READ_ELSEWHERE = new Set(["clusters.postgresql.cnpg.io", ...Object.values(GATEWAY_API), ...Object.values(ESO)]);

/** 실행 중 Pod 에서 컨테이너 이름이 같은 imageID 의 sha256.
 *  G3-4: 고른 파드들의 digest 가 여럿이면(롤링 중·바뀌는 태그) 가장 많은 것(같으면 글자순 앞)을 쓰고 review 에 이유를 남긴다.
 *  컨테이너 이름이 있으면 그 이름만 본다 (예전엔 안 맞으면 첫 컨테이너 digest 로 넘어가 사이드카 digest 를 쓸 수 있었다) */
function digestFromPods(pods: Obj[], containerName: string | undefined): { digest: string | null; review?: string } {
  const seen = new Map<string, number>();
  for (const p of pods) {
    const all = arr(get(p, "status", "containerStatuses"));
    const cs = containerName ? all.find((x) => x.name === containerName) : all[0];
    const m = /sha256:[a-f0-9]{64}/.exec(str(cs?.imageID) ?? "");
    if (m) seen.set(m[0], (seen.get(m[0]) ?? 0) + 1);
  }
  const ranked = [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!ranked.length) return { digest: null };
  return ranked.length > 1
    ? { digest: ranked[0]![0], review: `고른 파드의 이미지 digest 가 ${ranked.length}가지 (롤링 중이거나 바뀌는 태그) → 가장 많은 것을 씀. 사람 확인 필요` }
    : { digest: ranked[0]![0] };
}
const revisionOf = (o: Obj) => Number(str(get(o, "metadata", "annotations", "deployment.kubernetes.io/revision")) ?? NaN);
const ownedBy = (o: Obj, kind: string, name: string) => arr(get(o, "metadata", "ownerReferences")).some((r) => r.kind === kind && r.name === name);
/** G3-4 DRAFT(ai): Deployment 의 지금 판 파드. 그 Deployment 가 가진 ReplicaSet 중 revision 이 가장 큰 것의 파드만 본다
 *  (라벨만 맞추면 카나리·옛 판·다른 Deployment 파드가 섞임). ReplicaSet 을 못 읽었거나 지금 판 파드가 없으면 라벨이 맞는 파드 + review */
function currentPodsOf(dep: Obj, sel: Obj | undefined, pods: Obj[], rss: Obj[] | null): { pods: Obj[]; review?: string } {
  const byLabel = pods.filter((p) => labelsMatch(sel, get(p, "metadata", "labels") as Obj | undefined));
  if (!rss) return { pods: byLabel, ...(byLabel.length ? { review: "ReplicaSet 목록을 못 읽어 지금 판 파드를 못 가림 → 라벨이 맞는 파드의 digest. 사람 확인 필요" } : {}) };
  const mine = rss.filter((r) => ownedBy(r, "Deployment", meta(dep, "name"))).sort((a, b) => (revisionOf(b) || 0) - (revisionOf(a) || 0) || meta(a, "name").localeCompare(meta(b, "name")));
  const cur = mine[0];
  const now = cur ? byLabel.filter((p) => ownedBy(p, "ReplicaSet", meta(cur, "name"))) : [];
  if (now.length) return { pods: now };
  return { pods: byLabel, ...(byLabel.length ? { review: `지금 판 ReplicaSet${cur ? ` ${meta(cur, "name")}` : ""} 의 파드가 없음 → 라벨이 맞는 다른 파드(옛 판일 수 있음)의 digest. 사람 확인 필요` } : {}) };
}
/** G3-4: CronJob 은 가장 최근 Job(이름 끝 숫자 = 예약 시각이 가장 큰 것)의 파드만 */
function latestJobPodsOf(pods: Obj[], cron: string): Obj[] {
  const jobOf = (p: Obj) => str(get(p, "metadata", "labels", "job-name")) ?? str(arr(get(p, "metadata", "ownerReferences")).find((o) => o.kind === "Job")?.name) ?? "";
  const mine = pods.filter((p) => isCronJobPod(p, cron));
  const n = (j: string) => Number(/-(\d+)$/.exec(j)?.[1] ?? -1);
  const latest = [...new Set(mine.map(jobOf))].sort((a, b) => n(b) - n(a))[0];
  return latest === undefined ? [] : mine.filter((p) => jobOf(p) === latest);
}
/** A-1: 이 파드들이 돈 노드의 CPU 종류 (kubernetes.io/arch, 없으면 beta 라벨). 노드를 못 읽었거나 파드가 없으면 undefined */
function archOfPods(pods: Obj[], nodeArch: Map<string, string> | null): string[] | undefined {
  if (!nodeArch) return undefined;
  const out = new Set<string>();
  for (const p of pods) {
    const a = nodeArch.get(str(get(p, "spec", "nodeName")) ?? "");
    if (a) out.add(a);
  }
  return out.size ? [...out].sort() : undefined;
}
const digestOfImage = (image: string) => /@(sha256:[a-f0-9]{64})/.exec(image)?.[1] ?? null;
/** N4: 파드 템플릿 컨테이너 전부(사이드카·init)의 digest. 이미지에 digest 가 박혀 있으면 그것, 아니면 실행 중 Pod 의 containerStatuses·initContainerStatuses */
function containerDigestsOf(podSpec: unknown, pods: Obj[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const c of [...arr(get(podSpec, "containers")), ...arr(get(podSpec, "initContainers"))]) {
    const name = str(c.name);
    if (!name) continue;
    const d = digestOfImage(str(c.image) ?? "") ?? (() => {
      for (const p of pods) {
        const cs = [...arr(get(p, "status", "containerStatuses")), ...arr(get(p, "status", "initContainerStatuses"))].find((x) => x.name === name);
        const m = /sha256:[a-f0-9]{64}/.exec(str(cs?.imageID) ?? "");
        if (m) return m[0];
      }
      return null;
    })();
    if (d) out[name] = d;
  }
  return Object.keys(out).length ? out : undefined;
}
/** CronJob 이 만든 Job 의 Pod: `job-name` 라벨 또는 ownerReferences(Job) 이름이 `<크론잡>-<숫자>` */
const isCronJobPod = (p: Obj, cron: string) => {
  const re = new RegExp(`^${cron.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`);
  const lbl = str(get(p, "metadata", "labels", "job-name"));
  if (lbl && re.test(lbl)) return true;
  return arr(get(p, "metadata", "ownerReferences")).some((o) => o.kind === "Job" && re.test(str(o.name) ?? ""));
};

/**
 * 네임스페이스 하나(N9: 같은 앱 묶음이면 여럿)를 통째로 읽는다.
 * 네임스페이스 고르기: opts.namespace → IMPORT_NAMESPACE(d.env, 쉼표로 여럿) → 시스템 네임스페이스 뺀 Deployment 이름순 첫 번째의 네임스페이스.
 *   N9 DRAFT(ai): 고른(지정 안 한) 경우, 그 네임스페이스 Deployment 의 앱 묶음 라벨(app.kubernetes.io/part-of)과 같은 값을 가진
 *   Deployment 가 다른 앱 네임스페이스에 있으면 그 네임스페이스도 같이 읽는다 (예전엔 하나만 고르고 note).
 * kube = kubectl 앞 인자. Deployment·CronJob 이 하나도 없으면 SOURCE_INCOMPLETE.
 */
/** PF-A2 DRAFT(ai): kubectl 읽기 실패 중 일시 오류(API 연결 끊김·시간 초과·스로틀링)는 "못 읽음" 검토 줄이 아니라 SOURCE_TRANSIENT 로 던져 워커가 다시 가져오게 한다
 *   (RF-1 규칙과 같게. 예전: 핵심 종류는 SOURCE_INCOMPLETE 영구 실패, 나머지는 검토 줄만 늘어남) */
function throwIfTransient(e: unknown, label: string): void {
  if (e instanceof CliError && classifyCliError(e) === "transient") throw sourceFail(e, `${label} (${e.message.slice(0, 160)})`);
}

/** PF-A1: 라벨 managed-by=platform 인 네임스페이스 이름 (못 읽으면 빈 집합 + note, 일시 오류 아닌 CliError 만 삼킨다) */
async function platformNamespaces(d: CliDeps, k: string[], extra: Record<string, string>, notes: string[]): Promise<Set<string>> {
  try {
    const items = arr(get(await runJson(d, "kubectl", ["get", "namespaces", "-l", "managed-by=platform", ...k], extra), "items"));
    return new Set(items.map((o) => meta(o, "name")).filter(Boolean));
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    throwIfTransient(e, "네임스페이스 목록");
    notes.push(`네임스페이스 목록 못 읽음 (플랫폼 네임스페이스를 못 뺌): ${e.message.slice(0, 160)}`);
    return new Set();
  }
}

export async function readK8sNamespace(d: CliDeps, kube: string[], opts: K8sNamespaceOpts = {}): Promise<K8sNamespaceRead> {
  const env = d.env ?? process.env;
  const k = [...kube, "--request-timeout=15s", "-o", "json"];
  const extra = opts.extraEnv ?? {};
  const notes: string[] = [];
  const picked: RawPick[] = [];   // K-1: 자동으로 고른 네임스페이스 → 검토 줄
  const wanted = (opts.namespace || env.IMPORT_NAMESPACE || "").split(",").map((x) => x.trim()).filter(Boolean);
  const single = wanted.length === 1 ? wanted[0]! : "";

  // Deployment 목록은 필수. 네임스페이스를 하나로 정했으면 그 안만, 아니면 전체에서 고른다
  const depList = arr(get(await runJson(d, "kubectl", ["get", "deployments", ...(single ? ["-n", single] : ["-A"]), ...k], extra), "items"));
  let namespaces = wanted;
  if (!namespaces.length) {
    // PF-A1 DRAFT(ai): 우리 플랫폼이 올린 네임스페이스(라벨 managed-by=platform, 예: demo-day 의 served-by app-demo)는 고객 앱 후보에서 뺀다.
    //   예전: 이름순 첫 번째라 app-demo/served-by 가 고객 앱(real-app)보다 먼저 골라짐. 목록을 못 읽으면 빼지 않고 note. 다 빠지면 예전처럼 전부
    const cand = depList.filter((o) => !SYSTEM_NS.test(meta(o, "namespace")));
    const platformNs = new Set(cand.map((o) => meta(o, "namespace"))).size > 1 ? await platformNamespaces(d, k, extra, notes) : new Set<string>();
    const kept = cand.filter((o) => !platformNs.has(meta(o, "namespace")));
    const dropped = [...new Set(cand.filter((o) => platformNs.has(meta(o, "namespace"))).map((o) => meta(o, "namespace")))].sort();
    if (dropped.length && kept.length) notes.push(`플랫폼 네임스페이스(managed-by=platform) ${dropped.join(",")} 는 고객 앱 후보에서 뺐다`);
    const sorted = (kept.length ? kept : cand).sort((a, b) =>
      `${meta(a, "namespace")}/${meta(a, "name")}`.localeCompare(`${meta(b, "namespace")}/${meta(b, "name")}`));
    // RF-3: Deployment 가 없으면 CronJob 만 있는 네임스페이스도 고른다 (예전엔 IMPORT_NAMESPACE 없이는 "Deployment 없음"으로 멈춤)
    let first = sorted[0] ? meta(sorted[0], "namespace") : "";
    if (!first) {
      const cronNs = arr(get(await runJson(d, "kubectl", ["get", "cronjobs", "-A", ...k], extra).catch((e) => { if (e instanceof CliError) return { items: [] }; throw e; }), "items"))
        .map((o) => meta(o, "namespace")).filter((n) => n && !SYSTEM_NS.test(n)).sort();
      first = cronNs[0] ?? "";
      if (first) notes.push(`앱 Deployment 가 없어 CronJob 이 있는 네임스페이스 ${first} 를 골랐다`);
    }
    if (!first) throw incomplete("앱 Deployment·CronJob 이 없음 (시스템 네임스페이스 제외)");
    const partOf = new Set(sorted.filter((o) => meta(o, "namespace") === first).map((o) => str(get(o, "metadata", "labels", "app.kubernetes.io/part-of"))).filter((x): x is string => !!x));
    const more = [...new Set(sorted.filter((o) => meta(o, "namespace") !== first && partOf.has(str(get(o, "metadata", "labels", "app.kubernetes.io/part-of")) ?? "")).map((o) => meta(o, "namespace")))].sort();
    namespaces = [first, ...more];
    if (more.length) notes.push(`앱 묶음 라벨(part-of ${[...partOf].sort().join(",")})이 같은 네임스페이스 ${namespaces.length}개를 같이 읽었다: ${namespaces.join(",")}`);
    const nss = new Set(sorted.map((o) => meta(o, "namespace")));
    if (nss.size > namespaces.length) {
      notes.push(`네임스페이스 ${nss.size}개 중 ${namespaces.join(",")} 를 골랐다 (IMPORT_NAMESPACE 로 지정 가능, 쉼표로 여럿)`);
      picked.push(pickItem("namespace", `앱 네임스페이스 ${nss.size}개(${[...nss].sort().slice(0, 5).join(", ")}${nss.size > 5 ? " …" : ""}) 중 Deployment 이름순 첫 번째 ${namespaces.join(",")}`));   // K-1
    }
  }
  const nsSet = new Set(namespaces);

  /** 종류 하나: 실패하면 빈 목록 + note + "못 읽음" 원본 줄 (F-1: "있는데 비어 있음"과 "못 읽어서 비어 있음"을 구별). ns null = 클러스터 단위 */
  const unread: Array<{ resource: string; reason: string }> = [];
  const crdUnread = new Map<string, string>();   // PF-A15: 못 읽은 CRD 종류 → 첫 이유
  function listIn(ns: string | null, label: string, resource: string): Promise<Obj[]>;
  function listIn(ns: string | null, label: string, resource: string, orNull: true): Promise<Obj[] | null>;
  async function listIn(ns: string | null, label: string, resource: string, orNull = false): Promise<Obj[] | null> {
    try { return arr(get(await runJson(d, "kubectl", ["get", resource, ...(ns === null ? [] : ["-n", ns]), ...k], extra), "items")); }
    catch (e) {
      if (!label.startsWith("CRD ")) throwIfTransient(e, `${label} 목록`);   // 앱 CRD 객체(이름만, 안 옮김)는 집계 API 고장(503)이 흔해 재시도로 막지 않는다
      notes.push(`${label} 목록 못 읽음${namespaces.length > 1 && ns ? ` (${ns})` : ""}: ${(e as Error).message.slice(0, 160)}`);
      if (!(e instanceof CliError)) throw e;
      // PF-A15 DRAFT(ai): 못 읽은 CRD 는 한 줄로 모은다 (아래 crdUnread). 예전엔 CRD 종류 × 네임스페이스마다 검토 줄 → 큰 클러스터에서 옮기지도 않는 것을 수십 번 확인
      if (label.startsWith("CRD ")) { crdUnread.set(label.slice(4), (e as Error).message.slice(0, 120)); return orNull ? null : []; }
      unread.push({ resource: label, reason: (e as Error).message.slice(0, 160) });
      return orNull ? null : [];
    }
  }
  const listAll = async (ns: string) => {
    const [svcs, ings, hpas, crons, nps, sas, cms, pods, pvcs, pdbs, roles, rbs] = await Promise.all([
      listIn(ns, "Service", "services"), listIn(ns, "Ingress", "ingresses"), listIn(ns, "HPA", "horizontalpodautoscalers"), listIn(ns, "CronJob", "cronjobs"),
      listIn(ns, "NetworkPolicy", "networkpolicies"), listIn(ns, "ServiceAccount", "serviceaccounts"), listIn(ns, "ConfigMap", "configmaps"), listIn(ns, "Pod", "pods"),
      listIn(ns, "PersistentVolumeClaim", "persistentvolumeclaims"), listIn(ns, "PodDisruptionBudget", "poddisruptionbudgets"),
      listIn(ns, "Role", "roles"), listIn(ns, "RoleBinding", "rolebindings"),
    ]);
    // G3-4: ReplicaSet (지금 판 파드 가리기). 못 읽으면 null = 라벨로만 고르고 검토 표시
    const rss = await listIn(ns, "ReplicaSet", "replicasets", true);
    // D6: StatefulSet·DaemonSet. NS-1: 네임스페이스 객체 하나 (클러스터 범위 get). 못 읽으면 note — 라벨이 없는 것과 못 읽은 것을 가름
    const [stss, dss, jobs] = await Promise.all([listIn(ns, "StatefulSet", "statefulsets"), listIn(ns, "DaemonSet", "daemonsets"), listIn(ns, "Job", "jobs")]);   // JB-1: 일회성 Job
    let nsO: Obj | null = null;
    try { nsO = await runJson(d, "kubectl", ["get", "namespace", ns, ...k], extra) as Obj; }
    catch (e) {
      throwIfTransient(e, `Namespace ${ns}`);
      notes.push(`Namespace ${ns} 못 읽음 (라벨·annotation 안 옮겨짐, 검토 필요): ${(e as Error).message.slice(0, 160)}`);
      if (!(e instanceof CliError)) throw e;
      unread.push({ resource: "Namespace", reason: (e as Error).message.slice(0, 160) });   // F-1: 못 읽음 줄 (A 묶음 규칙과 같게)
    }
    return { svcs, ings, hpas, crons, nps, sas, cms, pods, pvcs, pdbs, roles, rbs, rss, stss, dss, jobs, nsObjs: nsO ? [nsO] : [] };
  };
  const [per, nodes] = await Promise.all([
    Promise.all(namespaces.map(async (ns) => [ns, await listAll(ns)] as const)),
    listIn(null, "Node", "nodes"),   // A-1: 노드 CPU 종류 (클러스터 단위라 -n 없음)
  ]);
  const cat = <K extends Exclude<keyof Awaited<ReturnType<typeof listAll>>, "rss">>(key: K): Obj[] => per.flatMap(([, r]) => r[key]);
  // PF-A14 DRAFT(ai): 사람이 직접 고른 네임스페이스가 플랫폼이 만든 것(managed-by=platform, demo-day 의 served-by 등)이면 검토 줄.
  //   예전: 자동 고르기에서만 뺐고(PF-A1), IMPORT_NAMESPACE·sourceScope 로 app-demo 를 잘못 주면 경고 없이 served-by 를 고객 앱으로 옮겼다
  for (const [ns, r] of per) if (r.nsObjs.some((o) => (get(o, "metadata", "labels") as Record<string, unknown> | undefined)?.["managed-by"] === "platform"))
    picked.push(pickItem("platform-namespace", `네임스페이스 ${ns} 는 이 플랫폼이 만든 것(라벨 managed-by=platform) → 옮길 고객 앱이 맞는지 확인 (출발 범위 namespaces 를 다시 볼 것)`));
  const deps = depList.filter((o) => nsSet.has(meta(o, "namespace")));
  const crons = cat("crons");
  const stss = cat("stss"), dss = cat("dss");
  // F-1 DRAFT(ai): 핵심 종류(Service·Ingress·ConfigMap)를 못 읽으면 라우팅·설정이 빈 채로 "다 읽은 것처럼" 나온다 → 가져오기를 멈춘다.
  //   나머지(HPA·CronJob·NetworkPolicy·ServiceAccount·Pod·Node 등)는 "못 읽음" 검토 줄(신뢰도 0.6)로 올리고 계속. Secret 은 원래 안 읽는다
  const CORE = new Set(["Service", "Ingress", "ConfigMap"]);
  const coreFail = unread.filter((u) => CORE.has(u.resource));
  if (coreFail.length) throw incomplete(`핵심 종류 목록을 못 읽음: ${coreFail.map((u) => `${u.resource} (${u.reason})`).join("; ")} → 관찰 역할 권한 확인`);
  // PF-C-01 DRAFT(ai): 태그만 적힌 이미지의 digest 는 실행 중 Pod 에서만 얻는다. Pod 목록을 못 읽으면 그 워크로드가 전부 unmapped 가 되어
  //   명세에 데이터 자원만 남은 채 "가져오기 성공"으로 넘어간다 → 그때는 Pod 도 핵심 종류로 보고 멈춘다 (이미지가 전부 @sha256 이면 계속)
  const podFail = unread.find((u) => u.resource === "Pod");
  const tplImages = (tpl: unknown) => arr(get(tpl, "spec", "containers")).map((c) => str(c.image) ?? "");
  const needPods = [...deps, ...stss, ...dss].flatMap((o) => tplImages(get(o, "spec", "template")))
    .concat(crons.flatMap((o) => tplImages(get(o, "spec", "jobTemplate", "spec", "template")))).some((im) => !digestOfImage(im));
  if (podFail && needPods) throw incomplete(`핵심 종류 목록을 못 읽음: Pod (${podFail.reason}) → 태그 이미지의 digest 를 못 얻어 워크로드가 전부 빠짐. 관찰 역할에 pods list 권한 확인`);
  const nodeArch = unread.some((u) => u.resource === "Node") ? null
    : new Map(nodes.map((n) => [meta(n, "name"), str(get(n, "metadata", "labels", "kubernetes.io/arch")) ?? str(get(n, "metadata", "labels", "beta.kubernetes.io/arch")) ?? ""] as const));
  if (!deps.length && !crons.length && !stss.length && !dss.length) throw incomplete(`네임스페이스 ${namespaces.join(",")} 에 Deployment·StatefulSet·DaemonSet·CronJob 이 없음`);

  const items: RawK8sItem[] = [];
  for (const o of deps) {
    const ns = meta(o, "namespace"), name = meta(o, "name"), tpl = get(o, "spec", "template");
    const spec = withPodAnnotations(podSpecOf(get(o, "spec", "template", "spec")), tpl);
    const nsRead = per.find(([n]) => n === ns)![1];
    const c0 = arr(get(o, "spec", "template", "spec", "containers"))[0];
    const sel = get(o, "spec", "selector", "matchLabels") as Obj | undefined;
    const cur = currentPodsOf(o, sel, nsRead.pods, nsRead.rss);
    let digest = digestOfImage(str(c0?.image) ?? "");
    let digestReview: string | undefined;
    if (!digest) { const f = digestFromPods(cur.pods, str(c0?.name) ?? undefined); digest = f.digest; digestReview = digest ? [cur.review, f.review].filter(Boolean).join(" / ") || undefined : undefined; }
    if (!digest) notes.push(`${ns}/${name} 의 실행 중 Pod 에서 이미지 digest 를 못 찾음 → imageDigest null`);
    if (digestReview) notes.push(`${ns}/${name} digest: ${digestReview}`);
    const cd = containerDigestsOf(get(o, "spec", "template", "spec"), cur.pods);
    const arch = archOfPods(cur.pods, nodeArch);
    items.push({
      kind: "k8s.deployment", imageDigest: digest, ...(digestReview ? { digestReview } : {}), ...(cd && Object.keys(cd).length > 1 ? { containerDigests: cd } : {}), ...(arch ? { nodeArch: arch } : {}), metadata: metaOf(o, undefined, get(o, "spec", "template")),
      spec: defined({ replicas: get(o, "spec", "replicas") as number | undefined, selector: sel ? { matchLabels: strMap(sel) } : undefined,
        template: defined({ metadata: strMap(get(o, "spec", "template", "metadata", "labels")) ? { labels: strMap(get(o, "spec", "template", "metadata", "labels")) } : undefined, spec }) }),
    } as RawK8sItem);
  }
  // D6: StatefulSet·DaemonSet — Deployment 와 같은 파드 모양 + 종류별 칸
  const podDigest = (o: Obj, name: string, label: string) => {
    const ns = meta(o, "namespace"), pods = per.find(([n]) => n === ns)?.[1].pods ?? [];
    const c0 = arr(get(o, "spec", "template", "spec", "containers"))[0];
    const sel = get(o, "spec", "selector", "matchLabels") as Obj | undefined;
    const own = pods.filter((p) => labelsMatch(sel, get(p, "metadata", "labels") as Obj | undefined));
    const dg = digestOfImage(str(c0?.image) ?? "") ?? digestFromPods(own, str(c0?.name) ?? undefined).digest;
    if (!dg) notes.push(`${ns}/${name} (${label}) 의 실행 중 Pod 에서 이미지 digest 를 못 찾음 → imageDigest null`);
    // A-1: StatefulSet·DaemonSet 도 파드가 돈 노드 CPU 종류 (Deployment 와 같은 규칙)
    const arch = archOfPods(own, nodeArch);
    return { digest: dg, sel, arch };
  };
  const tplOf = (o: Obj) => defined({ metadata: strMap(get(o, "spec", "template", "metadata", "labels")) ? { labels: strMap(get(o, "spec", "template", "metadata", "labels")) } : undefined,
    spec: podSpecOf(get(o, "spec", "template", "spec")) });
  for (const o of stss) {
    const name = meta(o, "name"), { digest, sel, arch } = podDigest(o, name, "StatefulSet");
    const vcts = arr(get(o, "spec", "volumeClaimTemplates")).map((v) => defined({
      name: meta(v, "name"), accessModes: Array.isArray(get(v, "spec", "accessModes")) ? get(v, "spec", "accessModes") as string[] : undefined,
      storage: str(get(v, "spec", "resources", "requests", "storage")) ?? undefined, storageClassName: str(get(v, "spec", "storageClassName")) ?? undefined }));
    items.push({
      kind: "k8s.statefulset", imageDigest: digest, ...(arch ? { nodeArch: arch } : {}), metadata: metaOf(o, undefined, get(o, "spec", "template")),
      spec: defined({ replicas: get(o, "spec", "replicas") as number | undefined, serviceName: str(get(o, "spec", "serviceName")) ?? undefined,
        podManagementPolicy: str(get(o, "spec", "podManagementPolicy")) ?? undefined,
        persistentVolumeClaimRetentionPolicy: pick(get(o, "spec", "persistentVolumeClaimRetentionPolicy"), ["whenDeleted", "whenScaled"]),
        selector: sel ? { matchLabels: strMap(sel) } : undefined, template: tplOf(o), volumeClaimTemplates: vcts.length ? vcts : undefined }),
    } as RawK8sItem);
  }
  for (const o of dss) {
    const name = meta(o, "name"), { digest, sel, arch } = podDigest(o, name, "DaemonSet");
    const want = get(o, "status", "desiredNumberScheduled");
    items.push({
      kind: "k8s.daemonset", imageDigest: digest, ...(arch ? { nodeArch: arch } : {}), metadata: metaOf(o, undefined, get(o, "spec", "template")),
      spec: defined({ selector: sel ? { matchLabels: strMap(sel) } : undefined, template: tplOf(o) }),
      ...(typeof want === "number" ? { status: { desiredNumberScheduled: want } } : {}),
    } as RawK8sItem);
  }
  // JB-1: CronJob 이 만든 Job 은 CronJob 쪽으로 이미 옮김 → 뺀다. 나머지(일회성)는 이름·상태 개수만
  for (const o of cat("jobs")) {
    if (arr(get(o, "metadata", "ownerReferences")).some((r) => r.kind === "CronJob")) continue;
    const n = (k: string) => { const v = get(o, "status", k); return typeof v === "number" ? v : 0; };
    items.push({ kind: "k8s.job", metadata: metaOf(o), status: { active: n("active"), succeeded: n("succeeded"), failed: n("failed") } } as RawK8sItem);
  }
  for (const nsO of cat("nsObjs")) {
    const labels = allow(get(nsO, "metadata", "labels"), NS_LABEL_KEYS), annotations = allow(get(nsO, "metadata", "annotations"), NS_ANNOTATION_KEYS);
    items.push({ kind: "k8s.namespace", metadata: defined({ name: meta(nsO, "name"), labels, annotations }) } as RawK8sItem);
  }
  for (const o of crons) {
    const ns = meta(o, "namespace"), name = meta(o, "name"), tpl = get(o, "spec", "jobTemplate", "spec", "template") as Obj | undefined;
    const pods = per.find(([n]) => n === ns)![1].pods;
    const c0 = arr(get(tpl, "spec", "containers"))[0];
    const jobPods = latestJobPodsOf(pods, name);
    let digest = digestOfImage(str(c0?.image) ?? "");
    let digestReview: string | undefined;
    if (!digest) { const f = digestFromPods(jobPods, str(c0?.name) ?? undefined); digest = f.digest; digestReview = f.review; }
    if (!digest) notes.push(`${ns}/${name} (CronJob) 의 Job Pod 에서 이미지 digest 를 못 찾음 → imageDigest null`);
    if (digestReview) notes.push(`${ns}/${name} (CronJob) digest: ${digestReview}`);
    const js = get(o, "spec", "jobTemplate", "spec") as Obj | undefined;
    const cd = containerDigestsOf(tpl?.spec, jobPods);
    const arch = archOfPods(jobPods, nodeArch);
    items.push({
      kind: "k8s.cronjob", imageDigest: digest, ...(digestReview ? { digestReview } : {}), ...(cd && Object.keys(cd).length > 1 ? { containerDigests: cd } : {}), ...(arch ? { nodeArch: arch } : {}), metadata: metaOf(o, undefined, tpl),
      spec: defined({ schedule: String(get(o, "spec", "schedule") ?? ""), timeZone: str(get(o, "spec", "timeZone")) ?? undefined,
        concurrencyPolicy: str(get(o, "spec", "concurrencyPolicy")) ?? undefined, suspend: get(o, "spec", "suspend") as boolean | undefined,
        jobTemplate: { spec: defined({ backoffLimit: js?.backoffLimit as number | undefined, activeDeadlineSeconds: js?.activeDeadlineSeconds as number | undefined,
          template: defined({ metadata: strMap(get(tpl, "metadata", "labels")) ? { labels: strMap(get(tpl, "metadata", "labels")) } : undefined, spec: withPodAnnotations(podSpecOf(tpl?.spec), tpl) }) }) } }),
    } as RawK8sItem);
  }
  for (const o of cat("svcs")) items.push({
    kind: "k8s.service", metadata: metaOf(o, "service"),
    spec: defined({ type: str(get(o, "spec", "type")) ?? undefined, selector: strMap(get(o, "spec", "selector")),
      ports: arr(get(o, "spec", "ports")).map((p) => defined({ name: str(p.name) ?? undefined, port: Number(p.port), targetPort: p.targetPort as number | string | undefined, protocol: str(p.protocol) ?? undefined,
        appProtocol: str(p.appProtocol) ?? undefined ,
        nodePort: typeof p.nodePort === "number" ? p.nodePort : undefined })),
      // V-1·NP-1: 동작 칸
      clusterIP: str(get(o, "spec", "clusterIP")) === "None" ? "None" : undefined,
      sessionAffinity: str(get(o, "spec", "sessionAffinity")) ?? undefined,
      sessionAffinityTimeoutSec: typeof get(o, "spec", "sessionAffinityConfig", "clientIP", "timeoutSeconds") === "number" ? get(o, "spec", "sessionAffinityConfig", "clientIP", "timeoutSeconds") as number : undefined,
      externalTrafficPolicy: str(get(o, "spec", "externalTrafficPolicy")) ?? undefined,
      internalTrafficPolicy: str(get(o, "spec", "internalTrafficPolicy")) ?? undefined,
      publishNotReadyAddresses: get(o, "spec", "publishNotReadyAddresses") === true ? true : undefined,
      loadBalancerSourceRanges: arr(get(o, "spec", "loadBalancerSourceRanges")).length ? (get(o, "spec", "loadBalancerSourceRanges") as string[]).map(String) : undefined,
      loadBalancerIP: str(get(o, "spec", "loadBalancerIP")) ?? undefined,
      externalName: str(get(o, "spec", "externalName")) ?? undefined }),
    ...(arr(get(o, "status", "loadBalancer", "ingress")).length
      ? { status: { loadBalancer: { ingress: arr(get(o, "status", "loadBalancer", "ingress")).map((l) => defined({ hostname: str(l.hostname) ?? undefined, ip: str(l.ip) ?? undefined })) } } } : {}),
  } as RawK8sItem);
  for (const o of cat("ings")) items.push({
    kind: "k8s.ingress", metadata: metaOf(o, "ingress"),
    spec: defined({ ingressClassName: str(get(o, "spec", "ingressClassName")) ?? undefined,
      rules: arr(get(o, "spec", "rules")).map((r) => defined({ host: str(r.host) ?? undefined, http: r.http ? { paths: arr(get(r, "http", "paths")).map((p) => defined({
        path: str(p.path) ?? undefined, pathType: str(p.pathType) ?? undefined, backend: p.backend ? backendOf(p.backend) : undefined })) } : undefined })),
      // G3-2: 기본 백엔드도 읽는다 (rules 밖 경로·호스트 없는 요청을 받던 곳. 매퍼가 그 Ingress 호스트의 마지막 "/" 줄로 옮김)
      defaultBackend: get(o, "spec", "defaultBackend") ? backendOf(get(o, "spec", "defaultBackend")) : undefined,
      tls: arr(get(o, "spec", "tls")).length ? arr(get(o, "spec", "tls")).map((t) => defined({ hosts: Array.isArray(t.hosts) ? t.hosts : undefined, secretName: str(t.secretName) ?? undefined })) : undefined }),
  } as RawK8sItem);
  for (const o of cat("hpas")) items.push({
    kind: "k8s.hpa", metadata: metaOf(o),
    spec: defined({ scaleTargetRef: pick(get(o, "spec", "scaleTargetRef"), ["kind", "name"]), minReplicas: get(o, "spec", "minReplicas") as number | undefined,
      maxReplicas: get(o, "spec", "maxReplicas") as number, metrics: Array.isArray(get(o, "spec", "metrics")) ? get(o, "spec", "metrics") as Obj[] : undefined,
      behavior: get(o, "spec", "behavior") && typeof get(o, "spec", "behavior") === "object" ? get(o, "spec", "behavior") as Obj : undefined }),   // N7
  } as RawK8sItem);
  for (const o of cat("nps")) items.push({
    kind: "k8s.networkPolicy", metadata: metaOf(o),
    spec: defined({ podSelector: get(o, "spec", "podSelector") as Obj | undefined, policyTypes: get(o, "spec", "policyTypes") as string[] | undefined,
      ingress: get(o, "spec", "ingress") as unknown[] | undefined, egress: get(o, "spec", "egress") as unknown[] | undefined }),
  } as RawK8sItem);
  for (const o of cat("sas")) {
    // I4: IRSA 역할 주소 (주석 eks.amazonaws.com/role-arn). 있을 때만 칸을 더한다 (없으면 예전 모양 그대로)
    const irsa = str(get(o, "metadata", "annotations", "eks.amazonaws.com/role-arn"));
    // WI-1: GKE Workload Identity 로 빌리는 GCP 서비스 계정 (주석 iam.gke.io/gcp-service-account)
    const gsa = str(get(o, "metadata", "annotations", "iam.gke.io/gcp-service-account"));
    items.push({ kind: "k8s.serviceAccount", metadata: metaOf(o), ...(irsa ? { irsaRoleArn: irsa } : {}), ...(gsa ? { gcpServiceAccount: gsa } : {}) } as RawK8sItem);
  }
  // N3: ConfigMap 은 data 값까지 (평문 비밀 검사·가리기는 파이프라인). binaryData 는 키 이름만
  for (const o of cat("cms")) {
    const data = strMap(get(o, "data"));
    const bin = Object.keys((get(o, "binaryData") as Obj | undefined) ?? {}).sort();
    items.push({
      kind: "k8s.configMapKeys", metadata: metaOf(o),
      keys: [...Object.keys((get(o, "data") as Obj | undefined) ?? {}), ...bin].sort(),
      ...(data ? { data } : {}), ...(bin.length ? { binaryKeys: bin } : {}),
    });
  }
  // N4: PVC 객체 (크기·접근·클래스만)
  for (const o of cat("pvcs")) items.push({
    kind: "k8s.pvc", metadata: metaOf(o),
    spec: defined({ accessModes: Array.isArray(get(o, "spec", "accessModes")) ? get(o, "spec", "accessModes") as string[] : undefined,
      storageClassName: str(get(o, "spec", "storageClassName")) ?? undefined,
      resources: str(get(o, "spec", "resources", "requests", "storage")) ? { requests: { storage: str(get(o, "spec", "resources", "requests", "storage"))! } } : undefined }),
  } as RawK8sItem);
  // N5: PodDisruptionBudget
  for (const o of cat("pdbs")) items.push({
    kind: "k8s.pdb", metadata: metaOf(o),
    // PD-1: 빈 셀렉터({}) = 네임스페이스 파드 전부 → matchLabels {} 로 남긴다 (없음과 구별). matchExpressions 가 있으면 표시
    spec: defined({ selector: get(o, "spec", "selector") && typeof get(o, "spec", "selector") === "object"
        ? defined({ matchLabels: strMap(get(o, "spec", "selector", "matchLabels")) ?? {}, hasExpressions: arr(get(o, "spec", "selector", "matchExpressions")).length ? true : undefined }) : undefined,
      minAvailable: get(o, "spec", "minAvailable") as number | string | undefined, maxUnavailable: get(o, "spec", "maxUnavailable") as number | string | undefined,
      unhealthyPodEvictionPolicy: str(get(o, "spec", "unhealthyPodEvictionPolicy")) ?? undefined }),
  } as RawK8sItem);
  // T3: Role·RoleBinding 원문
  for (const o of cat("roles")) items.push({ kind: "k8s.role", metadata: metaOf(o), rules: arr(get(o, "rules")) } as RawK8sItem);
  const bindingOf = (o: Obj, kind: "k8s.roleBinding" | "k8s.clusterRoleBinding") => ({
    kind, metadata: metaOf(o),
    roleRef: { kind: String(get(o, "roleRef", "kind") ?? ""), name: String(get(o, "roleRef", "name") ?? "") },
    subjects: arr(get(o, "subjects")).map((x) => defined({ kind: String(x.kind), name: String(x.name), namespace: str(x.namespace) ?? undefined })),
  } as RawK8sItem);
  for (const o of cat("rbs")) items.push(bindingOf(o, "k8s.roleBinding"));
  // T3: 클러스터 단위 바인딩 중 이 네임스페이스 SA 를 가리키는 것만 (도착은 사람 확인). 못 읽으면 note (관찰 역할에 RBAC 읽기가 없을 수 있음, O-2)
  try {
    const crbs = arr(get(await runJson(d, "kubectl", ["get", "clusterrolebindings", ...k], extra), "items"));
    for (const o of crbs) if (arr(get(o, "subjects")).some((x) => x.kind === "ServiceAccount" && nsSet.has(str(x.namespace) ?? ""))) items.push(bindingOf(o, "k8s.clusterRoleBinding"));
  } catch (e) {
    throwIfTransient(e, "ClusterRoleBinding 목록");
    notes.push(`ClusterRoleBinding 목록 못 읽음: ${(e as Error).message.slice(0, 160)}`);
    if (!(e instanceof CliError)) throw e;
    unread.push({ resource: "ClusterRoleBinding", reason: (e as Error).message.slice(0, 160) });   // PF-A3: 못 읽음 ≠ 없음
  }
  // N12: 앱 쪽 CRD 객체 (이름만, 안 옮김). 종류 목록을 못 읽으면 note
  let gatewayKinds = new Set<string>();
  try {
    const all = String(await runText(d, "kubectl", ["api-resources", "--namespaced=true", "--verbs=list", "-o", "name", ...kube, "--request-timeout=15s"], extra)).split(/\s+/);
    gatewayKinds = new Set(all.filter((x) => (Object.values(GATEWAY_API) as string[]).includes(x)));
    const names = all.filter((x) => K8S_NAME.test(x) && x.includes(".") && !BUILTIN_GROUP.test(x.slice(x.indexOf(".") + 1)) && !CRD_READ_ELSEWHERE.has(x)).sort();   // PF-A16
    for (const r of names) for (const ns of namespaces) {
      for (const o of await listIn(ns, `CRD ${r}`, r)) items.push({ kind: "k8s.crdObject", metadata: metaOf(o), resource: r } as RawK8sItem);
    }
    // SS-V: ExternalSecret·SecretStore (원격 키 이름·store 이름·provider 종류만. 인증 칸(auth)·값은 안 담음)
    for (const ns of namespaces) {
      if (all.includes(ESO.es)) for (const o of await listIn(ns, "ExternalSecret", ESO.es)) items.push({ kind: "k8s.externalSecret", metadata: metaOf(o),
        spec: defined({ store: defined({ kind: str(get(o, "spec", "secretStoreRef", "kind")) ?? "SecretStore", name: String(get(o, "spec", "secretStoreRef", "name") ?? "") }),
          target: str(get(o, "spec", "target", "name")) ?? meta(o, "name"),
          data: arr(get(o, "spec", "data")).map((x) => defined({ key: String(x.secretKey ?? ""), remote: String(get(x, "remoteRef", "key") ?? ""), property: str(get(x, "remoteRef", "property")) ?? undefined })),
          dataFrom: arr(get(o, "spec", "dataFrom")).map((x) => String(get(x, "extract", "key") ?? get(x, "find", "name", "regexp") ?? "")).filter(Boolean) }) } as RawK8sItem);
      if (all.includes(ESO.store)) for (const o of await listIn(ns, "SecretStore", ESO.store)) items.push({ kind: "k8s.secretStore", metadata: metaOf(o),
        provider: Object.keys((get(o, "spec", "provider") as Obj | undefined) ?? {}).sort()[0] ?? "unknown" } as RawK8sItem);
    }
    // GW-1: Gateway API 라우트·Gateway. 라우트가 다른 네임스페이스 Gateway(공용 입구)를 가리키면 그 Gateway 만 따로 읽는다
    const seenGw = new Set<string>();
    const pushGw = (o: Obj) => {
      const key = `${meta(o, "namespace")}/${meta(o, "name")}`;
      if (seenGw.has(key)) return;
      seenGw.add(key);
      items.push({ kind: "k8s.gateway", metadata: metaOf(o), spec: defined({ gatewayClassName: str(get(o, "spec", "gatewayClassName")) ?? undefined,
        listeners: arr(get(o, "spec", "listeners")).map((l) => defined({ name: String(l.name), hostname: str(l.hostname) ?? undefined, port: typeof l.port === "number" ? l.port : undefined,
          protocol: str(l.protocol) ?? undefined, tls: l.tls && typeof l.tls === "object" ? defined({ mode: str(get(l, "tls", "mode")) ?? undefined,
            certificateRefs: arr(get(l, "tls", "certificateRefs")).map((c) => defined({ name: String(c.name), kind: str(c.kind) ?? undefined, namespace: str(c.namespace) ?? undefined })) }) : undefined })) }) } as RawK8sItem);
    };
    const routeOf = (o: Obj, kind: "k8s.httpRoute" | "k8s.grpcRoute") => items.push({ kind, metadata: metaOf(o),
      spec: defined({ parentRefs: Array.isArray(get(o, "spec", "parentRefs")) ? get(o, "spec", "parentRefs") as Obj[] : undefined,
        hostnames: Array.isArray(get(o, "spec", "hostnames")) ? get(o, "spec", "hostnames") as string[] : undefined,
        rules: Array.isArray(get(o, "spec", "rules")) ? get(o, "spec", "rules") as Obj[] : undefined }) } as RawK8sItem);
    const parents: Array<{ ns: string; name: string }> = [];
    for (const ns of namespaces) {
      if (gatewayKinds.has(GATEWAY_API.gateway)) for (const o of await listIn(ns, "Gateway", GATEWAY_API.gateway)) pushGw(o);
      for (const [res, kind] of [[GATEWAY_API.http, "k8s.httpRoute"], [GATEWAY_API.grpc, "k8s.grpcRoute"]] as const) {
        if (!gatewayKinds.has(res)) continue;
        for (const o of await listIn(ns, kind === "k8s.httpRoute" ? "HTTPRoute" : "GRPCRoute", res)) {
          routeOf(o, kind);
          for (const p of arr(get(o, "spec", "parentRefs"))) if ((str(p.kind) ?? "Gateway") === "Gateway" && str(p.name)) parents.push({ ns: str(p.namespace) ?? ns, name: str(p.name)! });
        }
      }
    }
    for (const p of parents.sort((a, b) => `${a.ns}/${a.name}`.localeCompare(`${b.ns}/${b.name}`))) {
      if (nsSet.has(p.ns) || seenGw.has(`${p.ns}/${p.name}`)) continue;
      if (!K8S_NAME.test(p.name) || !K8S_NAME.test(p.ns)) {   // PF-A16: 옵션처럼 생긴 이름은 kubectl 에 안 넘긴다
        notes.push(`라우트가 가리키는 Gateway 이름 모양이 k8s 이름이 아님 → 안 읽음: ${JSON.stringify(`${p.ns}/${p.name}`).slice(0, 80)}`);
        unread.push({ resource: "Gateway", reason: `라우트 parentRefs 의 Gateway 이름 모양이 틀림 → 안 읽음 (${JSON.stringify(`${p.ns}/${p.name}`).slice(0, 80)})` });
        continue;
      }
      try { pushGw(await runJson(d, "kubectl", ["get", GATEWAY_API.gateway, p.name, "-n", p.ns, ...k], extra) as Obj); }
      catch (e) {
        throwIfTransient(e, `Gateway ${p.ns}/${p.name}`);
        notes.push(`Gateway ${p.ns}/${p.name} 못 읽음 (라우트가 가리키는 공용 입구): ${(e as Error).message.slice(0, 160)}`);
        if (!(e instanceof CliError)) throw e;
        unread.push({ resource: `Gateway ${p.ns}/${p.name}`, reason: (e as Error).message.slice(0, 160) });   // PF-A3
      }
    }
  } catch (e) {
    throwIfTransient(e, "API 종류 목록");
    notes.push(`CRD 종류 목록 못 읽음: ${(e as Error).message.slice(0, 160)}`);
    if (!(e instanceof CliError)) throw e;
    // PF-A3 DRAFT(ai): 종류 목록을 못 읽으면 ExternalSecret·SecretStore·Gateway API 라우트·앱 CRD 를 하나도 못 본다 → 조용히 "없음"이 아니라 검토 줄
    unread.push({ resource: "APIResources", reason: `ExternalSecret·Gateway 라우트·CRD 를 못 봄: ${(e as Error).message.slice(0, 120)}` });
  }

  if (crdUnread.size) {
    const names = [...crdUnread.keys()].sort();
    unread.push({ resource: "CRD", reason: `CRD ${names.length}종 객체 목록 못 읽음(이름만 읽고 옮기지 않는 것): ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` 외 ${names.length - 8}` : ""} — ${crdUnread.get(names[0]!)}` });
  }
  for (const u of unread) items.push({ kind: "k8s.unread", resource: u.resource, reason: u.reason });

  const counts: Record<string, number> = {};
  for (const i of items) if (i.kind !== "k8s.unread") counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  items.push(...(picked as unknown as RawK8sItem[]));
  counts["k8s.pod"] = cat("pods").length;
  return { items, namespace: namespaces[0]!, ...(namespaces.length > 1 ? { namespaces } : {}), counts, notes };
}
