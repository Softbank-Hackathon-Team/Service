import { arr, CliError, get, incomplete, runJson, str, type CliDeps } from "../common/cli.js";
import type { K8sDeployment } from "../common/normalize.js";
import type { RawK8sContainer, RawK8sItem, RawK8sMeta, RawK8sPodSpec } from "../import/raw-k8s.js";

// Z88: 쿠버네티스(EKS·GKE·k3s 공통) 앱 하나 읽기 → normalize 가 아는 k8s.deployment 모양.
// 읽는 것: deployments·services·ingresses·pods (전부 get -o json). 비밀값은 안 읽는다(secretKeyRef 이름만, Secret 객체는 안 봄)

const SYSTEM_NS = /^(kube-|cnpg-system$|cert-manager$|argocd$|external-secrets$|ingress-nginx$|monitoring$|gmp-|gke-)/;
type Obj = Record<string, unknown>;

const meta = (o: Obj, k: "name" | "namespace") => str(get(o, "metadata", k)) ?? "";
const labelsMatch = (sel: Obj | undefined, labels: Obj | undefined) =>
  !!sel && Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels?.[k] === v);

export interface K8sRead {
  item: K8sDeployment;
  namespace: string;
  counts: Record<string, number>;   // 읽은 종류별 개수 (coverage)
  notes: string[];                  // 사람이 봐야 할 것 (고른 이유·빠진 것)
}

