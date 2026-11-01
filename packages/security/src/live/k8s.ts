import { readJson, type ExecRunner, type Json } from "./exec.js";
import { secretKindOf, SECRET_ENV_NAME } from "../secret-patterns.js";
import { check, type LiveCheck, type LiveCheckKey } from "./types.js";

// Z91: 앱 네임스페이스 실제 점검 (kubectl get -o json = k8s API 읽기). 클러스터마다 kubeconfig 컨텍스트를 환경 변수로 받는다.
// 값은 절대 돌려주지 않는다: 비밀값이 보이면 "어느 Pod·컨테이너·env 이름"만

export interface K8sFacts { context: string; namespace: string }
const arr = <T = Json>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const items = (j: unknown) => arr(obj(j).items);
const nameOf = (x: Json) => String(obj(x.metadata).name ?? "?");

export function analyzeServices(svcs: unknown[], src: string): LiveCheck {
  const lb = svcs.map(obj).filter((s) => obj(s.spec).type === "LoadBalancer");
  const np = svcs.map(obj).filter((s) => obj(s.spec).type === "NodePort");
  const lbOpen = lb.filter((s) => arr(obj(s.spec).loadBalancerSourceRanges).length === 0);
  return check("public_ports.services", lbOpen.length ? "fail" : lb.length || np.length ? "warn" : "pass", `Service ${svcs.length}개`,
    lbOpen.length ? `출발지 제한 없는 LoadBalancer ${lbOpen.map(nameOf).join(", ")}`
      : lb.length || np.length ? `LoadBalancer ${lb.length}(출발지 제한) · NodePort ${np.map(nameOf).join(", ") || 0}` : "LoadBalancer·NodePort 0 (진입은 cloudflared 터널만)", src);
}

export function analyzeIngress(ings: unknown[], pods: unknown[], src: string): LiveCheck {
  const noTls = ings.map(obj).filter((i) => arr(obj(i.spec).tls).length === 0);
  const tunnel = pods.map(obj).some((p) => arr(obj(p.spec).containers).some((c) => /cloudflared/.test(String(c.image ?? ""))));
  return check("tls.ingress", noTls.length ? "fail" : ings.length || tunnel ? "pass" : "n_a", `Ingress ${ings.length}개`,
    noTls.length ? `TLS 없는 Ingress ${noTls.map(nameOf).join(", ")}`
      : ings.length ? `Ingress 전부 spec.tls 있음${tunnel ? " · cloudflared 도 있음" : ""}`
        : tunnel ? "Ingress 0 · cloudflared Pod 있음 → TLS 종단은 Cloudflare 엣지 (터널 구간도 TLS)" : "Ingress·cloudflared 없음 (이 네임스페이스에 공개 진입점 없음)", src);
}

export function analyzeWorkloadSecrets(pods: unknown[], cms: unknown[], src: string): LiveCheck {
  const hits: string[] = [];
  for (const p of pods.map(obj)) {
    for (const c of [...arr(obj(p.spec).containers), ...arr(obj(p.spec).initContainers)]) {
      for (const e of arr(c.env)) {
        if (typeof e.value !== "string" || e.value === "") continue;   // valueFrom(secretKeyRef) 은 정상
        const kind = secretKindOf(e.value) ?? (SECRET_ENV_NAME.test(String(e.name)) ? "secret_name_literal" : null);
        if (kind) hits.push(`pod/${nameOf(p)} ${String(c.name)} env ${String(e.name)} (${kind})`);
      }
    }
  }
  for (const m of cms.map(obj)) {
    for (const [k, v] of Object.entries(obj(m.data))) {
      const kind = typeof v === "string" ? secretKindOf(v) : null;
      if (kind) hits.push(`configmap/${nameOf(m)} ${k} (${kind})`);
    }
  }
  return check("secrets.workload", hits.length ? "fail" : "pass", `Pod ${pods.length}개 · ConfigMap ${cms.length}개`,
    hits.length ? `평문 비밀값 ${hits.length}곳: ${hits.slice(0, 5).join(" · ")}`.slice(0, 300) : "Pod env 의 비밀값은 전부 secretKeyRef · ConfigMap 비밀 패턴 0", src);
}

