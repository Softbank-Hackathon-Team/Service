import { isSecretResource, type AgentInventoryList, type AgentInventorySnapshot } from "@svc/contracts";
import { arr, CliError, get, runJson, runText, str, type CliDeps } from "../common/cli.js";
import { AdapterError } from "../common/errors.js";
import type { Exec, ExecResult } from "../terraform/real-runner.js";
import { appCrdResources, ESO_RESOURCES, GATEWAY_API_RESOURCES, SYSTEM_NS } from "./k8s.js";

// 온프레 출발 가져오기 인벤토리 스냅숏 (pull 모드). DECISION(team): 플랫폼은 고객 VM 안으로 들어가지 않는다 (온프레 영역 결정, 2026-11-07)
//   Agent(클러스터 안) : collectInventorySnapshot → discover 가 읽는 자원을 클러스터 범위(get <자원> -A -o json)로 한 번씩 읽어 보고 kind "inventory" 로 보낸다
//   워커(가져오기)      : snapshotExec(스냅숏) 을 CliDeps.exec 로 끼워 discoverOnprem 을 그대로 돌린다.
//                        discover 가 부르는 kubectl 명령(-n 네임스페이스·이름 하나·-l 라벨)은 클러스터 범위 목록에서 걸러 답한다
// 왜 "명령 녹화"가 아니라 클러스터 범위 목록인가: discover 가 부르는 명령은 이전마다 다른 출발 범위(source_scope → IMPORT_NAMESPACE 등)에
//   따라 달라진다. Agent 는 이전 번호·범위를 모르므로, 범위와 상관없이 답할 수 있는 재료(전체 목록)를 보낸다.
// 읽기 전용: get·api-resources 만. Secret 은 목록에 없고, 계약(contracts AgentInventorySnapshot)도 Secret 자원 이름을 거부한다.
// 답할 수 없는 명령(스냅숏에 없는 자원·모르는 옵션) = Agent 판이 플랫폼 discover 보다 오래된 것 → 이름을 들고 멈춘다 (SOURCE_UNAVAILABLE)

type Obj = Record<string, unknown>;

/** 클러스터 단위 자원 (-A 없이) */
const CLUSTER_SCOPED = ["nodes", "namespaces", "clusterrolebindings"] as const;
/** 네임스페이스 자원. discover/k8s.ts readK8sNamespace(listAll·Deployment·CronJob 목록)와 discoverOnprem(CNPG)이 읽는 종류 그대로 */
const NAMESPACED = [
  "deployments", "services", "ingresses", "horizontalpodautoscalers", "cronjobs", "networkpolicies", "serviceaccounts", "configmaps",
  "pods", "persistentvolumeclaims", "poddisruptionbudgets", "roles", "rolebindings", "replicasets", "statefulsets", "daemonsets", "jobs",
  "clusters.postgresql.cnpg.io",
] as const;
// DRAFT(ai): 시스템 네임스페이스(kube-system·argocd 등, discover 의 SYSTEM_NS) 항목은 앱 후보가 아니라 뺀다 (크기·노출 줄이기).
//   예외 = CNPG Cluster·Gateway API (discover 가 네임스페이스와 상관없이 읽는다). 출발 범위로 시스템 네임스페이스를 직접 고르면 빈 목록이 된다
const KEEP_SYSTEM_NS = new Set<string>(["clusters.postgresql.cnpg.io", ...GATEWAY_API_RESOURCES]);
// DRAFT(ai): kubectl 오류 글은 2000자까지 (계약 상한과 같음)
const STDERR_MAX = 2000;
const KUBE_TIMEOUT = "--request-timeout=15s";

/** discover 가 쓰지 않는 무거운 칸을 뺀다: managedFields, last-applied 주석. (droppedAnnotations 도 last-applied 를 도구 기록으로 보고 안 센다) */
function slim(o: Obj): Obj {
  const m = o.metadata as Obj | undefined;
  if (!m || typeof m !== "object") return o;
  const meta: Obj = { ...m };
  delete meta.managedFields;
  const ann = meta.annotations as Obj | undefined;
  if (ann && typeof ann === "object" && "kubectl.kubernetes.io/last-applied-configuration" in ann) {
    const a = { ...ann };
    delete a["kubectl.kubernetes.io/last-applied-configuration"];
    meta.annotations = a;
  }
  return { ...o, metadata: meta };
}
/** N12: 앱 CRD 객체는 discover 가 이름·네임스페이스·라벨만 쓴다 → 나머지(spec·status, 값이 들어 있을 수 있음)는 안 보낸다 */
const metaOnly = (o: Obj): Obj => {
  const m = (o.metadata ?? {}) as Obj;
  return { apiVersion: o.apiVersion, kind: o.kind, metadata: { name: m.name, namespace: m.namespace, ...(m.labels ? { labels: m.labels } : {}) } };
};
/** SS-V: SecretStore 는 discover 가 provider 종류 이름만 쓴다 → 인증 설정(auth 칸)은 안 보낸다 */
const storeOnly = (o: Obj): Obj => {
  const m = (o.metadata ?? {}) as Obj;
  const provider = Object.fromEntries(Object.keys((get(o, "spec", "provider") as Obj | undefined) ?? {}).map((k) => [k, {}]));
  return { apiVersion: o.apiVersion, kind: o.kind, metadata: { name: m.name, namespace: m.namespace, ...(m.labels ? { labels: m.labels } : {}) }, spec: { provider } };
};

