import { arr, get, incomplete, runJson, str, type CliDeps } from "../common/cli.js";
import type { K8sDeployment } from "../common/normalize.js";

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