// 네임스페이스 RoleBinding + 그 네임스페이스 SA 를 묶은 ClusterRoleBinding. cluster-admin = fail, admin·edit = warn
export function analyzeRbac(rbs: unknown[], crbs: unknown[], ns: string, src: string): LiveCheck {
  const bad: string[] = [], weak: string[] = [];
  const nsSubjects = (b: Json) => arr(b.subjects).some((s) => s.kind === "ServiceAccount" && (s.namespace ?? ns) === ns);
  for (const b of rbs.map(obj)) {
    const r = String(obj(b.roleRef).name);
    if (r === "cluster-admin") bad.push(`RoleBinding ${nameOf(b)} → cluster-admin`);
    else if (r === "admin" || r === "edit") weak.push(`RoleBinding ${nameOf(b)} → ${r}`);
  }
  for (const b of crbs.map(obj).filter(nsSubjects)) {
    const r = String(obj(b.roleRef).name);
    if (r === "cluster-admin" || r === "admin" || r === "edit") bad.push(`ClusterRoleBinding ${nameOf(b)} → ${r} (클러스터 전체)`);
    else weak.push(`ClusterRoleBinding ${nameOf(b)} → ${r}`);
  }
  return check("iam.k8s_rbac", bad.length ? "fail" : weak.length ? "warn" : "pass", `ns ${ns}`,
    bad.length ? bad.join(" · ").slice(0, 300) : weak.length ? weak.join(" · ").slice(0, 300) : `RoleBinding ${rbs.length}개 · 넓은 역할 묶음 0 · 이 ns SA 의 ClusterRoleBinding 0`, src);
}

export const K8S_KEYS: LiveCheckKey[] = ["public_ports.services", "tls.ingress", "secrets.workload", "iam.k8s_rbac"];

export async function checkK8s(run: ExecRunner, f: K8sFacts | null): Promise<LiveCheck[]> {
  if (!f) return K8S_KEYS.map((k) => check(k, "unavailable", "k8s", "kube 컨텍스트·네임스페이스 없음 (SEC_KUBE_CONTEXT_<환경> 설정 전)", "환경 변수"));
  const g = (what: string, nsScoped = true) => readJson(run, "kubectl", ["--context", f.context, "get", what, ...(nsScoped ? ["-n", f.namespace] : []), "-o", "json"]);
  const [svc, ing, pods, cms, rbs, crbs] = await Promise.all([g("services"), g("ingresses"), g("pods"), g("configmaps"), g("rolebindings"), g("clusterrolebindings", false)]);
  const first = [svc, ing, pods, cms, rbs].find((x) => !x.ok);
  if (first && !first.ok && (first.missing || /context|connect|refused|Unable|forbidden|Unauthorized/i.test(first.why))) {
    const why = first.missing ? "kubectl CLI 없음" : `k8s API 못 읽음: ${first.why}`;
    return K8S_KEYS.map((k) => check(k, "unavailable", `ns ${f.namespace}`, why, "kubectl get"));
  }
  const ok = (x: typeof svc) => (x.ok ? items(x.json) : null);
  const S = (w: string) => `kubectl get ${w} -n ${f.namespace}`;
  const pl = ok(pods);
  return [
    ok(svc) ? analyzeServices(ok(svc)!, S("services")) : check("public_ports.services", "unavailable", `ns ${f.namespace}`, svc.ok ? "" : svc.why, S("services")),
    ok(ing) && pl ? analyzeIngress(ok(ing)!, pl, S("ingresses,pods")) : check("tls.ingress", "unavailable", `ns ${f.namespace}`, !ing.ok ? ing.why : "Pod 못 읽음", S("ingresses")),
    pl && ok(cms) ? analyzeWorkloadSecrets(pl, ok(cms)!, S("pods,configmaps")) : check("secrets.workload", "unavailable", `ns ${f.namespace}`, "Pod·ConfigMap 못 읽음", S("pods,configmaps")),
    ok(rbs) ? analyzeRbac(ok(rbs)!, ok(crbs) ?? [], f.namespace, S("rolebindings") + " + clusterrolebindings")
      : check("iam.k8s_rbac", "unavailable", `ns ${f.namespace}`, rbs.ok ? "" : rbs.why, S("rolebindings")),
  ];
}
