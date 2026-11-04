// Z88: 출발 환경 진짜 읽기 (discover). 클라우드 CLI 는 가짜 exec 로만 바꾼다 (이 파일 안에서만)
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverAws, discoverGcp, discoverOnprem, discoverSource, inventoryForAudit } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import type { AppSpecV2, RawInventory } from "@svc/contracts";
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
    // 종류별 목록 읽기 중 표에 없는 종류는 빈 목록 (그 종류가 클러스터에 없음)
    if (!hit && /^kubectl get [a-z0-9.]+ (-n|-A)/.test(line)) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "", ms: 1 };
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    const r = hit[1];
    return { code: r.code ?? 0, stdout: typeof r.out === "string" ? r.out : JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
  return { exec, calls };
}

// 종류별 목록 (kubectl get deployments / services / ingresses 를 따로 부른다)
const lists = (c: { list: { items: Array<{ kind: string }> } }): Array<[RegExp, Reply]> =>
  ([["Deployment", "deployments"], ["Service", "services"], ["Ingress", "ingresses"]] as const)
    .map(([k, r]) => [new RegExp(`^kubectl get ${r} `), { out: { items: c.list.items.filter((i) => i.kind === k) } }]);
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

// 읽은 원본 → 명세. 주 서비스와 첫 postgres 를 꺼낸다
const read = (inv: RawInventory) => {
  const r = normalizeV2(inv).result;
  const props = (k: string, id?: string) => (r.spec.components.find((c) => c.kind === k && (!id || c.id === id)) as { props: Record<string, any> } | undefined)?.props;
  return { spec: r.spec as AppSpecV2, fieldMeta: r.fieldMeta, svc: props("service", "shop-api"), pg: props("postgres") };
};

test("온프레: kubectl 로 앱·CNPG 를 읽어 명세까지 → 데모 값이 아니라 읽은 값", async () => {
  const c = k8s();
  const { exec, calls } = fakeExec([
    [/^kubectl get nodes/, { out: { items: [{ metadata: { name: "n1" }, status: { nodeInfo: { kubeletVersion: "v1.31.5+k3s1" }, allocatable: { cpu: "4", memory: "8Gi" } } }] } }],
    ...lists(c),
    [/^kubectl get pods/, { out: c.pods }],
    [/^kubectl get clusters.postgresql.cnpg.io/, { out: { items: [{ metadata: { name: "shop-db", namespace: "shop" },
      spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:17.2", storage: { size: "5Gi" }, instances: 1 } }] } }],
  ]);
  const inv = await discoverOnprem({ exec, env: { ONPREM_KUBE_CONTEXT: "k3d-test" } });
  assert.ok(calls.every((x) => x.args.includes("--context") && x.args.includes("k3d-test")), "모든 kubectl 이 지정 context");
  // N12: CRD 종류 목록(api-resources)도 읽기 명령 (기준본부터 이 줄이 get 만 허용해 깨져 있었음)
  const READ_VERBS = ["get", "api-resources"];
  assert.ok(calls.every((x) => READ_VERBS.includes(x.args[0]!)), "읽기(get·api-resources)만: " + calls.filter((x) => !READ_VERBS.includes(x.args[0]!)).map((x) => x.args.join(" ")).join(" | "));
  const { spec, svc, pg } = read(inv);
  assert.equal(spec.app.name, "shop-api");
  assert.equal(svc?.image.digest, D);
  assert.equal(spec.entry?.hosts[0]?.hostnames[0], "shop.softbank-team-iron.com");
  assert.equal(pg?.majorVersion, "17");
  assert.equal(pg?.storageGb, 5);
  assert.ok(svc?.env.some((e: { name: string; fromSecret?: unknown }) => e.name === "DATABASE_PASSWORD" && e.fromSecret), "비밀 참조는 이름만");
  assert.equal(inv.coverage["k8s.deployment"], 1, "kube-system 은 뺀다");
  assert.ok(svc?.env.some((e: { name: string; fromConfig?: unknown }) => e.name === "FROM_CM" && e.fromConfig), "ConfigMap 참조 env 는 이름 참조로 남는다");
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

test("실행 중 Pod 가 없으면 digest 를 지어내지 않는다: 그 Deployment 는 명세 리소스가 아니라 unmapped", async () => {
  const c = k8s();
  const { exec } = fakeExec([
    [/^kubectl get nodes/, { out: { items: [] } }],
    ...lists(c),
    [/^kubectl get pods/, { out: { items: [] } }],
  ]);
  const inv = await discoverOnprem({ exec, env: {} });
  assert.ok(!JSON.stringify(inv).includes("sha256:"), "digest 를 지어냄");
  const r = normalizeV2(inv).result;
  assert.equal(r.spec.components.some((x) => x.id === "shop-api"), false);
  assert.ok(r.unmapped.some((u) => u.resource.includes("shop-api")));
});

test("AWS: sts → EKS(임시 kubeconfig) → RDS·VPC·ALB·ECR·시크릿 이름. 시크릿 값·쓰기 명령 없음", async () => {
  const c = k8s();
  const { exec, calls } = fakeExec([
    [/^aws sts get-caller-identity/, { out: { Account: "111122223333" } }],
    [/^aws eks list-clusters/, { out: { clusters: ["finals-eks"] } }],
    [/^aws eks describe-cluster/, { out: { cluster: { version: "1.31", resourcesVpcConfig: { vpcId: "vpc-1" } } } }],
    [/^aws eks update-kubeconfig/, { out: "Added new context arn:aws:eks:... to /tmp/x" }],
    ...lists(c),
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
  const { pg } = read(inv);
  assert.equal(pg?.majorVersion, "16");
  assert.equal(pg?.storageGb, 30);
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
    ...lists(c),
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
  assert.equal(read(inv).pg?.majorVersion, "16");
  assert.equal(inv.coverage["gcp.artifactRepo"], 1);
});

test("GCP: 프로젝트를 못 정하면 SOURCE_UNAVAILABLE", async () => {
  const { exec } = fakeExec([[/^gcloud config get-value project/, { out: "(unset)" }]]);
  await assert.rejects(discoverGcp({ exec, env: {} }), /GCP 프로젝트가 정해지지 않음/);
});

test("Azure Mock 은 출발 실자원이 없다 → SOURCE_UNAVAILABLE", async () => {
  await assert.rejects(discoverSource("azure_mock", {}), (e: { code?: string }) => e.code === "SOURCE_UNAVAILABLE");
});

test("IMPORT_NAMESPACE 로 네임스페이스를 고른다 (그 안의 앱 전부), CNPG 종류가 없으면 DB 없이", async () => {
  const c = k8s("prod");
  const { exec } = fakeExec([
    [/^kubectl get nodes/, { out: { items: [] } }],
    ...lists(c),
    [/^kubectl get pods/, { out: c.pods }],
    [/^kubectl get clusters/, { code: 1, err: "error: the server doesn't have a resource type \"clusters\"" }],
  ]);
  const inv = await discoverOnprem({ exec, env: { IMPORT_NAMESPACE: "prod", IMPORT_APP: "shop-api" } });
  assert.equal(read(inv).pg, undefined, "CNPG 없으면 DB 없이");
  assert.equal(read(inv).svc?.image.digest, D);
});

test("감사용 판: 환경변수 값은 빼고 이름만 (원본은 그대로)", async () => {
  const c = k8s();
  const { exec } = fakeExec([
    [/^kubectl get nodes/, { out: { items: [] } }],
    ...lists(c),
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