export interface InventorySnapshotOpts {
  agentVersion: string;
  /** kubectl 앞 인자 (예: ["--context", "k3d-x"]). 클러스터 안 Agent 는 빈 값 = ServiceAccount 토큰 */
  kube?: string[];
  /** kubectl --request-timeout 을 붙이나. 기본 = kube 인자가 있을 때만 (클러스터 밖에서 context 로 볼 때).
   *  클러스터 안(ServiceAccount 토큰)에서는 붙이지 않는다: kubectl v1.36.5 는 이 옵션이 있으면 in-cluster 설정을 쓰지 않고
   *  localhost:8080 으로 간다 (2026-11-07 온프레 VM Agent 파드에서 실측, 목록 21개 전부 실패). 시간 상한은 자식 프로세스 timeoutMs(CLOUD_READ_TIMEOUT_MS)가 지킨다 */
  requestTimeout?: boolean;
  now?: () => Date;
}

/** Agent 쪽: 스냅숏 모으기. 실패한 읽기는 오류 칸으로 남긴다 (워커가 같은 오류로 다시 재생). kubectl 실행 자체가 안 되면(CliError 아님) 던진다 */
export async function collectInventorySnapshot(d: CliDeps, o: InventorySnapshotOpts): Promise<AgentInventorySnapshot> {
  const kube = [...(o.kube ?? []), ...((o.requestTimeout ?? (o.kube?.length ?? 0) > 0) ? [KUBE_TIMEOUT] : [])];
  const errOf = (e: unknown) => {
    if (!(e instanceof CliError)) throw e;
    return { exitCode: e.exitCode, stderr: e.stderr.slice(0, STDERR_MAX) };
  };
  let apiResources: AgentInventorySnapshot["apiResources"];
  let names: string[] = [];
  try {
    names = String(await runText(d, "kubectl", ["api-resources", "--namespaced=true", "--verbs=list", "-o", "name", ...kube])).split(/\s+/).filter(Boolean);
    apiResources = { names };
  } catch (e) { apiResources = { error: errOf(e) }; }
  const dynamic = [...appCrdResources(names), ...ESO_RESOURCES.filter((r) => names.includes(r)), ...GATEWAY_API_RESOURCES.filter((r) => names.includes(r))];
  const crd = new Set(appCrdResources(names));
  const lists: AgentInventoryList[] = [];
  for (const [resource, clusterScoped] of [...CLUSTER_SCOPED.map((r) => [r, true] as const), ...[...NAMESPACED, ...dynamic].map((r) => [r, false] as const)]) {
    // Secret 이름의 자원(같은 이름의 CRD 포함)은 부르지 않는다. 오류 칸으로 남겨 워커 discover 가 "못 읽음"으로 본다
    if (isSecretResource(resource)) { lists.push({ resource, error: { exitCode: 1, stderr: `Agent 는 Secret 이름의 자원(${resource})을 읽지 않는다` } }); continue; }
    try {
      const raw = arr(get(await runJson(d, "kubectl", ["get", resource, ...(clusterScoped ? [] : ["-A"]), ...kube, "-o", "json"]), "items"));
      const kept = clusterScoped || KEEP_SYSTEM_NS.has(resource) ? raw : raw.filter((x) => !SYSTEM_NS.test(str(get(x, "metadata", "namespace")) ?? ""));
      const shape = crd.has(resource) ? metaOnly : resource === "secretstores.external-secrets.io" ? storeOnly : slim;
      lists.push({ resource, items: kept.map(shape) });
    } catch (e) { lists.push({ resource, error: errOf(e) }); }
  }
  const at = (o.now?.() ?? new Date()).toISOString();
  return { kind: "inventory", agentVersion: o.agentVersion, sentAt: at, collectedAt: at, apiResources, lists };
}

