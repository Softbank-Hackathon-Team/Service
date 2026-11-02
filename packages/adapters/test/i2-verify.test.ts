// 검증 I2: R4(허용 목록·감사 판)·R5 종류 상수·R6 세 클라우드·R7·R8 와 종류별 403. 클라우드 CLI 는 가짜 exec 로만 바꾼다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readK8sNamespace } from "../src/discover/k8s.js";
import { discoverAws, discoverForImport, discoverGcp, discoverOnprem, inventoryForAudit } from "../src/discover/index.js";
import { K8S_RAW_KINDS, DB_RAW_KINDS } from "../src/import/raw-k8s.js";
import { DEMO_INVENTORY, DEMO_INVENTORY_V2 } from "../src/common/fixtures.js";
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
  [/^kubectl get pods/, { out: { items: over.pods ?? [pod("shop-web", { app: "shop-web" }), pod("shop-api", { app: "shop-api" }), pod("shop-worker", { app: "shop-worker" }), CRON_POD] } }],
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
  for (const leak of ["LAST-APPLIED-SECRET", "ANN-SECRET", "OWNER-LEAK", "MANAGED-LEAK", "annotations", "last-applied", "managedFields", "ownerReferences"])
    assert.ok(!s.includes(leak), leak);
  assert.ok(!r.items.some((i) => (i.kind as string) === "k8s.pod"), "Pod 항목 없음");
  assert.equal(r.counts["k8s.pod"], 4, "Pod 는 개수만");
  const kinds = new Set(r.items.map((i) => i.kind));
  for (const k of Object.values(K8S_RAW_KINDS)) if (k !== "k8s.networkPolicy") assert.ok(kinds.has(k), `${k} 항목이 나옴`);
});

test("R4 감사 판: 멱등(두 번 해도 같음)·입력 불변·값이 없는 종류는 그대로·deployment 의 configMapKeyRef 도 이름만", async () => {
  const r = await readK8sNamespace({ exec: fakeExec(tables()).exec, env: {} }, []);
  const inv = { provider: "onprem" as const, coverage: r.counts, items: r.items as unknown as Record<string, unknown>[] };
  const before = JSON.stringify(inv);
  const a = inventoryForAudit(inv as never), b = inventoryForAudit(a);
  assert.equal(JSON.stringify(inv), before, "입력 불변");
  assert.deepEqual(a, b, "멱등");
  const keep = (k: string) => JSON.stringify(inv.items.filter((i) => i.kind === k)) === JSON.stringify(a.items.filter((i) => (i as { kind: string }).kind === k));
  for (const k of ["k8s.service", "k8s.ingress", "k8s.hpa", "k8s.serviceAccount", "k8s.configMapKeys"]) assert.ok(keep(k), `${k} 그대로`);
  for (const d of a.items.filter((i) => (i as { kind: string }).kind === "k8s.deployment") as Array<{ spec: { template: { spec: { containers: Array<Record<string, unknown>> } } } }>)
    for (const c of d.spec.template.spec.containers) { assert.equal(c.command, undefined); assert.equal(c.args, undefined); }
});

test("R5: 종류 문자열 상수가 계획과 한 글자도 다르지 않다", () => {
  assert.deepEqual(K8S_RAW_KINDS, { deployment: "k8s.deployment", service: "k8s.service", ingress: "k8s.ingress", hpa: "k8s.hpa", cronjob: "k8s.cronjob",
    networkPolicy: "k8s.networkPolicy", serviceAccount: "k8s.serviceAccount", configMapKeys: "k8s.configMapKeys" });
  assert.deepEqual(DB_RAW_KINDS, { rds: "rds.dbInstance", cloudsql: "cloudsql.instance", cnpg: "cnpg.cluster" });
});

const FORBID = { code: 1, err: "Error from server (Forbidden): is forbidden: User cannot list resource" };
const KINDS: Array<[string, RegExp, string]> = [
  ["Service", /^kubectl get services/, "k8s.service"], ["Ingress", /^kubectl get ingresses/, "k8s.ingress"],
  ["HPA", /^kubectl get horizontalpodautoscalers/, "k8s.hpa"], ["CronJob", /^kubectl get cronjobs/, "k8s.cronjob"],
  ["NetworkPolicy", /^kubectl get networkpolicies/, "k8s.networkPolicy"], ["ServiceAccount", /^kubectl get serviceaccounts/, "k8s.serviceAccount"],
  ["ConfigMap", /^kubectl get configmaps/, "k8s.configMapKeys"], ["Pod", /^kubectl get pods/, ""],
];
for (const [label, re, kind] of KINDS) {
  test(`종류별 403: ${label} 만 막혀도 note 만 남기고 나머지는 그대로 계속 간다`, async () => {
    const t = tables().map(([r, x]) => (r.source === re.source ? [r, FORBID] : [r, x])) as Array<[RegExp, Reply]>;
    const r = await readK8sNamespace({ exec: fakeExec(t).exec, env: {} }, []);
    assert.ok(r.notes.some((x) => x.includes(label) && x.includes("Forbidden")), `note: ${r.notes.join(" | ")}`);
    assert.equal(r.items.filter((i) => i.kind === "k8s.deployment").length, 3);
    if (kind) assert.equal(r.items.filter((i) => i.kind === kind).length, 0);
    if (label === "Pod") assert.ok(r.items.filter((i) => i.kind === "k8s.deployment").every((i) => i.kind === "k8s.deployment" && i.imageDigest === null));
  });
}

