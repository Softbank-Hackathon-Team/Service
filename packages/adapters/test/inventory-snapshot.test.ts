// 온프레 출발 가져오기 (pull 모드): Agent 인벤토리 스냅숏 → 워커 discover 재생.
//   가짜 클러스터 하나(-n·-A·이름·-l 를 진짜처럼 거르는 kubectl)로 직접 읽기와 스냅숏 재생을 둘 다 돌려 결과(원본 목록·공통 명세)가 같은지 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentInventorySnapshot, AGENT_INVENTORY_MAX_BYTES } from "@svc/contracts";
import { discoverOnprem, discoverSource } from "../src/discover/index.js";
import { collectInventorySnapshot, parseKubectl, snapshotBytes, snapshotExec } from "../src/discover/inventory-snapshot.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { isAdapterError } from "../src/common/errors.js";
import type { Exec } from "../src/terraform/real-runner.js";

type Obj = Record<string, unknown>;
const D = "sha256:" + "ab".repeat(32);
const meta = (name: string, namespace?: string, labels?: Record<string, string>, extra: Obj = {}) =>
  ({ name, ...(namespace ? { namespace } : {}), ...(labels ? { labels } : {}), ...extra });
const BIG = { managedFields: [{ manager: "kubectl", fieldsV1: { "f:spec": { "f:x": {} } } }],
  annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{\"big\":true}", "app.kubernetes.io/note": "keep" } };
const dep = (name: string, ns: string, partOf?: string) => ({
  apiVersion: "apps/v1", kind: "Deployment",
  metadata: meta(name, ns, { app: name, ...(partOf ? { "app.kubernetes.io/part-of": partOf } : {}) }, BIG),
  spec: { replicas: 2, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env: [{ name: "LOG", value: "info" }, { name: "PW", valueFrom: { secretKeyRef: { name: "db", key: "pw" } } }],
    resources: { requests: { cpu: "100m", memory: "128Mi" } }, readinessProbe: { httpGet: { path: "/healthz", port: 8080 } } }] } } },
});
const rs = (name: string, ns: string) => ({ metadata: meta(`${name}-rs`, ns, { app: name }, { ownerReferences: [{ kind: "Deployment", name }] }),
  spec: { replicas: 2, selector: { matchLabels: { app: name } } }, status: { replicas: 2 } });
const pod = (name: string, ns: string) => ({ metadata: meta(`${name}-1`, ns, { app: name }, { ownerReferences: [{ kind: "ReplicaSet", name: `${name}-rs` }] }),
  status: { phase: "Running", containerStatuses: [{ name, imageID: `ghcr.io/demo/${name}@${D}` }] } });
const svc = (name: string, ns: string) => ({ metadata: meta(name, ns), spec: { type: "ClusterIP", selector: { app: name }, ports: [{ port: 80, targetPort: 8080 }] } });

