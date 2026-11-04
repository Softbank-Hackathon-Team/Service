// I2: 네임스페이스 전체 읽기 (readK8sNamespace · discover ir=v2 · 감사 판). 클라우드 CLI 는 가짜 exec 로만 바꾼다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readK8sNamespace } from "../src/discover/k8s.js";
import { discoverForImport, discoverGcp, discoverOnprem, inventoryForAudit } from "../src/discover/index.js";
import { K8S_RAW_KINDS } from "../src/import/raw-k8s.js";
import { DEMO_INVENTORY} from "../src/common/fixtures.js";
import type { Exec } from "../src/terraform/real-runner.js";

const D = "sha256:" + "cd".repeat(32);
const NS = "shop";
type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    const r = hit[1];
    return { code: r.code ?? 0, stdout: JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
  return { exec, calls };
}

const container = (name: string, env: unknown[] = []) => ({
  name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }],
  resources: { requests: { cpu: "300m", memory: "768Mi" } },
  readinessProbe: { httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 5 }, env,
});
const dep = (name: string, env: unknown[] = []) => ({
  metadata: { name, namespace: NS, labels: { app: name }, annotations: { "secret/note": "TOPSECRET-ANNOTATION" } },
  spec: { replicas: 2, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [container(name, env)] } } },
});
const pod = (name: string, labels: Record<string, string>) => ({
  metadata: { name: `${name}-1`, namespace: NS, labels, ownerReferences: [{ kind: "ReplicaSet", name: `${name}-rs` }] },
  status: { containerStatuses: [{ name, imageID: `ghcr.io/demo/${name}@${D}` }] },
});
const cron = {
  metadata: { name: "cleanup", namespace: NS },
  spec: { schedule: "0 3 * * *", jobTemplate: { spec: { backoffLimit: 2, template: { spec: { restartPolicy: "OnFailure",
    initContainers: [{ name: "init", image: "busybox", env: [{ name: "INIT_TOKEN", value: "INIT-SECRET-VALUE" }], args: ["--token=ARG-SECRET"] }],
    containers: [{ name: "cleanup", image: "ghcr.io/demo/cleanup:1.0", command: ["node", "c.js"], args: ["--pw=ARG-SECRET2"], env: [{ name: "CRON_PW", value: "CRON-SECRET-VALUE" }] }] } } } } },
};
const CRON_POD = { metadata: { name: "cleanup-28000000-abc", namespace: NS, labels: { "job-name": "cleanup-28000000" } },
  status: { containerStatuses: [{ name: "cleanup", imageID: `ghcr.io/demo/cleanup@${D}` }] } };