test("종류별 403: Deployment 목록이 막히면 멈춘다 (필수), 응답이 깨진 JSON 인 종류는 note 만", async () => {
  const t = tables().map(([r, x]) => (/deployments/.test(r.source) ? [r, FORBID] : [r, x])) as Array<[RegExp, Reply]>;
  await assert.rejects(readK8sNamespace({ exec: fakeExec(t).exec, env: {} }, []), /Forbidden|실패/);
  const bad: Exec = async (cmd, args) => /get ingresses/.test(`${cmd} ${args.join(" ")}`)
    ? { code: 0, stdout: "{not json", stderr: "", ms: 1 } : fakeExec(tables()).exec(cmd, args, {} as never);
  const r = await readK8sNamespace({ exec: bad, env: {} }, []);
  assert.ok(r.notes.some((x) => x.includes("Ingress")));
  assert.equal(r.items.filter((i) => i.kind === "k8s.deployment").length, 3);
});

test("R6 AWS: ir=v2 이면 EKS 에서도 네임스페이스 전체 + RDS 재료, ir 없으면 앱 하나 (IMPORT_IR 환경변수는 안 읽음)", async () => {
  const t = tables();
  t.unshift(
    [/^aws sts get-caller-identity/, { out: { Account: "123456789012" } }], [/^aws eks list-clusters/, { out: { clusters: ["c1"] } }],
    [/^aws eks describe-cluster/, { out: { cluster: { version: "1.30", resourcesVpcConfig: { vpcId: "vpc-1" } } } }], [/^aws eks update-kubeconfig/, { out: null }],
    [/^aws rds describe-db-instances/, { out: { DBInstances: [{ Engine: "postgres", DBInstanceIdentifier: "db1", MultiAZ: true, PubliclyAccessible: false, MaxAllocatedStorage: 100, DBInstanceArn: "arn:x" }] } }],
    [/^aws (ec2|elbv2|ecr|secretsmanager)/, { out: {} }],
  );
  const env = { IMPORT_IR: "v2" };
  const v2 = await discoverAws({ exec: fakeExec(t).exec, env }, { ir: "v2" });
  const k = (inv: { items: unknown[] }, kind: string) => inv.items.filter((i) => (i as { kind: string }).kind === kind);
  assert.equal(k(v2, "k8s.deployment").length, 3);
  const rds = k(v2, "rds.dbInstance")[0] as Record<string, unknown>;
  assert.equal(rds.MultiAZ, true); assert.equal(rds.PubliclyAccessible, false); assert.equal(rds.MaxAllocatedStorage, 100);
  const t1 = [...t];   // v1 은 `get deployments,services,ingresses -A` 한 번 (항목에 kind 가 있어야 한다)
  t1.unshift([/^kubectl get deployments,services,ingresses/, { out: { items: [
    { kind: "Deployment", metadata: { name: "shop-api", namespace: NS }, spec: { replicas: 2, selector: { matchLabels: { app: "shop-api" } }, template: { spec: { containers: [container("shop-api")] } } } }] } }]);
  const v1 = await discoverAws({ exec: fakeExec(t1).exec, env }, {});
  assert.equal(k(v1, "k8s.deployment").length, 1, "ir 옵션 없으면 IMPORT_IR=v2 환경변수가 있어도 v1");
  assert.equal((k(v1, "rds.dbInstance")[0] as Record<string, unknown>).MultiAZ, undefined, "v1 은 새 칸 없음");
});

test("R6 온프레: CNPG 가 앱과 같은 네임스페이스에 있으면 이름순 앞선 다른 네임스페이스 것보다 먼저 고른다", async () => {
  const t = tables();
  t.unshift([/^kubectl get nodes/, { out: { items: [] } }]);
  t.push([/^kubectl get clusters.postgresql.cnpg.io/, { out: { items: [
    { metadata: { name: "a-db", namespace: "aaa" }, spec: { instances: 1 } }, { metadata: { name: "shop-db", namespace: NS }, spec: { instances: 3 } }] } }]);
  const inv = await discoverOnprem({ exec: fakeExec(t).exec, env: {} }, { ir: "v2" });
  const db = inv.items.find((i) => (i as { kind: string }).kind === "cnpg.cluster") as { metadata: { name: string } };
  assert.equal(db.metadata.name, "shop-db");
});

test("R8 discoverForImport: MOCK_SEED 가 \"1\" 아니면(0·빈 값) 진짜 읽기, 켜면 clone 없이 같은 객체, 환경변수 IMPORT_IR 은 무시", async () => {
  let called = 0;
  const exec: Exec = async () => { called++; return { code: 127, stdout: "", stderr: "not found", ms: 1 }; };
  for (const v of ["0", "", "true"]) await assert.rejects(discoverForImport("onprem", { ir: "v2" }, { exec, env: { MOCK_SEED: v } }));
  assert.ok(called >= 3, "진짜 읽기 경로로 갔다");
  assert.equal(await discoverForImport("onprem", {}, { env: { MOCK_SEED: "1", IMPORT_IR: "v2" } }), DEMO_INVENTORY.onprem, "IMPORT_IR 은 adapters 가 안 읽음");
  assert.equal(await discoverForImport("onprem", { ir: "v2" }, { env: { MOCK_SEED: "1" } }), DEMO_INVENTORY_V2.onprem);
});