/** kube = kubectl 앞 인자 (["--context", x] 또는 ["--kubeconfig", 임시파일]) */
export async function readK8sApp(d: CliDeps, kube: string[], extraEnv: Record<string, string> = {}): Promise<K8sRead> {
  const env = d.env ?? process.env;
  const k = [...kube, "--request-timeout=15s", "-o", "json"];
  const [list, pods] = await Promise.all([
    runJson(d, "kubectl", ["get", "deployments,services,ingresses", "-A", ...k], extraEnv),
    runJson(d, "kubectl", ["get", "pods", "-A", ...k], extraEnv),
  ]);
  const all = arr(get(list, "items"));
  const nsWanted = env.IMPORT_NAMESPACE;
  const inScope = (o: Obj) => nsWanted ? meta(o, "namespace") === nsWanted : !SYSTEM_NS.test(meta(o, "namespace"));
  const deps = all.filter((o) => o.kind === "Deployment" && inScope(o)).sort((a, b) =>
    `${meta(a, "namespace")}/${meta(a, "name")}`.localeCompare(`${meta(b, "namespace")}/${meta(b, "name")}`));
  const svcs = all.filter((o) => o.kind === "Service");
  const ings = all.filter((o) => o.kind === "Ingress");
  const podList = arr(get(pods, "items"));
  const notes: string[] = [];

  const want = env.IMPORT_APP;
  const d0 = want ? deps.find((x) => meta(x, "name") === want) : deps[0];
  if (!d0) throw incomplete(want ? `Deployment ${want} 없음${nsWanted ? ` (네임스페이스 ${nsWanted})` : ""}`
    : `앱 Deployment 가 없음${nsWanted ? ` (네임스페이스 ${nsWanted})` : " (시스템 네임스페이스 제외)"}`);
  if (!want && deps.length > 1) notes.push(`Deployment ${deps.length}개 중 ${meta(d0, "namespace")}/${meta(d0, "name")} 를 골랐다 (IMPORT_APP 로 지정 가능)`);
  const ns = meta(d0, "namespace"), name = meta(d0, "name");

  const c = arr(get(d0, "spec", "template", "spec", "containers"))[0];
  if (!c) throw incomplete(`${ns}/${name} 에 컨테이너 없음`);
  const podLabels = get(d0, "spec", "template", "metadata", "labels") as Obj | undefined;
  const svc = svcs.find((s) => meta(s, "namespace") === ns && labelsMatch(get(s, "spec", "selector") as Obj | undefined, podLabels));

  // 포트: 컨테이너에 적힌 것 → 없으면 서비스 targetPort(숫자)
  let ports = arr(c.ports).map((p) => Number(p.containerPort)).filter((n) => n > 0);
  if (!ports.length) {
    const tp = arr(get(svc, "spec", "ports")).map((p) => Number(p.targetPort ?? p.port)).filter((n) => n > 0);
    if (tp.length) { ports = tp; notes.push(`컨테이너에 포트가 없어 서비스 targetPort ${tp[0]} 를 썼다`); }
  }
  if (!ports.length) throw incomplete(`${ns}/${name} 의 포트를 모름 (컨테이너 ports·서비스 둘 다 없음)`);

  // 이미지 digest: 실행 중 Pod 의 imageID (태그는 바뀔 수 있어 digest 로 고정)
  const image = str(c.image) ?? "";
  let digest = image.includes("@sha256:") ? image.slice(image.indexOf("@") + 1) : undefined;
  if (!digest) {
    const sel = get(d0, "spec", "selector", "matchLabels") as Obj | undefined;
    for (const p of podList) {
      if (meta(p, "namespace") !== ns || !labelsMatch(sel, get(p, "metadata", "labels") as Obj | undefined)) continue;
      const cs = arr(get(p, "status", "containerStatuses")).find((x) => x.name === c.name);
      const m = /sha256:[a-f0-9]{64}/.exec(str(cs?.imageID) ?? "");
      if (m) { digest = m[0]; break; }
    }
  }
  if (!digest) throw incomplete(`${ns}/${name} 의 실행 중 Pod 가 없어 이미지 digest 를 모름 (태그 ${image})`);

  // 호스트 이름: Ingress 규칙(이 서비스로 가는 것) → LoadBalancer 주소 → 클러스터 안 이름
  let hostname = "";
  if (svc) {
    const sname = meta(svc, "name");
    for (const ing of ings.filter((i) => meta(i, "namespace") === ns))
      for (const r of arr(get(ing, "spec", "rules")))
        if (!hostname && arr(get(r, "http", "paths")).some((p) => get(p, "backend", "service", "name") === sname)) hostname = str(r.host) ?? "";
    const lb = arr(get(svc, "status", "loadBalancer", "ingress"))[0];
    if (!hostname && lb) hostname = str(lb.hostname) ?? str(lb.ip) ?? "";
    if (!hostname) { hostname = `${sname}.${ns}.svc.cluster.local`; notes.push("Ingress·LB 주소가 없어 클러스터 안 이름을 썼다 (검토 필요)"); }
  } else {
    hostname = `${name}.${ns}.svc.cluster.local`;
    notes.push(`${ns}/${name} 를 고르는 Service 없음 → 클러스터 안 이름을 썼다 (검토 필요)`);
  }

  const env0 = arr(c.env).map((e) => {
    const ref = get(e, "valueFrom", "secretKeyRef") as Obj | undefined;
    if (ref) return { name: String(e.name), valueFrom: { secretKeyRef: { name: String(ref.name), key: String(ref.key) } } };
    if (typeof e.value === "string") return { name: String(e.name), value: e.value };
    return null;   // configMapKeyRef·fieldRef 는 명세에 칸이 없다
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  const skipped = arr(c.env).length - env0.length;
  if (skipped) notes.push(`환경변수 ${skipped}개(configMap·fieldRef 참조)는 명세 칸이 없어 뺐다`);

  const req = get(c, "resources", "requests") as Obj | undefined;
  const item: K8sDeployment = {
    kind: "k8s.deployment", imageDigest: digest, hostname,
    metadata: { name, namespace: ns },
    spec: {
      replicas: Number(get(d0, "spec", "replicas") ?? 1),
      template: { spec: { containers: [{
        image, ports: ports.map((containerPort) => ({ containerPort })),
        resources: req ? { requests: { cpu: str(req.cpu) ?? undefined, memory: str(req.memory) ?? undefined } } : undefined,
        readinessProbe: str(get(c, "readinessProbe", "httpGet", "path")) ? { httpGet: { path: str(get(c, "readinessProbe", "httpGet", "path"))! } } : undefined,
        env: env0,
      }] } },
    },
  };
  return {
    item, namespace: ns, notes,
    counts: {
      "k8s.deployment": deps.length,
      "k8s.service": svcs.filter(inScope).length,
      "k8s.ingress": ings.filter(inScope).length,
      "k8s.pod": podList.filter(inScope).length,
    },
  };
}

// ── I2: 네임스페이스 전체 읽기 (공통 명세 v2 의 재료) ──────────────────────────────
// readK8sApp 은 그대로 둔다(앱 Deployment 하나 → v1 모양). 아래는 같은 네임스페이스의 모든 워크로드·연결 재료를 kube 원문에 가깝게 읽는다.
// 종류별로 kubectl 을 따로 부른다 → 하나가 403 이어도 나머지는 계속, 실패는 notes 에 남는다. Deployment 목록만 못 읽으면 멈춘다(CliError).
// 허용 목록 방식: metadata.annotations·Pod 항목·Secret 객체는 안 읽고, ConfigMap 은 키 이름만 남긴다.

export interface K8sNamespaceOpts { namespace?: string; extraEnv?: Record<string, string> }
export interface K8sNamespaceRead {
  items: RawK8sItem[];
  namespace: string;
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
const metaOf = (o: Obj): RawK8sMeta => defined({ name: meta(o, "name"), namespace: meta(o, "namespace") || undefined, labels: strMap(get(o, "metadata", "labels")) });
const pick = (o: unknown, keys: string[]): Obj | undefined => {
  if (!o || typeof o !== "object") return undefined;
  const out: Obj = {};
  for (const k of keys) if ((o as Obj)[k] !== undefined) out[k] = (o as Obj)[k];
  return Object.keys(out).length ? out : undefined;
};
const probeOf = (p: unknown) => {
  if (!p || typeof p !== "object") return undefined;
  const o = p as Obj;
  return defined({
    httpGet: pick(o.httpGet, ["path", "port", "scheme"]), tcpSocket: pick(o.tcpSocket, ["port"]),
    grpc: pick(o.grpc, ["port", "service"]), exec: pick(o.exec, ["command"]),
    initialDelaySeconds: o.initialDelaySeconds, periodSeconds: o.periodSeconds, timeoutSeconds: o.timeoutSeconds,
    successThreshold: o.successThreshold, failureThreshold: o.failureThreshold,
  } as Obj);
};
const envOf = (e: Obj) => {
  const vf = get(e, "valueFrom") as Obj | undefined;
  return defined({
    name: String(e.name), value: typeof e.value === "string" ? e.value : undefined,
    valueFrom: vf ? defined({ secretKeyRef: pick(vf.secretKeyRef, ["name", "key"]), configMapKeyRef: pick(vf.configMapKeyRef, ["name", "key"]),
      fieldRef: pick(vf.fieldRef, ["fieldPath"]), resourceFieldRef: pick(vf.resourceFieldRef, ["resource", "containerName"]) }) : undefined,
  } as Obj);
};
const containerOf = (c: Obj): RawK8sContainer => defined({
  name: str(c.name) ?? undefined, image: str(c.image) ?? "",
  command: Array.isArray(c.command) ? c.command : undefined, args: Array.isArray(c.args) ? c.args : undefined,
  ports: arr(c.ports).length ? arr(c.ports).map((p) => defined({ name: str(p.name) ?? undefined, containerPort: Number(p.containerPort), protocol: str(p.protocol) ?? undefined })) : undefined,
  env: arr(c.env).length ? arr(c.env).map(envOf) : undefined,
  envFrom: arr(c.envFrom).length ? arr(c.envFrom).map((f) => defined({ configMapRef: pick(f.configMapRef, ["name"]), secretRef: pick(f.secretRef, ["name"]), prefix: str(f.prefix) ?? undefined })) : undefined,
  resources: pick(c.resources, ["requests", "limits"]),
  readinessProbe: probeOf(c.readinessProbe), livenessProbe: probeOf(c.livenessProbe), startupProbe: probeOf(c.startupProbe),
  securityContext: (c.securityContext && typeof c.securityContext === "object") ? c.securityContext as Obj : undefined,
} as Obj) as unknown as RawK8sContainer;
const podSpecOf = (s: unknown): RawK8sPodSpec => {
  const o = (s ?? {}) as Obj;
  return defined({
    serviceAccountName: str(o.serviceAccountName) ?? undefined, restartPolicy: str(o.restartPolicy) ?? undefined,
    initContainers: arr(o.initContainers).length ? arr(o.initContainers).map(containerOf) : undefined,
    containers: arr(o.containers).map(containerOf),
  }) as unknown as RawK8sPodSpec;
};

/** 실행 중 Pod 에서 컨테이너 이름이 같은 imageID 의 sha256 */
function digestFromPods(pods: Obj[], containerName: string | undefined): string | null {
  for (const p of pods) {
    const cs = arr(get(p, "status", "containerStatuses")).find((x) => !containerName || x.name === containerName) ?? arr(get(p, "status", "containerStatuses"))[0];
    const m = /sha256:[a-f0-9]{64}/.exec(str(cs?.imageID) ?? "");
    if (m) return m[0];
  }
  return null;
}
const digestOfImage = (image: string) => /@(sha256:[a-f0-9]{64})/.exec(image)?.[1] ?? null;
/** CronJob 이 만든 Job 의 Pod: `job-name` 라벨 또는 ownerReferences(Job) 이름이 `<크론잡>-<숫자>` */
const isCronJobPod = (p: Obj, cron: string) => {
  const re = new RegExp(`^${cron.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`);
  const lbl = str(get(p, "metadata", "labels", "job-name"));
  if (lbl && re.test(lbl)) return true;
  return arr(get(p, "metadata", "ownerReferences")).some((o) => o.kind === "Job" && re.test(str(o.name) ?? ""));
};

/**
 * 네임스페이스 하나를 통째로 읽는다.
 * 네임스페이스 고르기: opts.namespace → IMPORT_NAMESPACE(d.env) → 시스템 네임스페이스 뺀 Deployment 이름순 첫 번째의 네임스페이스.
 * kube = kubectl 앞 인자. Deployment·CronJob 이 하나도 없으면 SOURCE_INCOMPLETE.
 */
export async function readK8sNamespace(d: CliDeps, kube: string[], opts: K8sNamespaceOpts = {}): Promise<K8sNamespaceRead> {
  const env = d.env ?? process.env;
  const k = [...kube, "--request-timeout=15s", "-o", "json"];
  const extra = opts.extraEnv ?? {};
  const notes: string[] = [];
  let ns = opts.namespace || env.IMPORT_NAMESPACE || "";

  // Deployment 목록은 필수. 네임스페이스를 모르면 전체에서 고른다
  const depList = arr(get(await runJson(d, "kubectl", ["get", "deployments", ...(ns ? ["-n", ns] : ["-A"]), ...k], extra), "items"));
  if (!ns) {
    const sorted = depList.filter((o) => !SYSTEM_NS.test(meta(o, "namespace"))).sort((a, b) =>
      `${meta(a, "namespace")}/${meta(a, "name")}`.localeCompare(`${meta(b, "namespace")}/${meta(b, "name")}`));
    if (!sorted[0]) throw incomplete("앱 Deployment 가 없음 (시스템 네임스페이스 제외)");
    ns = meta(sorted[0], "namespace");
    const nss = new Set(sorted.map((o) => meta(o, "namespace")));
    if (nss.size > 1) notes.push(`네임스페이스 ${nss.size}개 중 ${ns} 를 골랐다 (IMPORT_NAMESPACE 로 지정 가능)`);
  }
  const deps = depList.filter((o) => meta(o, "namespace") === ns);

  /** 종류 하나: 실패하면 빈 목록 + note */
  const list = async (label: string, resource: string): Promise<Obj[]> => {
    try { return arr(get(await runJson(d, "kubectl", ["get", resource, "-n", ns, ...k], extra), "items")); }
    catch (e) {
      notes.push(`${label} 목록 못 읽음: ${(e as Error).message.slice(0, 160)}`);
      if (!(e instanceof CliError)) throw e;
      return [];
    }
  };
  const [svcs, ings, hpas, crons, nps, sas, cms, pods] = await Promise.all([
    list("Service", "services"), list("Ingress", "ingresses"), list("HPA", "horizontalpodautoscalers"), list("CronJob", "cronjobs"),
    list("NetworkPolicy", "networkpolicies"), list("ServiceAccount", "serviceaccounts"), list("ConfigMap", "configmaps"), list("Pod", "pods"),
  ]);
  if (!deps.length && !crons.length) throw incomplete(`네임스페이스 ${ns} 에 Deployment·CronJob 이 없음`);

  const items: RawK8sItem[] = [];
  for (const o of deps) {
    const name = meta(o, "name"), spec = podSpecOf(get(o, "spec", "template", "spec"));
    const c0 = arr(get(o, "spec", "template", "spec", "containers"))[0];
    const sel = get(o, "spec", "selector", "matchLabels") as Obj | undefined;
    let digest = digestOfImage(str(c0?.image) ?? "");
    if (!digest) digest = digestFromPods(pods.filter((p) => labelsMatch(sel, get(p, "metadata", "labels") as Obj | undefined)), str(c0?.name) ?? undefined);
    if (!digest) notes.push(`${ns}/${name} 의 실행 중 Pod 에서 이미지 digest 를 못 찾음 → imageDigest null`);
    items.push({
      kind: "k8s.deployment", imageDigest: digest, metadata: metaOf(o),
      spec: defined({ replicas: get(o, "spec", "replicas") as number | undefined, selector: sel ? { matchLabels: strMap(sel) } : undefined,
        template: defined({ metadata: strMap(get(o, "spec", "template", "metadata", "labels")) ? { labels: strMap(get(o, "spec", "template", "metadata", "labels")) } : undefined, spec }) }),
    } as RawK8sItem);
  }
  for (const o of crons) {
    const name = meta(o, "name"), tpl = get(o, "spec", "jobTemplate", "spec", "template") as Obj | undefined;
    const c0 = arr(get(tpl, "spec", "containers"))[0];
    let digest = digestOfImage(str(c0?.image) ?? "");
    if (!digest) digest = digestFromPods(pods.filter((p) => isCronJobPod(p, name)), str(c0?.name) ?? undefined);
    if (!digest) notes.push(`${ns}/${name} (CronJob) 의 Job Pod 에서 이미지 digest 를 못 찾음 → imageDigest null`);
    const js = get(o, "spec", "jobTemplate", "spec") as Obj | undefined;
    items.push({
      kind: "k8s.cronjob", imageDigest: digest, metadata: metaOf(o),
      spec: defined({ schedule: String(get(o, "spec", "schedule") ?? ""), timeZone: str(get(o, "spec", "timeZone")) ?? undefined,
        concurrencyPolicy: str(get(o, "spec", "concurrencyPolicy")) ?? undefined, suspend: get(o, "spec", "suspend") as boolean | undefined,
        jobTemplate: { spec: defined({ backoffLimit: js?.backoffLimit as number | undefined, activeDeadlineSeconds: js?.activeDeadlineSeconds as number | undefined,
          template: defined({ metadata: strMap(get(tpl, "metadata", "labels")) ? { labels: strMap(get(tpl, "metadata", "labels")) } : undefined, spec: podSpecOf(tpl?.spec) }) }) } }),
    } as RawK8sItem);
  }
  for (const o of svcs) items.push({
    kind: "k8s.service", metadata: metaOf(o),
    spec: defined({ type: str(get(o, "spec", "type")) ?? undefined, selector: strMap(get(o, "spec", "selector")),
      ports: arr(get(o, "spec", "ports")).map((p) => defined({ name: str(p.name) ?? undefined, port: Number(p.port), targetPort: p.targetPort as number | string | undefined, protocol: str(p.protocol) ?? undefined })) }),
    ...(arr(get(o, "status", "loadBalancer", "ingress")).length
      ? { status: { loadBalancer: { ingress: arr(get(o, "status", "loadBalancer", "ingress")).map((l) => defined({ hostname: str(l.hostname) ?? undefined, ip: str(l.ip) ?? undefined })) } } } : {}),
  } as RawK8sItem);
  for (const o of ings) items.push({
    kind: "k8s.ingress", metadata: metaOf(o),
    spec: defined({ ingressClassName: str(get(o, "spec", "ingressClassName")) ?? undefined,
      rules: arr(get(o, "spec", "rules")).map((r) => defined({ host: str(r.host) ?? undefined, http: r.http ? { paths: arr(get(r, "http", "paths")).map((p) => defined({
        path: str(p.path) ?? undefined, pathType: str(p.pathType) ?? undefined, backend: p.backend ? { service: pick(get(p, "backend", "service"), ["name", "port"]) } : undefined })) } : undefined })),
      tls: arr(get(o, "spec", "tls")).length ? arr(get(o, "spec", "tls")).map((t) => defined({ hosts: Array.isArray(t.hosts) ? t.hosts : undefined, secretName: str(t.secretName) ?? undefined })) : undefined }),
  } as RawK8sItem);
  for (const o of hpas) items.push({
    kind: "k8s.hpa", metadata: metaOf(o),
    spec: defined({ scaleTargetRef: pick(get(o, "spec", "scaleTargetRef"), ["kind", "name"]), minReplicas: get(o, "spec", "minReplicas") as number | undefined,
      maxReplicas: get(o, "spec", "maxReplicas") as number, metrics: Array.isArray(get(o, "spec", "metrics")) ? get(o, "spec", "metrics") as Obj[] : undefined }),
  } as RawK8sItem);
  for (const o of nps) items.push({
    kind: "k8s.networkPolicy", metadata: metaOf(o),
    spec: defined({ podSelector: get(o, "spec", "podSelector") as Obj | undefined, policyTypes: get(o, "spec", "policyTypes") as string[] | undefined,
      ingress: get(o, "spec", "ingress") as unknown[] | undefined, egress: get(o, "spec", "egress") as unknown[] | undefined }),
  } as RawK8sItem);
  for (const o of sas) items.push({ kind: "k8s.serviceAccount", metadata: metaOf(o) });
  for (const o of cms) items.push({
    kind: "k8s.configMapKeys", metadata: metaOf(o),
    keys: [...Object.keys((get(o, "data") as Obj | undefined) ?? {}), ...Object.keys((get(o, "binaryData") as Obj | undefined) ?? {})].sort(),
  });

  const counts: Record<string, number> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  counts["k8s.pod"] = pods.length;
  return { items, namespace: ns, counts, notes };
}
