// Z88: 출발 환경 진짜 읽기 (discover). 클라우드 CLI 는 가짜 exec 로만 바꾼다 (이 파일 안에서만)
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverAws, discoverGcp, discoverOnprem, discoverSource, inventoryForAudit } from "../src/discover/index.js";
import { normalizeInventory } from "../src/common/normalize.js";
import { DEMO_SPEC } from "../src/common/fixtures.js";
import type { Exec } from "../src/terraform/real-runner.js";

const D = "sha256:" + "cd".repeat(32);
type Reply = { code?: number; out?: unknown; err?: string };
/** 명령 앞부분 → 응답. 부른 명령은 calls 에 남긴다 */
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const exec: Exec = async (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env });
    const line = `${cmd} ${args.join(" ")}`;
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    const r = hit[1];
    return { code: r.code ?? 0, stdout: typeof r.out === "string" ? r.out : JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
  return { exec, calls };
}

const k8s = (ns = "shop") => ({
  list: { items: [
    { kind: "Deployment", metadata: { name: "shop-api", namespace: ns }, spec: {
      replicas: 2, selector: { matchLabels: { app: "shop-api" } },
      template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{
        name: "api", image: "ghcr.io/demo/shop-api:1.4.2", ports: [{ containerPort: 8080 }],
        resources: { requests: { cpu: "500m", memory: "1Gi" } }, readinessProbe: { httpGet: { path: "/healthz" } },
        env: [{ name: "LOG_LEVEL", value: "info" },
              { name: "DATABASE_PASSWORD", valueFrom: { secretKeyRef: { name: "shop-db", key: "password" } } },
              { name: "FROM_CM", valueFrom: { configMapKeyRef: { name: "x", key: "y" } } }],
      }] } } } },
    { kind: "Deployment", metadata: { name: "coredns", namespace: "kube-system" }, spec: { replicas: 1, template: { spec: { containers: [{ name: "c", image: "x" }] } } } },
    { kind: "Service", metadata: { name: "shop-api", namespace: ns }, spec: { selector: { app: "shop-api" }, ports: [{ port: 80, targetPort: 8080 }] } },
    { kind: "Ingress", metadata: { name: "shop", namespace: ns }, spec: { rules: [{ host: "shop.softbank-team-iron.com",
      http: { paths: [{ backend: { service: { name: "shop-api" } } }] } }] } },
  ] },
  pods: { items: [{ metadata: { name: "shop-api-1", namespace: ns, labels: { app: "shop-api" } },
    status: { containerStatuses: [{ name: "api", imageID: `ghcr.io/demo/shop-api@${D}` }] } }] },
});