/** 보내기 전 크기 (서명할 JSON 글자 바이트). 계약 상한(AGENT_INVENTORY_MAX_BYTES)을 넘으면 Agent 가 보내지 않는다 (API 도 같은 상한으로 413) */
export const snapshotBytes = (s: AgentInventorySnapshot) => Buffer.byteLength(JSON.stringify(s), "utf8");

// ── 워커 쪽: 스냅숏으로 kubectl 답하기 ──────────────────────────────────
interface KubectlQuery { verb: "get" | "api-resources"; resource?: string; name?: string; ns?: string; labels?: Record<string, string> }
const ALIAS: Record<string, string> = { namespace: "namespaces" };
/** discover 가 부르는 모양만 안다. 모르는 옵션이 있으면 null (= 답하지 않고 멈춤) */
export function parseKubectl(args: readonly string[]): KubectlQuery | null {
  const pos: string[] = [];
  let ns: string | undefined, all = false, sel: string | undefined, out: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--context") { i++; continue; }
    if (a.startsWith("--context=") || a.startsWith("--request-timeout=")) continue;
    if (a === "-n" || a === "--namespace") { ns = args[++i]; continue; }
    if (a === "-A" || a === "--all-namespaces") { all = true; continue; }
    if (a === "-l" || a === "--selector") { sel = args[++i]; continue; }
    if (a === "-o" || a === "--output") { out = args[++i]; continue; }
    if (a === "--namespaced=true" || a === "--verbs=list") { flags.add(a); continue; }
    if (a.startsWith("-")) return null;
    pos.push(a);
  }
  if (pos[0] === "api-resources") return pos.length === 1 && out === "name" && flags.size === 2 && !ns && !all && !sel ? { verb: "api-resources" } : null;
  if (pos[0] !== "get" || out !== "json" || flags.size || pos.length < 2 || pos.length > 3 || (ns && all)) return null;
  let labels: Record<string, string> | undefined;
  if (sel !== undefined) {
    labels = {};
    for (const part of sel.split(",")) {
      const m = /^([A-Za-z0-9./_-]+)=([A-Za-z0-9._-]*)$/.exec(part);
      if (!m) return null;   // 같음(=) 말고는 모른다
      labels[m[1]!] = m[2]!;
    }
  }
  const resource = ALIAS[pos[1]!] ?? pos[1]!;
  return { verb: "get", resource, ...(pos[2] ? { name: pos[2] } : {}), ...(ns ? { ns } : {}), ...(labels ? { labels } : {}) };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", ms: 0 });
const fail = (e: { exitCode: number; stderr: string }): ExecResult => ({ code: e.exitCode, stdout: "", stderr: e.stderr, ms: 0 });

/** 스냅숏 → CliDeps.exec. discover 코드는 그대로이고, kubectl 대신 이 함수가 답한다 (네트워크 없음) */
export function snapshotExec(snap: AgentInventorySnapshot): Exec {
  const lists = new Map(snap.lists.map((l) => [l.resource, l]));
  return async (cmd, args) => {
    const line = `${cmd} ${args.filter((a, i) => a !== "--context" && args[i - 1] !== "--context").join(" ")}`.slice(0, 200);
    const miss = (why: string) => new AdapterError("SOURCE_UNAVAILABLE",
      `출발 환경을 읽을 수 없음: Agent 인벤토리 스냅숏으로 답할 수 없는 명령 (${why}): ${line} — Agent(${snap.agentVersion}) 판이 플랫폼 가져오기보다 오래됐을 수 있다. Agent 이미지를 새로 받아 재시작한 뒤 다음 보고를 기다려 다시 가져온다`);
    if (cmd !== "kubectl") throw miss("kubectl 이 아님");
    const q = parseKubectl(args);
    if (!q) throw miss("모르는 명령 모양");
    if (q.verb === "api-resources") return "error" in snap.apiResources ? fail(snap.apiResources.error) : ok(snap.apiResources.names.join("\n") + "\n");
    const l = lists.get(q.resource!);
    if (!l) throw miss(`스냅숏에 ${q.resource} 목록이 없음`);
    if ("error" in l) return fail(l.error);
    let items = l.items as Obj[];
    if (q.ns) items = items.filter((o) => get(o, "metadata", "namespace") === q.ns);
    if (q.labels) items = items.filter((o) => {
      const have = (get(o, "metadata", "labels") ?? {}) as Obj;
      return Object.entries(q.labels!).every(([k, v]) => have[k] === v);
    });
    if (q.name) {
      const one = items.find((o) => get(o, "metadata", "name") === q.name);
      return one ? ok(JSON.stringify(one)) : { code: 1, stdout: "", stderr: `Error from server (NotFound): ${q.resource} "${q.name}" not found`, ms: 0 };
    }
    return ok(JSON.stringify({ apiVersion: "v1", kind: "List", items }));
  };
}
