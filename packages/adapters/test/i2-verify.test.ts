// 검증 I2: R4(허용 목록·감사 판)·R5 종류 상수·R6 세 클라우드·R7·R8 와 종류별 403. 클라우드 CLI 는 가짜 exec 로만 바꾼다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readK8sNamespace } from "../src/discover/k8s.js";
import { discoverAws, discoverForImport, discoverGcp, discoverOnprem, inventoryForAudit } from "../src/discover/index.js";
import { K8S_RAW_KINDS, DB_RAW_KINDS } from "../src/import/raw-k8s.js";
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
  metadata: { name: `${name}-1`, namespace: NS, labels },
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

const tables = (over: { pods?: unknown[]; hpa?: Reply; deps?: unknown[] } = {}): Array<[RegExp, Reply]> => [
  [/^kubectl get deployments/, { out: { items: over.deps ?? [dep("shop-web"), dep("shop-api", [{ name: "LOG", value: "PLAIN-ENV-VALUE" }, { name: "PW", valueFrom: { secretKeyRef: { name: "db", key: "password" } } }]), dep("shop-worker"),
    { metadata: { name: "coredns", namespace: "kube-system" }, spec: { template: { spec: { containers: [] } } } }] } }],
  [/^kubectl get services/, { out: { items: [{ metadata: { name: "shop-api", namespace: NS }, spec: { selector: { app: "shop-api" }, ports: [{ port: 80, targetPort: 8080 }] },
    status: { loadBalancer: { ingress: [{ hostname: "lb.example.com" }] } } }] } }],
  [/^kubectl get ingresses/, { out: { items: [{ metadata: { name: "shop", namespace: NS, annotations: { a: "b" } }, spec: { rules: [{ host: "shop.example.com", http: { paths: [{ path: "/", backend: { service: { name: "shop-api", port: { number: 80 } } } }] } }] } }] } }],
  [/^kubectl get horizontalpodautoscalers/, over.hpa ?? { out: { items: [{ metadata: { name: "shop-api", namespace: NS }, spec: { scaleTargetRef: { kind: "Deployment", name: "shop-api" }, minReplicas: 2, maxReplicas: 6 } }] } }],
  [/^kubectl get cronjobs/, { out: { items: [cron] } }],
  [/^kubectl get networkpolicies/, { out: { items: [] } }],
  [/^kubectl get serviceaccounts/, { out: { items: [{ metadata: { name: "shop-api", namespace: NS, annotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::000000000000:role/x" } } }] } }],
  [/^kubectl get configmaps/, { out: { items: [{ metadata: { name: "shop-cfg", namespace: NS }, data: { LEVEL: "CM-SECRET-VALUE", MODE: "x" } }] } }],
  [/^kubectl api-resources/, { out: "" }],   // PF-A3: 종류 목록 (못 읽으면 unread.APIResources)
  [/^kubectl get nodes/, { out: { items: [] } }],   // A-1: 노드 CPU 종류 (빈 목록 = 못 읽은 게 아님)
  [/^kubectl get (persistentvolumeclaims|poddisruptionbudgets|roles|rolebindings|clusterrolebindings|replicasets) /, { out: { items: [] } }],   // N4·N5·T3: 빈 목록
  [/^kubectl get pods/, { out: { items: over.pods ?? [pod("shop-web", { app: "shop-web" }), pod("shop-api", { app: "shop-api" }), pod("shop-worker", { app: "shop-worker" }), CRON_POD] } }],
  // D6: StatefulSet·DaemonSet (digest 는 이미지에 박아 둠 → Pod 없어도 됨)
  [/^kubectl get statefulsets/, { out: { items: [{ metadata: { name: "shop-kv", namespace: NS }, spec: { replicas: 3, serviceName: "shop-kv", selector: { matchLabels: { app: "shop-kv" } },
    template: { metadata: { labels: { app: "shop-kv" } }, spec: { containers: [{ name: "kv", image: `ghcr.io/demo/kv@${D}`, volumeMounts: [{ name: "data", mountPath: "/data" }] }] } },
    volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], storageClassName: "gp3", resources: { requests: { storage: "10Gi" } } } }] } }] } }],
  [/^kubectl get daemonsets/, { out: { items: [{ metadata: { name: "log-agent", namespace: NS }, spec: { selector: { matchLabels: { app: "log-agent" } },
    template: { metadata: { labels: { app: "log-agent" } }, spec: { containers: [{ name: "agent", image: `ghcr.io/demo/agent@${D}` }] } } }, status: { desiredNumberScheduled: 2 } }] } }],
  // JB-1: 일회성 Job 하나 + CronJob 이 만든 Job 하나(빠져야 함)
  [/^kubectl get jobs/, { out: { items: [{ metadata: { name: "migrate-once", namespace: NS }, status: { succeeded: 1 } },
    { metadata: { name: "cleanup-28000000", namespace: NS, ownerReferences: [{ kind: "CronJob", name: "cleanup" }] }, status: { active: 1 } }] } }],
  // NS-1: 허용 목록 키만 (pod-security·istio-injection·linkerd) 옮겨지고 나머지 라벨·annotation 은 버려진다
  [/^kubectl get namespace /, { out: { metadata: { name: NS, labels: { "pod-security.kubernetes.io/enforce": "baseline", "istio-injection": "enabled", "team": "NS-LABEL-LEAK" },
    annotations: { "linkerd.io/inject": "disabled", "owner/contact": "NS-ANN-LEAK" } } } }],
];


const LAST = "kubectl.kubernetes.io/last-applied-configuration";
const ANN = { [LAST]: '{"env":[{"name":"X","value":"LAST-APPLIED-SECRET"}]}', "x/y": "ANN-SECRET" };
// 모든 종류의 응답에 annotations·ownerReferences 를 박는다 (읽는 쪽이 허용 목록으로만 옮기는지 본다)
function annotated(t: Array<[RegExp, Reply]>): Array<[RegExp, Reply]> {
  return t.map(([re, r]) => {
    const o = r.out as { items?: Array<{ metadata?: Record<string, unknown> }> } | undefined;
    if (!o?.items) return [re, r];
    return [re, { ...r, out: { items: o.items.map((i) => ({ ...i, metadata: { ...i.metadata, annotations: ANN, ownerReferences: [{ kind: "ReplicaSet", name: "OWNER-LEAK" }], managedFields: [{ manager: "MANAGED-LEAK" }] } })) } }];
  });
}

test("R4: 모든 종류에 annotations·ownerReferences·managedFields 가 있어도 원본에는 하나도 안 옮겨진다 (Pod 항목도 없음)", async () => {
  const r = await readK8sNamespace({ exec: fakeExec(annotated(tables())).exec, env: {} }, []);
  const s = JSON.stringify(r.items);
  for (const leak of ["LAST-APPLIED-SECRET", "ANN-SECRET", "OWNER-LEAK", "MANAGED-LEAK", "last-applied", "managedFields", "ownerReferences", "NS-LABEL-LEAK", "NS-ANN-LEAK"])
    assert.ok(!s.includes(leak), leak);
  // annotations 칸은 네임스페이스 항목에만 (허용 목록 키)
  for (const i of r.items) if (i.kind !== "k8s.namespace") assert.ok(!JSON.stringify(i).includes("annotations"), `${i.kind} annotations`);
  const nsItem = r.items.find((i) => i.kind === "k8s.namespace") as { metadata: { labels?: Record<string, string>; annotations?: Record<string, string> } } | undefined;
  assert.deepEqual(nsItem?.metadata.labels, { "pod-security.kubernetes.io/enforce": "baseline", "istio-injection": "enabled" });
  assert.deepEqual(nsItem?.metadata.annotations, { "linkerd.io/inject": "disabled" });
  assert.ok(!r.items.some((i) => (i.kind as string) === "k8s.pod"), "Pod 항목 없음");
  assert.equal(r.counts["k8s.pod"], 4, "Pod 는 개수만");
  const kinds = new Set(r.items.map((i) => i.kind));
  // N4·N5·T3·N12 종류(pvc·pdb·role·roleBinding·clusterRoleBinding·crdObject)는 이 가짜 표에 응답이 없음 → 안 나옴. unread 는 실패 때만
  const NEW = new Set(["k8s.networkPolicy", "k8s.pvc", "k8s.pdb", "k8s.role", "k8s.roleBinding", "k8s.clusterRoleBinding", "k8s.crdObject", "k8s.unread", "k8s.gateway", "k8s.httpRoute", "k8s.grpcRoute", "k8s.externalSecret", "k8s.secretStore"]);
  for (const k of Object.values(K8S_RAW_KINDS)) if (!NEW.has(k)) assert.ok(kinds.has(k), `${k} 항목이 나옴`);
});

test("R4 감사 판: 멱등(두 번 해도 같음)·입력 불변·값이 없는 종류는 그대로·deployment 의 configMapKeyRef 도 이름만", async () => {
  const r = await readK8sNamespace({ exec: fakeExec(tables()).exec, env: {} }, []);
  const inv = { provider: "onprem" as const, coverage: r.counts, items: r.items as unknown as Record<string, unknown>[] };
  const before = JSON.stringify(inv);
  const a = inventoryForAudit(inv as never), b = inventoryForAudit(a);
  assert.equal(JSON.stringify(inv), before, "입력 불변");
  assert.deepEqual(a, b, "멱등");
  const keep = (k: string) => JSON.stringify(inv.items.filter((i) => i.kind === k)) === JSON.stringify(a.items.filter((i) => (i as { kind: string }).kind === k));
  for (const k of ["k8s.service", "k8s.ingress", "k8s.hpa", "k8s.serviceAccount"]) assert.ok(keep(k), `${k} 그대로`);
  // N3: ConfigMap 은 원본엔 값이 있고 감사 판엔 키 이름만
  const cmA = a.items.find((i) => (i as { kind: string }).kind === "k8s.configMapKeys") as Record<string, unknown>;
  assert.equal(cmA.data, undefined, "감사 판엔 ConfigMap 값 없음");
  assert.deepEqual(cmA.keys, ["LEVEL", "MODE"]);
  for (const d of a.items.filter((i) => (i as { kind: string }).kind === "k8s.deployment") as Array<{ spec: { template: { spec: { containers: Array<Record<string, unknown>> } } } }>)
    for (const c of d.spec.template.spec.containers) { assert.equal(c.command, undefined); assert.equal(c.args, undefined); }
});

test("R5: 종류 문자열 상수가 계획과 한 글자도 다르지 않다", () => {
  assert.deepEqual(K8S_RAW_KINDS, { deployment: "k8s.deployment", service: "k8s.service", ingress: "k8s.ingress", hpa: "k8s.hpa", cronjob: "k8s.cronjob",
    networkPolicy: "k8s.networkPolicy", serviceAccount: "k8s.serviceAccount", configMapKeys: "k8s.configMapKeys",
    pvc: "k8s.pvc", pdb: "k8s.pdb", role: "k8s.role", roleBinding: "k8s.roleBinding", clusterRoleBinding: "k8s.clusterRoleBinding", crdObject: "k8s.crdObject", unread: "k8s.unread",

    statefulset: "k8s.statefulset", daemonset: "k8s.daemonset", namespace: "k8s.namespace", job: "k8s.job",
    gateway: "k8s.gateway", httpRoute: "k8s.httpRoute", grpcRoute: "k8s.grpcRoute", externalSecret: "k8s.externalSecret", secretStore: "k8s.secretStore" });
  assert.deepEqual(DB_RAW_KINDS, { rds: "rds.dbInstance", cloudsql: "cloudsql.instance", cnpg: "cnpg.cluster" });
});

const FORBID = { code: 1, err: "Error from server (Forbidden): is forbidden: User cannot list resource" };
const KINDS: Array<[string, RegExp, string]> = [
  ["Service", /^kubectl get services/, "k8s.service"], ["Ingress", /^kubectl get ingresses/, "k8s.ingress"],
  ["HPA", /^kubectl get horizontalpodautoscalers/, "k8s.hpa"], ["CronJob", /^kubectl get cronjobs/, "k8s.cronjob"],
  ["NetworkPolicy", /^kubectl get networkpolicies/, "k8s.networkPolicy"], ["ServiceAccount", /^kubectl get serviceaccounts/, "k8s.serviceAccount"],
  ["ConfigMap", /^kubectl get configmaps/, "k8s.configMapKeys"], ["Pod", /^kubectl get pods/, ""],
  ["StatefulSet", /^kubectl get statefulsets/, "k8s.statefulset"], ["DaemonSet", /^kubectl get daemonsets/, "k8s.daemonset"],
  ["Namespace", /^kubectl get namespace /, "k8s.namespace"], ["Job", /^kubectl get jobs/, "k8s.job"],
];
// F-1: 핵심 종류(Service·Ingress·ConfigMap)는 못 읽으면 멈춘다. 나머지는 note + "못 읽음" 원본 줄(k8s.unread)
// PF-C-01: Pod 는 태그 이미지 digest 를 Pod 에서만 얻을 때 핵심 (이 표의 Deployment 는 태그 이미지) → 멈춘다
const CORE_KINDS = new Set(["Service", "Ingress", "ConfigMap", "Pod"]);
for (const [label, re, kind] of KINDS) {
  if (CORE_KINDS.has(label)) {
    test(`종류별 403 (F-1): 핵심 종류 ${label} 이 막히면 "다 읽은 것처럼" 내지 않고 멈춘다`, async () => {
      const t = tables().map(([r, x]) => (r.source === re.source ? [r, FORBID] : [r, x])) as Array<[RegExp, Reply]>;
      await assert.rejects(readK8sNamespace({ exec: fakeExec(t).exec, env: {} }, []), (e: Error) => /핵심 종류/.test(e.message) && e.message.includes(label));
    });
    continue;
  }
  test(`종류별 403: ${label} 만 막혀도 note + 못 읽음 줄만 남기고 나머지는 그대로 계속 간다`, async () => {
    const t = tables().map(([r, x]) => (r.source === re.source ? [r, FORBID] : [r, x])) as Array<[RegExp, Reply]>;
    const r = await readK8sNamespace({ exec: fakeExec(t).exec, env: {} }, []);
    assert.deepEqual(r.items.filter((i) => i.kind === "k8s.unread").map((i) => (i as { resource: string }).resource), [label], "F-1: 못 읽은 종류가 원본 줄로");
    assert.ok(r.notes.some((x) => x.includes(label) && x.includes("Forbidden")), `note: ${r.notes.join(" | ")}`);
    assert.equal(r.items.filter((i) => i.kind === "k8s.deployment").length, 3);
    if (kind) assert.equal(r.items.filter((i) => i.kind === kind).length, 0);
    if (label === "Pod") assert.ok(r.items.filter((i) => i.kind === "k8s.deployment").every((i) => i.kind === "k8s.deployment" && i.imageDigest === null));
  });
}

test("종류별 403: Deployment 목록이 막히면 멈춘다 (필수), 응답이 깨진 JSON 인 종류는 note 만 (핵심 종류면 멈춤, F-1)", async () => {
  const t = tables().map(([r, x]) => (/deployments/.test(r.source) ? [r, FORBID] : [r, x])) as Array<[RegExp, Reply]>;
  await assert.rejects(readK8sNamespace({ exec: fakeExec(t).exec, env: {} }, []), /Forbidden|실패/);
  const badOf = (re: RegExp): Exec => async (cmd, args) => re.test(`${cmd} ${args.join(" ")}`)
    ? { code: 0, stdout: "{not json", stderr: "", ms: 1 } : fakeExec(tables()).exec(cmd, args, {} as never);
  const r = await readK8sNamespace({ exec: badOf(/get horizontalpodautoscalers/), env: {} }, []);
  assert.ok(r.notes.some((x) => x.includes("HPA")));
  assert.equal(r.items.filter((i) => i.kind === "k8s.deployment").length, 3);
  await assert.rejects(readK8sNamespace({ exec: badOf(/get ingresses/), env: {} }, []), /핵심 종류.*Ingress/);
});

test("R6 AWS: EKS 에서도 네임스페이스 전체 + RDS 재료", async () => {
  const t = tables();
  t.unshift(
    [/^aws sts get-caller-identity/, { out: { Account: "123456789012" } }], [/^aws eks list-clusters/, { out: { clusters: ["c1"] } }],
    [/^aws eks describe-cluster/, { out: { cluster: { version: "1.30", resourcesVpcConfig: { vpcId: "vpc-1" } } } }], [/^aws eks update-kubeconfig/, { out: null }],
    [/^aws rds describe-db-instances/, { out: { DBInstances: [{ Engine: "postgres", DBInstanceIdentifier: "db1", MultiAZ: true, PubliclyAccessible: false, MaxAllocatedStorage: 100, DBInstanceArn: "arn:x" }] } }],
    [/^aws (ec2|elbv2|ecr|secretsmanager)/, { out: {} }],
  );
  const env = {};
  const v2 = await discoverAws({ exec: fakeExec(t).exec, env }, {});
  const k = (inv: { items: unknown[] }, kind: string) => inv.items.filter((i) => (i as { kind: string }).kind === kind);
  assert.equal(k(v2, "k8s.deployment").length, 3);
  const rds = k(v2, "rds.dbInstance")[0] as Record<string, unknown>;
  assert.equal(rds.MultiAZ, true); assert.equal(rds.PubliclyAccessible, false); assert.equal(rds.MaxAllocatedStorage, 100);
});

// G3b-3: discover 는 이제 CNPG 를 고르지 않고 전부 넘긴다 (앱 경계가 근거로 고름). 다른 네임스페이스 것이 이름순 앞이어도 앱 것을 잃지 않는다
test("R6 온프레: CNPG 가 앱과 같은 네임스페이스에 있으면 이름순 앞선 다른 네임스페이스 것 때문에 빠지지 않는다", async () => {
  const t = tables();
  t.unshift([/^kubectl get nodes/, { out: { items: [] } }]);
  t.push([/^kubectl get clusters.postgresql.cnpg.io/, { out: { items: [
    { metadata: { name: "a-db", namespace: "aaa" }, spec: { instances: 1 } }, { metadata: { name: "shop-db", namespace: NS }, spec: { instances: 3 } }] } }]);
  const inv = await discoverOnprem({ exec: fakeExec(t).exec, env: {} }, {});
  const dbs = inv.items.filter((i) => (i as { kind: string }).kind === "cnpg.cluster") as Array<{ metadata: { name: string } }>;
  assert.deepEqual(dbs.map((x) => x.metadata.name), ["a-db", "shop-db"]);
});

test("R8 discoverForImport: MOCK_SEED 가 \"1\" 아니면(0·빈 값) 진짜 읽기, 켜면 clone 없이 같은 객체", async () => {
  let called = 0;
  const exec: Exec = async () => { called++; return { code: 127, stdout: "", stderr: "not found", ms: 1 }; };
  for (const v of ["0", "", "true"]) await assert.rejects(discoverForImport("onprem", {}, { exec, env: { MOCK_SEED: v } }));
  assert.ok(called >= 3, "진짜 읽기 경로로 갔다");
  assert.equal(await discoverForImport("onprem", {}, { env: { MOCK_SEED: "1" } }), DEMO_INVENTORY.onprem);
});