test("온프레: kubectl 로 앱·CNPG 를 읽어 normalize 까지 → 데모 값이 아니라 읽은 값", async () => {
  const c = k8s();
  const { exec, calls } = fakeExec([
    [/^kubectl get nodes/, { out: { items: [{ metadata: { name: "n1" }, status: { nodeInfo: { kubeletVersion: "v1.31.5+k3s1" }, allocatable: { cpu: "4", memory: "8Gi" } } }] } }],
    [/^kubectl get deployments,services,ingresses/, { out: c.list }],
    [/^kubectl get pods/, { out: c.pods }],
    [/^kubectl get clusters.postgresql.cnpg.io/, { out: { items: [{ metadata: { name: "shop-db", namespace: "shop" },
      spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:17.2", storage: { size: "5Gi" }, instances: 1 } }] } }],
  ]);
  const inv = await discoverOnprem({ exec, env: { ONPREM_KUBE_CONTEXT: "k3d-test" } });
  assert.ok(calls.every((x) => x.args.includes("--context") && x.args.includes("k3d-test")), "모든 kubectl 이 지정 context");
  assert.ok(calls.every((x) => x.args[0] === "get"), "읽기(get)만");
  const { spec, fieldMeta } = normalizeInventory(inv, DEMO_SPEC);
  assert.equal(spec.app?.name, "shop-api");
  assert.equal(spec.service?.image, `ghcr.io/demo/shop-api@${D}`);
  assert.equal(spec.ingress?.hostname, "shop.softbank-team-iron.com");
  assert.equal(spec.database?.majorVersion, "17");
  assert.equal(spec.database?.storageGb, 5);
  assert.deepEqual(spec.service?.secretRefs, [{ name: "DATABASE_PASSWORD", key: "password" }]);
  assert.notEqual(fieldMeta["service.image"]?.source, "fixture");
  assert.equal(inv.coverage["k8s.deployment"], 1, "kube-system 은 뺀다");
  assert.ok(inv.items.some((i) => (i as { kind: string; text?: string }).text?.includes("configMap")), "뺀 환경변수는 메모로");
});

test("온프레: 클러스터에 안 닿으면 데모 대신 SOURCE_UNAVAILABLE", async () => {
  const { exec } = fakeExec([[/^kubectl get nodes/, { code: 1, err: "The connection to the server 127.0.0.1:6443 was refused" }]]);
  await assert.rejects(discoverOnprem({ exec, env: {} }), (e: { code?: string; message: string }) =>
    e.code === "SOURCE_UNAVAILABLE" && /k3d-onprem/.test(e.message) && /refused/.test(e.message));
});

test("kubectl 이 없으면(127) 이유에 '명령이 없음'", async () => {
  const { exec } = fakeExec([[/^kubectl/, { code: 127, err: "spawn kubectl ENOENT" }]]);
  await assert.rejects(discoverOnprem({ exec, env: {} }), /kubectl 명령이 없음/);
});

test("실행 중 Pod 가 없으면 digest 를 지어내지 않고 SOURCE_INCOMPLETE", async () => {
  const c = k8s();
  const { exec } = fakeExec([
    [/^kubectl get nodes/, { out: { items: [] } }],
    [/^kubectl get deployments/, { out: c.list }],
    [/^kubectl get pods/, { out: { items: [] } }],
  ]);
  await assert.rejects(discoverOnprem({ exec, env: {} }), (e: { code?: string }) => e.code === "SOURCE_INCOMPLETE");
});

test("AWS: sts → EKS(임시 kubeconfig) → RDS·VPC·ALB·ECR·시크릿 이름. 시크릿 값·쓰기 명령 없음", async () => {
  const c = k8s();
  const { exec, calls } = fakeExec([
    [/^aws sts get-caller-identity/, { out: { Account: "111122223333" } }],
    [/^aws eks list-clusters/, { out: { clusters: ["finals-eks"] } }],
    [/^aws eks describe-cluster/, { out: { cluster: { version: "1.31", resourcesVpcConfig: { vpcId: "vpc-1" } } } }],
    [/^aws eks update-kubeconfig/, { out: "Added new context arn:aws:eks:... to /tmp/x" }],
    [/^kubectl get deployments/, { out: c.list }],
    [/^kubectl get pods/, { out: c.pods }],
    [/^aws rds describe-db-instances/, { out: { DBInstances: [
      { DBInstanceIdentifier: "other-mysql", Engine: "mysql", EngineVersion: "8.0", AllocatedStorage: 20 },
      { DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.4", AllocatedStorage: 30, DBInstanceClass: "db.t4g.micro" }] } }],
    [/^aws ec2 describe-vpcs/, { out: { Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16" }] } }],
    [/^aws elbv2 describe-load-balancers/, { code: 254, err: "AccessDenied: elasticloadbalancing:DescribeLoadBalancers" }],
    [/^aws ecr describe-repositories/, { out: { repositories: [{ repositoryName: "shop-api" }] } }],
    [/^aws secretsmanager list-secrets/, { out: { SecretList: [{ Name: "shop-db", SecretString: "절대-안-옮김" }] } }],
  ]);
  const inv = await discoverAws({ exec, env: { AWS_REGION: "ap-northeast-2", AWS_PROFILE: "finals" } });
  const lines = calls.map((x) => `${x.cmd} ${x.args.join(" ")}`);
  assert.ok(!lines.some((l) => / (get-secret-value|create-[a-z-]+|delete-[a-z-]+|put-[a-z-]+|update-(?!kubeconfig)[a-z-]+) /.test(l)), lines.join("\n"));
  const kc = calls.find((x) => x.args[1] === "update-kubeconfig")!.args;
  assert.match(kc[kc.indexOf("--kubeconfig") + 1]!, /svc-import-/, "kubeconfig 는 임시 파일에만");
  assert.ok(!JSON.stringify(inv).includes("절대-안-옮김"), "시크릿 값은 원본에 없음");
  assert.ok(!JSON.stringify(inv).includes("111122223333") && JSON.stringify(inv).includes("••••3333"), "Z104 03: 계정 번호는 끝 4자리만");
  const { spec } = normalizeInventory(inv, DEMO_SPEC);
  assert.equal(spec.database?.majorVersion, "16");
  assert.equal(spec.database?.storageGb, 30);
  assert.equal(inv.coverage["aws.ecr"], 1);
  assert.ok(inv.items.some((i) => /ALB 못 읽음/.test(String((i as { text?: string }).text))), "둘레 자원 실패는 메모, 멈추지 않음");
});

test("AWS: 자격이 없으면 SOURCE_UNAVAILABLE (데모 원본 없음)", async () => {
  const { exec, calls } = fakeExec([[/^aws sts/, { code: 255, err: "Unable to locate credentials" }]]);
  await assert.rejects(discoverAws({ exec, env: {} }), /AWS 자격 없음.*Unable to locate credentials/);
  assert.equal(calls.length, 1, "자격 확인에서 멈춤");
});

test("AWS: EKS 클러스터가 없으면 SOURCE_INCOMPLETE", async () => {
  const { exec } = fakeExec([[/^aws sts/, { out: { Account: "1" } }], [/^aws eks list-clusters/, { out: { clusters: [] } }]]);
  await assert.rejects(discoverAws({ exec, env: {} }), (e: { code?: string }) => e.code === "SOURCE_INCOMPLETE");
});

test("GCP: 프로젝트 → GKE(KUBECONFIG 임시) → Cloud SQL → normalize", async () => {
  const c = k8s();
  const { exec, calls } = fakeExec([
    [/^gcloud projects describe finals-demo/, { out: { projectId: "finals-demo" } }],
    [/^gcloud container clusters list/, { out: [{ name: "finals-gke", location: "asia-northeast3", currentMasterVersion: "1.31.4-gke.1" }] }],
    [/^gcloud container clusters get-credentials finals-gke --location asia-northeast3/, { out: "kubeconfig entry generated" }],
    [/^kubectl get deployments/, { out: c.list }],
    [/^kubectl get pods/, { out: c.pods }],
    [/^gcloud sql instances list/, { out: [{ name: "shop-db", databaseVersion: "POSTGRES_16", settings: { dataDiskSizeGb: "10", tier: "db-f1-micro" } }] }],
    [/^gcloud compute networks list/, { out: [{ name: "default" }] }],
    [/^gcloud compute forwarding-rules list/, { out: [] }],
    [/^gcloud artifacts repositories list/, { out: [{ name: "projects/p/locations/l/repositories/apps", format: "DOCKER" }] }],
    [/^gcloud secrets list/, { out: [{ name: "projects/p/secrets/shop-db" }] }],
  ]);
  const inv = await discoverGcp({ exec, env: { GCP_PROJECT: "finals-demo" } });
  const cred = calls.find((x) => x.args.includes("get-credentials"))!;
  assert.match(String(cred.env.KUBECONFIG), /svc-import-/, "사용자 ~/.kube/config 를 안 건드림");
  const kube = calls.filter((x) => x.cmd === "kubectl");
  assert.ok(kube.every((x) => x.args.includes("--kubeconfig")));
  const { spec } = normalizeInventory(inv, DEMO_SPEC);
  assert.equal(spec.database?.majorVersion, "16");
  assert.equal(inv.coverage["gcp.artifactRepo"], 1);
});

test("GCP: 프로젝트를 못 정하면 SOURCE_UNAVAILABLE", async () => {
  const { exec } = fakeExec([[/^gcloud config get-value project/, { out: "(unset)" }]]);
  await assert.rejects(discoverGcp({ exec, env: {} }), /GCP 프로젝트가 정해지지 않음/);
});

test("Azure Mock 은 출발 실자원이 없다 → SOURCE_UNAVAILABLE", async () => {
  await assert.rejects(discoverSource("azure_mock", {}), (e: { code?: string }) => e.code === "SOURCE_UNAVAILABLE");
});

test("IMPORT_APP·IMPORT_NAMESPACE 로 고른다, 없는 이름이면 INCOMPLETE", async () => {
  const c = k8s("prod");
  const { exec } = fakeExec([
    [/^kubectl get nodes/, { out: { items: [] } }],
    [/^kubectl get deployments/, { out: c.list }],
    [/^kubectl get pods/, { out: c.pods }],
    [/^kubectl get clusters/, { code: 1, err: "error: the server doesn't have a resource type \"clusters\"" }],
  ]);
  const inv = await discoverOnprem({ exec, env: { IMPORT_NAMESPACE: "prod", IMPORT_APP: "shop-api" } });
  assert.equal(normalizeInventory(inv, DEMO_SPEC).spec.database, undefined, "CNPG 없으면 DB 없이");
  await assert.rejects(discoverOnprem({ exec, env: { IMPORT_APP: "nope" } }), /Deployment nope 없음/);
});

test("감사용 판: 환경변수 값은 빼고 이름만 (원본은 그대로)", async () => {
  const c = k8s();
  const { exec } = fakeExec([
    [/^kubectl get nodes/, { out: { items: [] } }],
    [/^kubectl get deployments/, { out: c.list }],
    [/^kubectl get pods/, { out: c.pods }],
    [/^kubectl get clusters/, { out: { items: [] } }],
  ]);
  const inv = await discoverOnprem({ exec, env: {} });
  const audit = inventoryForAudit(inv);
  const s = JSON.stringify(audit);
  assert.ok(!s.includes("\"info\""), "LOG_LEVEL 값 없음");
  assert.ok(!s.includes("secretKeyRef"), "참조 모양도 없음");
  assert.ok(s.includes("LOG_LEVEL") && s.includes("DATABASE_PASSWORD"), "이름은 남김");
  assert.ok(JSON.stringify(inv).includes("\"info\""), "원본(명세 재료)은 안 바뀜");
});