const tables = (over: { pods?: unknown[]; hpa?: Reply; deps?: unknown[]; sts?: unknown[]; ds?: unknown[]; ns?: Reply; svcs?: unknown[]; jobs?: unknown[] } = {}): Array<[RegExp, Reply]> => [
  [/^kubectl get deployments/, { out: { items: over.deps ?? [dep("shop-web"), dep("shop-api", [{ name: "LOG", value: "PLAIN-ENV-VALUE" }, { name: "PW", valueFrom: { secretKeyRef: { name: "db", key: "password" } } }]), dep("shop-worker"),
    { metadata: { name: "coredns", namespace: "kube-system" }, spec: { template: { spec: { containers: [] } } } }] } }],
  [/^kubectl get services/, { out: { items: over.svcs ?? [{ metadata: { name: "shop-api", namespace: NS }, spec: { selector: { app: "shop-api" }, ports: [{ port: 80, targetPort: 8080 }] },
    status: { loadBalancer: { ingress: [{ hostname: "lb.example.com" }] } } }] } }],
  [/^kubectl get ingresses/, { out: { items: [{ metadata: { name: "shop", namespace: NS, annotations: { a: "b" } }, spec: { rules: [{ host: "shop.example.com", http: { paths: [{ path: "/", backend: { service: { name: "shop-api", port: { number: 80 } } } }] } }] } }] } }],
  [/^kubectl get horizontalpodautoscalers/, over.hpa ?? { out: { items: [{ metadata: { name: "shop-api", namespace: NS }, spec: { scaleTargetRef: { kind: "Deployment", name: "shop-api" }, minReplicas: 2, maxReplicas: 6 } }] } }],
  [/^kubectl get cronjobs/, { out: { items: [cron] } }],
  [/^kubectl get networkpolicies/, { out: { items: [] } }],
  [/^kubectl get serviceaccounts/, { out: { items: [{ metadata: { name: "shop-api", namespace: NS, annotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::000000000000:role/x" } } }] } }],
  [/^kubectl get configmaps/, { out: { items: [{ metadata: { name: "shop-cfg", namespace: NS }, data: { LEVEL: "CM-SECRET-VALUE", MODE: "x" } }] } }],
  // G3-4: 지금 판 ReplicaSet (digest 를 고를 파드)
  [/^kubectl get replicasets/, { out: { items: ["shop-web", "shop-api", "shop-worker"].map((n) => ({ metadata: { name: `${n}-rs`, namespace: NS,
    annotations: { "deployment.kubernetes.io/revision": "1" }, ownerReferences: [{ kind: "Deployment", name: n }] } })) } }],
  [/^kubectl get nodes/, { out: { items: [] } }],   // A-1: 노드 CPU 종류 (빈 목록 = 못 읽은 게 아님)
  [/^kubectl get pods/, { out: { items: over.pods ?? [pod("shop-web", { app: "shop-web" }), pod("shop-api", { app: "shop-api" }), pod("shop-worker", { app: "shop-worker" }), CRON_POD] } }],
  // N4·N5·T3·N12: 빈 목록
  [/^kubectl get (persistentvolumeclaims|poddisruptionbudgets|roles|rolebindings|clusterrolebindings) /, { out: { items: [] } }],
  [/^kubectl api-resources /, { out: null }],
  [/^kubectl get statefulsets/, { out: { items: over.sts ?? [] } }],
  [/^kubectl get daemonsets/, { out: { items: over.ds ?? [] } }],
  [/^kubectl get jobs/, { out: { items: over.jobs ?? [] } }],
  [/^kubectl get namespace /, over.ns ?? { out: { metadata: { name: NS, labels: { "kubernetes.io/metadata.name": NS } } } }],
];

test("정상: 3티어 + HPA + CronJob + ConfigMap → 종류별 원본, 값·annotations 없음", async () => {
  const { exec, calls } = fakeExec(tables());
  const r = await readK8sNamespace({ exec, env: {} }, ["--context", "x"]);
  assert.equal(r.namespace, NS, "시스템 네임스페이스(kube-system)는 건너뛰고 첫 Deployment 의 네임스페이스");
  assert.ok(calls.every((c) => c.startsWith("kubectl get ") || c.startsWith("kubectl api-resources ")), "읽기(get·api-resources)만");
  assert.ok(!calls.some((c) => /secrets/.test(c)), "Secret 객체는 안 읽음");
  const n = (k: string) => r.items.filter((i) => i.kind === k).length;
  assert.equal(n(K8S_RAW_KINDS.deployment), 3);
  assert.equal(n(K8S_RAW_KINDS.cronjob), 1);
  assert.equal(n(K8S_RAW_KINDS.hpa), 1);
  assert.equal(n(K8S_RAW_KINDS.service), 1);
  assert.equal(n(K8S_RAW_KINDS.ingress), 1);
  assert.equal(n(K8S_RAW_KINDS.serviceAccount), 1);
  assert.equal(r.counts["k8s.deployment"], 3);
  const cm = r.items.find((i) => i.kind === "k8s.configMapKeys");
  assert.deepEqual(cm && "keys" in cm ? cm.keys : null, ["LEVEL", "MODE"], "ConfigMap 키 이름");
  // N3 (Jeong 11/3 결정): ConfigMap 값은 원본에 담는다 (평문 비밀 검사는 파이프라인)
  assert.deepEqual(cm && "data" in cm ? cm.data : null, { LEVEL: "CM-SECRET-VALUE", MODE: "x" }, "ConfigMap 값까지");
  const s = JSON.stringify(r.items);
  assert.ok(!s.includes("TOPSECRET-ANNOTATION") && !s.includes("annotations") && !s.includes("role-arn"), "허용 목록 밖 annotations 없음");
  assert.ok(s.includes("lb.example.com"), "Service status.loadBalancer.ingress 유지");
  const api = r.items.find((i) => i.kind === "k8s.deployment" && i.metadata.name === "shop-api");
  assert.equal(api?.kind === "k8s.deployment" ? api.imageDigest : "x", D);
  const cj = r.items.find((i) => i.kind === "k8s.cronjob");
  assert.equal(cj?.kind === "k8s.cronjob" ? cj.imageDigest : "x", D, "CronJob digest 는 Job 이 만든 Pod 에서");
  assert.deepEqual(r.notes, []);
});

test("경계: opts.namespace 가 IMPORT_NAMESPACE·자동 고르기보다 앞서고, -n 으로 부른다", async () => {
  const { exec, calls } = fakeExec(tables());
  const r = await readK8sNamespace({ exec, env: { IMPORT_NAMESPACE: "other" } }, [], { namespace: NS });
  assert.equal(r.namespace, NS);
  // 클러스터 단위 읽기(T3 ClusterRoleBinding·N12 CRD 종류 목록·A-1 노드·NS-1 네임스페이스 객체)만 -n 이 없다
  assert.ok(calls.filter((c) => !/clusterrolebindings|api-resources|get nodes/.test(c)).every((c) => c.includes(`-n ${NS}`) || c.startsWith(`kubectl get namespace ${NS} `)), calls.join("\n"));
});

test("거부: Pod 없음 → 멈추지 않고 imageDigest null + note", async () => {
  const { exec } = fakeExec(tables({ pods: [] }));
  const r = await readK8sNamespace({ exec, env: {} }, []);
  const deps = r.items.filter((i) => i.kind === "k8s.deployment");
  assert.equal(deps.length, 3);
  assert.ok(deps.every((i) => i.kind === "k8s.deployment" && i.imageDigest === null));
  assert.ok(r.notes.some((x) => x.includes("shop-api") && x.includes("digest")), "이유가 note 에");
  assert.ok(r.notes.some((x) => x.includes("CronJob")));
});

test("거부: HPA 목록 403 → note 만 남기고 나머지는 정상", async () => {
  const { exec } = fakeExec(tables({ hpa: { code: 1, err: 'Error from server (Forbidden): horizontalpodautoscalers is forbidden' } }));
  const r = await readK8sNamespace({ exec, env: {} }, []);
  assert.ok(r.notes.some((x) => x.includes("HPA") && x.includes("Forbidden")));
  assert.equal(r.items.filter((i) => i.kind === "k8s.hpa").length, 0);
  assert.equal(r.items.filter((i) => i.kind === "k8s.deployment").length, 3);
});

test("거부: Deployment·StatefulSet·DaemonSet·CronJob 이 없으면 SOURCE_INCOMPLETE", async () => {
  const t = tables({ deps: [] });
  t.splice(t.findIndex(([re]) => re.test("kubectl get cronjobs")), 1, [/^kubectl get cronjobs/, { out: { items: [] } }]);
  await assert.rejects(readK8sNamespace({ exec: fakeExec(t).exec, env: { IMPORT_NAMESPACE: NS } }, []), /Deployment·StatefulSet·DaemonSet·CronJob 이 없음/);
});

test("감사 판: CronJob·initContainer 의 env 값과 command·args 가 없고 이름은 남는다 (원본은 그대로)", async () => {
  const { exec } = fakeExec(tables());
  const r = await readK8sNamespace({ exec, env: {} }, []);
  const inv = { provider: "gcp" as const, coverage: r.counts, items: r.items as unknown as Record<string, unknown>[] };
  const s = JSON.stringify(inventoryForAudit(inv as never));
  for (const secret of ["INIT-SECRET-VALUE", "CRON-SECRET-VALUE", "ARG-SECRET", "ARG-SECRET2", "PLAIN-ENV-VALUE", "secretKeyRef"])
    assert.ok(!s.includes(secret), `${secret} 없음`);
  assert.ok(s.includes("CRON_PW") && s.includes("INIT_TOKEN") && s.includes("\"LOG\""), "이름은 남김");
  assert.ok(JSON.stringify(inv).includes("CRON-SECRET-VALUE"), "원본은 안 바뀜");
});

test("discover ir=v2: 온프레는 그 네임스페이스에서 읽고 CNPG 용량 기본값을 지어내지 않는다 (ir 없으면 기존 1Gi)", async () => {
  const t = tables();
  t.unshift([/^kubectl get nodes/, { out: { items: [] } }]);
  t.push([/^kubectl get clusters.postgresql.cnpg.io/, { out: { items: [{ metadata: { name: "shop-db", namespace: NS }, spec: { instances: 1 } }] } }]);
  const v2 = await discoverOnprem({ exec: fakeExec(t).exec, env: {} }, {});
  assert.equal(v2.items.filter((i) => (i as { kind: string }).kind === "k8s.deployment").length, 3);
  const db2 = v2.items.find((i) => (i as { kind: string }).kind === "cnpg.cluster") as { spec: { storage: { size: unknown } } };
  assert.equal(db2.spec.storage.size, null);
});

test("discover ir=v2: Cloud SQL ipAddresses 를 담고 디스크 크기 기본값 \"10\" 을 안 쓴다", async () => {
  const t = tables();
  t.unshift(
    [/^gcloud projects describe/, { out: {} }],
    [/^gcloud container clusters list/, { out: [{ name: "c", location: "asia-northeast3" }] }],
    [/^gcloud container clusters get-credentials/, { out: null }],
    [/^gcloud sql instances list/, { out: [{ name: "db", databaseVersion: "POSTGRES_16", settings: {}, ipAddresses: [{ type: "PRIVATE", ipAddress: "10.0.0.5" }] }] }],
  );
  const inv = await discoverGcp({ exec: fakeExec(t).exec, env: { GCP_PROJECT: "p" } }, {});
  const db = inv.items.find((i) => (i as { kind: string }).kind === "cloudsql.instance") as { settings: { dataDiskSizeGb: unknown }; ipAddresses: unknown[] };
  assert.equal(db.settings.dataDiskSizeGb, null);
  assert.deepEqual(db.ipAddresses, [{ type: "PRIVATE", ipAddress: "10.0.0.5" }]);
});

test("discoverForImport: MOCK_SEED 면 v2 는 DEMO_INVENTORY(없으면 v1 데모), 켜지 않으면 진짜 읽기", async () => {
  const env = { MOCK_SEED: "1" };
  assert.equal(await discoverForImport("gcp", {}, { env }), DEMO_INVENTORY.gcp);
  // I9: aws 도 V2 데모(ECS 3티어)가 생겼다. azure_mock 은 여전히 V2 데모 없음 → v1 데모
  assert.equal(await discoverForImport("aws", {}, { env }), DEMO_INVENTORY.aws, "aws V2 데모 = ECS 3티어");
  assert.equal(await discoverForImport("azure_mock", {}, { env }), DEMO_INVENTORY.azure_mock, "V2 데모 없음 → v1 데모");
  assert.equal(await discoverForImport("gcp", {}, { env }), DEMO_INVENTORY.gcp, "ir 없으면 기존 데모");
  const kinds = (DEMO_INVENTORY.onprem?.items ?? []).map((i) => (i as { kind: string }).kind);
  for (const k of ["k8s.deployment", "k8s.service", "k8s.ingress", "k8s.hpa", "k8s.cronjob", "cnpg.cluster"]) assert.ok(kinds.includes(k), k);
  await assert.rejects(discoverForImport("azure_mock", {}, { env: {} }), /Azure/);
});

// ── D6·V-1·NP-1·NS-1 ────────────────────────────────────────
const STS = { metadata: { name: "shop-kv", namespace: NS, labels: { app: "shop-kv" }, annotations: { x: "STS-ANN" } },
  spec: { replicas: 3, serviceName: "shop-kv", podManagementPolicy: "Parallel", persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Delete" },
    selector: { matchLabels: { app: "shop-kv" } },
    template: { metadata: { labels: { app: "shop-kv" } }, spec: { containers: [{ name: "kv", image: "ghcr.io/demo/kv:7", ports: [{ containerPort: 6379 }],
      volumeMounts: [{ name: "data", mountPath: "/data" }, { name: "conf", mountPath: "/etc/kv", subPath: "kv.conf", readOnly: true }] }] } },
    volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], storageClassName: "gp3", resources: { requests: { storage: "20Gi" } } } }] } };
const DS = { metadata: { name: "log-agent", namespace: NS }, spec: { selector: { matchLabels: { app: "log-agent" } },
  template: { metadata: { labels: { app: "log-agent" } }, spec: { containers: [{ name: "agent", image: `ghcr.io/demo/agent@${D}` }] } } }, status: { desiredNumberScheduled: 4 } };

test("D6 정상: StatefulSet(파드별 PVC·serviceName)·DaemonSet 을 읽고 digest 는 Pod 에서, 마운트 경로까지", async () => {
  const { exec } = fakeExec(tables({ sts: [STS], ds: [DS], pods: [pod("shop-web", { app: "shop-web" }), pod("shop-api", { app: "shop-api" }), pod("shop-worker", { app: "shop-worker" }), CRON_POD,
    { metadata: { name: "shop-kv-0", namespace: NS, labels: { app: "shop-kv" } }, status: { containerStatuses: [{ name: "kv", imageID: `ghcr.io/demo/kv@${D}` }] } }] }));
  const r = await readK8sNamespace({ exec, env: {} }, []);
  const sts = r.items.find((i) => i.kind === "k8s.statefulset") as unknown as { imageDigest: string; spec: Record<string, unknown> };
  assert.equal(sts.imageDigest, D);
  assert.equal(sts.spec.serviceName, "shop-kv");
  assert.equal(sts.spec.podManagementPolicy, "Parallel");
  assert.deepEqual(sts.spec.persistentVolumeClaimRetentionPolicy, { whenDeleted: "Retain", whenScaled: "Delete" });
  assert.deepEqual(sts.spec.volumeClaimTemplates, [{ name: "data", accessModes: ["ReadWriteOnce"], storage: "20Gi", storageClassName: "gp3" }]);
  const c = (sts.spec.template as { spec: { containers: Array<{ volumeMounts: unknown }> } }).spec.containers[0]!;
  assert.deepEqual(c.volumeMounts, [{ name: "data", mountPath: "/data" }, { name: "conf", mountPath: "/etc/kv", subPath: "kv.conf", readOnly: true }]);
  const ds = r.items.find((i) => i.kind === "k8s.daemonset") as unknown as { imageDigest: string; status: { desiredNumberScheduled: number } };
  assert.equal(ds.imageDigest, D);
  assert.equal(ds.status.desiredNumberScheduled, 4);
  assert.ok(!JSON.stringify(r.items).includes("STS-ANN"), "StatefulSet annotations 안 옮김");
  assert.equal(r.counts["k8s.statefulset"], 1);
});

test("D6 거부: Deployment 없이 StatefulSet 만 있어도 멈추지 않고, Pod 가 없으면 digest null + note", async () => {
  const { exec } = fakeExec(tables({ deps: [], sts: [STS], pods: [] }));
  const r = await readK8sNamespace({ exec, env: { IMPORT_NAMESPACE: NS } }, []);
  const sts = r.items.find((i) => i.kind === "k8s.statefulset") as unknown as { imageDigest: string | null };
  assert.equal(sts.imageDigest, null);
  assert.ok(r.notes.some((n) => n.includes("shop-kv") && n.includes("StatefulSet")));
});

test("V-1·NP-1 정상: headless·세션 고정·트래픽 정책·NodePort·허용 대역·ExternalName 을 읽는다", async () => {
  const svcs = [
    { metadata: { name: "shop-kv", namespace: NS }, spec: { clusterIP: "None", publishNotReadyAddresses: true, selector: { app: "shop-kv" }, ports: [{ port: 6379 }] } },
    { metadata: { name: "shop-api", namespace: NS }, spec: { type: "LoadBalancer", selector: { app: "shop-api" }, sessionAffinity: "ClientIP",
      sessionAffinityConfig: { clientIP: { timeoutSeconds: 600 } }, externalTrafficPolicy: "Local", loadBalancerSourceRanges: ["203.0.113.0/24"], loadBalancerIP: "198.51.100.7",
      clusterIP: "10.0.0.5", ports: [{ port: 80, targetPort: 8080, nodePort: 30080, protocol: "TCP" }] } },
    { metadata: { name: "legacy-db", namespace: NS }, spec: { type: "ExternalName", externalName: "db.corp.internal" } },
  ];
  const { exec } = fakeExec(tables({ svcs }));
  const r = await readK8sNamespace({ exec, env: {} }, []);
  const by = (n: string) => (r.items.find((i) => i.kind === "k8s.service" && i.metadata.name === n) as unknown as { spec: Record<string, unknown> }).spec;
  assert.equal(by("shop-kv").clusterIP, "None");
  assert.equal(by("shop-kv").publishNotReadyAddresses, true);
  const api = by("shop-api");
  assert.equal(api.clusterIP, undefined, "일반 clusterIP 주소는 안 옮김 (도착에서 새로 받음)");
  assert.equal(api.sessionAffinity, "ClientIP");
  assert.equal(api.sessionAffinityTimeoutSec, 600);
  assert.equal(api.externalTrafficPolicy, "Local");
  assert.deepEqual(api.loadBalancerSourceRanges, ["203.0.113.0/24"]);
  assert.equal(api.loadBalancerIP, "198.51.100.7");
  assert.equal((api.ports as Array<{ nodePort?: number }>)[0]!.nodePort, 30080);
  assert.equal(by("legacy-db").externalName, "db.corp.internal");
});

test("NS-1 거부: 네임스페이스 객체를 못 읽어도(403) 멈추지 않고 note 만, 허용 목록 밖 라벨은 항목에 없음", async () => {
  const { exec } = fakeExec(tables({ ns: { code: 1, err: "Error from server (Forbidden): namespaces is forbidden" } }));
  const r = await readK8sNamespace({ exec, env: {} }, []);
  assert.ok(r.notes.some((n) => n.includes("Namespace") && n.includes("Forbidden")));
  assert.equal(r.items.filter((i) => i.kind === "k8s.namespace").length, 0);
  const { exec: e2 } = fakeExec(tables());
  const r2 = await readK8sNamespace({ exec: e2, env: {} }, []);
  assert.deepEqual(r2.items.find((i) => i.kind === "k8s.namespace")?.metadata, { name: NS }, "kubernetes.io/metadata.name 같은 기본 라벨은 안 옮김");
});

test("JB-1: 일회성 Job 은 이름·상태 개수만 읽고, CronJob 이 만든 Job 은 뺀다", async () => {
  const jobs = [{ metadata: { name: "seed", namespace: NS, annotations: { x: "JOB-ANN" } }, spec: { template: { spec: { containers: [{ name: "s", image: "x", env: [{ name: "P", value: "JOB-SECRET" }] }] } } }, status: { active: 1 } },
    { metadata: { name: "cleanup-1", namespace: NS, ownerReferences: [{ kind: "CronJob", name: "cleanup" }] }, status: { succeeded: 1 } }];
  const { exec } = fakeExec(tables({ jobs }));
  const r = await readK8sNamespace({ exec, env: {} }, []);
  const js = r.items.filter((i) => i.kind === "k8s.job");
  assert.deepEqual(js, [{ kind: "k8s.job", metadata: { name: "seed", namespace: NS }, status: { active: 1, succeeded: 0, failed: 0 } }]);
  assert.ok(!JSON.stringify(r.items).includes("JOB-SECRET"));
});