// 가짜 클러스터: 자원 → 항목들 (네임스페이스는 metadata.namespace). forbidden = 이 자원은 403
interface Cluster { res: Record<string, Obj[]>; forbidden: Set<string>; apiResources: string[] }
const cluster = (): Cluster => ({
  apiResources: ["pods", "services", "configmaps", "secrets", "deployments", "replicasets", "ingresses", "certificates.cert-manager.io", "widgets.example.com",
    "clusters.postgresql.cnpg.io", "httproutes.gateway.networking.k8s.io", "gateways.gateway.networking.k8s.io"],
  forbidden: new Set(["roles", "rolebindings", "clusterrolebindings", "certificates.cert-manager.io", "gateways.gateway.networking.k8s.io"]),
  res: {
    nodes: [{ metadata: meta("node-1"), status: { nodeInfo: { kubeletVersion: "v1.33.5+k3s1" }, allocatable: { cpu: "4", memory: "8Gi" } } }],
    namespaces: [{ metadata: meta("shop", undefined, { "kubernetes.io/metadata.name": "shop" }) }, { metadata: meta("shop-data") }, { metadata: meta("other") },
      { metadata: meta("kube-system") }, { metadata: meta("served-by", undefined, { "managed-by": "platform" }) }],
    deployments: [dep("web", "shop", "shop"), dep("api", "shop", "shop"), dep("etl", "shop-data", "shop"), dep("blog", "other"), dep("coredns", "kube-system"), dep("app-demo", "served-by")],
    replicasets: [rs("web", "shop"), rs("api", "shop"), rs("etl", "shop-data"), rs("blog", "other"), rs("coredns", "kube-system")],
    pods: [pod("web", "shop"), pod("api", "shop"), pod("etl", "shop-data"), pod("blog", "other"), pod("coredns", "kube-system")],
    services: [svc("web", "shop"), svc("api", "shop"), svc("blog", "other"), svc("kube-dns", "kube-system")],
    ingresses: [{ metadata: meta("shop", "shop"), spec: { rules: [{ host: "shop.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "web", port: { number: 80 } } } }] } }] } }],
    configmaps: [{ metadata: meta("shop-cfg", "shop"), data: { LEVEL: "info" } }, { metadata: meta("coredns", "kube-system"), data: { Corefile: "x".repeat(5000) } }],
    serviceaccounts: [{ metadata: meta("api", "shop") }], horizontalpodautoscalers: [], cronjobs: [], jobs: [], networkpolicies: [], persistentvolumeclaims: [],
    poddisruptionbudgets: [], statefulsets: [], daemonsets: [],
    "clusters.postgresql.cnpg.io": [{ metadata: meta("shop-db", "shop"), spec: { instances: 1, imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "1Gi" } } }],
    "widgets.example.com": [{ apiVersion: "example.com/v1", kind: "Widget", metadata: meta("w1", "shop", { a: "b" }), spec: { token: "CRD-SPEC-VALUE" } }],
    "httproutes.gateway.networking.k8s.io": [{ metadata: meta("r", "shop"), spec: { parentRefs: [{ name: "public", namespace: "gw" }], hostnames: ["shop.example.com"],
      rules: [{ backendRefs: [{ name: "web", port: 80 }] }] } }],
    secrets: [{ metadata: meta("db", "shop"), data: { pw: "U0VDUkVULVZBTFVF" } }],
  },
});
/** kubectl 처럼 -n·-A·이름·-l 를 해석하는 가짜 (모르는 모양이면 실패). calls 에 부른 명령 */
function fakeKubectl(c: Cluster) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    const q = parseKubectl(args);
    if (cmd !== "kubectl" || !q) return { code: 1, stdout: "", stderr: `fake: unknown ${args.join(" ")}`, ms: 1 };
    if (q.verb === "api-resources") return { code: 0, stdout: c.apiResources.join("\n") + "\n", stderr: "", ms: 1 };
    const r = q.resource!;
    if (c.forbidden.has(r)) return { code: 1, stdout: "", stderr: `Error from server (Forbidden): ${r} is forbidden: User "system:serviceaccount:svc-agent:onprem-agent" cannot list resource`, ms: 1 };
    if (!(r in c.res)) return { code: 1, stdout: "", stderr: `error: the server doesn't have a resource type "${r}"`, ms: 1 };
    let items = c.res[r]!;
    if (q.ns) items = items.filter((o) => (o.metadata as Obj).namespace === q.ns);
    if (q.labels) items = items.filter((o) => Object.entries(q.labels!).every(([k, v]) => ((o.metadata as Obj).labels as Obj | undefined)?.[k] === v));
    if (q.name) {
      const one = items.find((o) => (o.metadata as Obj).name === q.name);
      return one ? { code: 0, stdout: JSON.stringify(one), stderr: "", ms: 1 } : { code: 1, stdout: "", stderr: `Error from server (NotFound): ${r} "${q.name}" not found`, ms: 1 };
    }
    return { code: 0, stdout: JSON.stringify({ items }), stderr: "", ms: 1 };
  };
  return { exec, calls };
}
const now = () => new Date("2026-11-07T00:00:00Z");
const snapOf = async (c = cluster()) => {
  const k = fakeKubectl(c);
  const snap = await collectInventorySnapshot({ exec: k.exec }, { agentVersion: "onprem-agent/test", now });
  return { snap, calls: k.calls };
};

test("스냅숏 모양: 계약 통과, Secret 은 안 읽음, 시스템 네임스페이스·managedFields·last-applied 는 빠짐, 앱 CRD 는 이름만", async () => {
  // Secret 과 같은 이름의 CRD 도 둔다 (직접 discover 는 이름만 읽지만 Agent 는 아예 안 읽는다 → 이 경우만 "못 읽음" 검토 줄로 갈린다)
  const c = cluster();
  c.apiResources.push("secrets.vault.example.io");
  c.res["secrets.vault.example.io"] = [{ metadata: meta("v", "shop"), spec: { value: "VAULT-CRD-VALUE" } }];
  const { snap, calls } = await snapOf(c);
  assert.ok(AgentInventorySnapshot.safeParse(snap).success);
  assert.ok(!calls.some((l) => /^kubectl get secrets?[ .]/.test(l)), "Secret(같은 이름 CRD 포함)을 부르지 않는다");
  assert.ok(snap.lists.some((l) => l.resource === "secrets.vault.example.io" && "error" in l), "안 읽었음은 오류 칸");
  assert.ok(calls.every((l) => /^kubectl (get|api-resources) /.test(l)), "읽기 명령만");
  const s = JSON.stringify(snap);
  assert.ok(!s.includes("U0VDUkVULVZBTFVF") && !s.includes("VAULT-CRD-VALUE") && !s.includes("managedFields") && !s.includes("last-applied-configuration") && !s.includes("CRD-SPEC-VALUE"));
  assert.ok(s.includes("app.kubernetes.io/note"), "다른 주석은 남김");
  const deps = snap.lists.find((l) => l.resource === "deployments")!;
  assert.ok("items" in deps && !deps.items.some((o) => (o.metadata as Obj).namespace === "kube-system"));
  const forbidden = snap.lists.find((l) => l.resource === "roles")!;
  assert.ok("error" in forbidden && /Forbidden/.test(forbidden.error.stderr), "못 읽은 것은 오류 칸");
  assert.ok(snap.lists.some((l) => l.resource === "widgets.example.com") && !snap.lists.some((l) => l.resource === "certificates.cert-manager.io" && "items" in l));
  // 크기 상한 안 (이 고정 클러스터는 약 9KB)
  assert.ok(snapshotBytes(snap) < AGENT_INVENTORY_MAX_BYTES);
});

// 직접 kubectl 로 읽은 결과와 스냅숏 재생 결과가 같아야 한다 (자동 고르기 · 출발 범위로 고른 네임스페이스 둘 다)
for (const [label, env] of [["자동 고르기", {}], ["출발 범위 namespace=other", { IMPORT_NAMESPACE: "other" }], ["여러 네임스페이스", { IMPORT_NAMESPACE: "shop,shop-data" }]] as const) {
  test(`같은 결과 (${label}): 직접 kubectl discover == 스냅숏 재생 discover, 공통 명세도 같다`, async () => {
    const c = cluster();
    const direct = await discoverOnprem({ exec: fakeKubectl(c).exec, env: { ...env } }, {});
    const { snap } = await snapOf(c);
    const replay = await discoverOnprem({ exec: snapshotExec(snap), env: { ...env } }, {});
    assert.deepEqual(replay, direct);
    assert.ok(direct.items.some((i) => (i as { kind: string }).kind === "k8s.deployment"));
    assert.deepEqual(normalizeV2(replay).result, normalizeV2(direct).result);
  });
}

test("출발 범위(source_scope)도 같은 길: discoverSource scope.namespaces", async () => {
  const c = cluster();
  const scope = { namespaces: ["other"] };
  const direct = await discoverSource("onprem", { exec: fakeKubectl(c).exec, env: {} }, { scope });
  const { snap } = await snapOf(c);
  assert.deepEqual(await discoverSource("onprem", { exec: snapshotExec(snap), env: {} }, { scope }), direct);
});

test("재생 거부: 스냅숏에 없는 자원·모르는 옵션·kubectl 아닌 명령은 그 명령 이름을 들고 SOURCE_UNAVAILABLE", async () => {
  const { snap } = await snapOf();
  const exec = snapshotExec(snap);
  const o = { cwd: ".", env: {}, timeoutMs: 1 };
  for (const [cmd, args, want] of [
    ["kubectl", ["get", "leases", "-A", "-o", "json"], /leases/],
    ["kubectl", ["get", "secrets", "-n", "shop", "-o", "json"], /secrets/],
    ["kubectl", ["get", "pods", "-A", "--field-selector=status.phase=Running", "-o", "json"], /모르는 명령 모양/],
    ["kubectl", ["get", "pods", "-l", "app!=x", "-o", "json"], /모르는 명령 모양/],
    ["kubectl", ["apply", "-f", "x.yaml"], /모르는 명령 모양/],
    ["aws", ["sts", "get-caller-identity"], /kubectl 이 아님/],
  ] as const) {
    await assert.rejects(exec(cmd, [...args], o), (e: unknown) => isAdapterError(e) && e.code === "SOURCE_UNAVAILABLE" && want.test((e as Error).message) && /Agent/.test((e as Error).message), `${cmd} ${args.join(" ")}`);
  }
  // 이름 하나 찾기: 없으면 kubectl 과 같은 NotFound (오류 재생)
  const nf = await exec("kubectl", ["get", "namespace", "nope", "-o", "json"], o);
  assert.equal(nf.code, 1);
  assert.match(nf.stderr, /NotFound/);
});

test("재생: 못 읽은 목록은 같은 오류로 재생 → discover 가 직접 읽을 때와 같은 검토 줄 (권한 없는 RBAC·Gateway)", async () => {
  const { snap } = await snapOf();
  const inv = await discoverOnprem({ exec: snapshotExec(snap), env: {} }, {});
  const unread = inv.items.filter((i) => (i as { kind: string }).kind === "k8s.unread").map((i) => (i as { resource: string }).resource);
  assert.ok(unread.includes("Role") && unread.includes("ClusterRoleBinding") && unread.some((r) => r.startsWith("Gateway")), unread.join(","));
});

test("계약 거부: Secret 자원 이름·items 와 error 를 같이·모르는 칸·상한 넘는 목록 수", async () => {
  const { snap } = await snapOf();
  const bad = (s: unknown) => !AgentInventorySnapshot.safeParse(s).success;
  assert.ok(bad({ ...snap, lists: [...snap.lists, { resource: "secrets", items: [] }] }));
  assert.ok(bad({ ...snap, lists: [{ resource: "pods", items: [], error: { exitCode: 1, stderr: "x" } }] }));
  assert.ok(bad({ ...snap, extra: 1 }));
  assert.ok(bad({ ...snap, lists: Array.from({ length: 301 }, () => ({ resource: "pods", items: [] })) }));
  assert.ok(bad({ ...snap, lists: [{ resource: "Pods; rm", items: [] }] }));
});
