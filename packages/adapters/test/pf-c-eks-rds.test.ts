// PREFLIGHT C: 실검증과 같은 입력(EKS 샘플 3티어 + RDS Postgres 16) → discoverAws(가짜 CLI) → normalizeV2 → checkV2 → GCP Builder.
//   데이터 자원(RDS·네임스페이스·links·env 다시 쓰기)이 끝까지 이어지는지 본다. 매니페스트 = impl-1103/mac/real/sample-3tier-eks.yaml.tpl 와 같은 모양
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, checkV2, ImportResultV2, type TargetEnv } from "@svc/contracts";
import { discoverAws } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { carryHumanEdits } from "../src/import/carry.js";
import { targetBuilderFor, v2Blockers, v2PrecheckItems, withDbNetworkV2 } from "../src/index.js";
import type { Exec } from "../src/terraform/real-runner.js";

export const NS = "shop-real";
export const RDS_HOST = "shop-db.abcdefghij.ap-northeast-2.rds.amazonaws.com";
const D_API = "sha256:" + "a".repeat(64), D_WEB = "sha256:" + "b".repeat(64);
const meta = (name: string, labels: Record<string, string> = {}) => ({ name, namespace: NS, labels });
const pod = (app: string, image: string, digest: string) => ({ metadata: { name: `${app}-x`, namespace: NS, labels: { app } },
  status: { phase: "Running", containerStatuses: [{ name: app === "shop-api" ? "api" : "web", imageID: `docker-pullable://${image.split(":")[0]}@${digest}`, ready: true }] } });
const API = { metadata: meta("shop-api", { app: "shop-api" }), spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } }, template: { metadata: { labels: { app: "shop-api" } }, spec: {
  serviceAccountName: "shop-api", containers: [{ name: "api", image: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/api:1.0", args: ["-listen=:8080", "-text=ok"],
    ports: [{ name: "http", containerPort: 8080 }], resources: { requests: { cpu: "100m", memory: "64Mi" } }, readinessProbe: { httpGet: { path: "/", port: 8080 } },
    env: [{ name: "DB_HOST", value: RDS_HOST }, { name: "DB_PORT", value: "5432" },
      { name: "LOG_LEVEL", valueFrom: { configMapKeyRef: { name: "api-config", key: "LOG_LEVEL" } } },
      { name: "API_TOKEN", valueFrom: { secretKeyRef: { name: "api-secrets", key: "API_TOKEN" } } },
      { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "shop-db-app", key: "password" } } }] }] } } } };
const WEB = { metadata: meta("shop-web", { app: "shop-web" }), spec: { replicas: 1, selector: { matchLabels: { app: "shop-web" } }, template: { metadata: { labels: { app: "shop-web" } }, spec: {
  containers: [{ name: "web", image: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/web:1.0", ports: [{ name: "http", containerPort: 80 }],
    resources: { requests: { cpu: "50m", memory: "32Mi" } }, readinessProbe: { httpGet: { path: "/", port: 80 } },
    env: [{ name: "API_URL", value: `http://shop-api.${NS}.svc` }] }] } } } };
const svc = (name: string, target: number) => ({ metadata: meta(name), spec: { type: "ClusterIP", selector: { app: name }, ports: [{ name: "http", port: 80, targetPort: target, protocol: "TCP" }] } });
export const RDS = { DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.4", AllocatedStorage: 20, DBInstanceClass: "db.t4g.micro",
  Endpoint: { Address: RDS_HOST, Port: 5432 }, MultiAZ: false, PubliclyAccessible: false, StorageEncrypted: true, DBName: "shop", MasterUsername: "shop_admin",
  DBParameterGroups: [{ DBParameterGroupName: "shop-pg16" }], BackupRetentionPeriod: 1, VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-0000000000000d0b1", Status: "active" }], DBInstanceArn: "arn:aws:rds:ap-northeast-2:123456789012:db:shop-db" };

export const SG_DB = { GroupId: "sg-0000000000000d0b1", IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [], UserIdGroupPairs: [{ GroupId: "sg-eks" }] }] };
type Reply = { code?: number; out?: unknown; err?: string };
export function fakeExec(over: Array<[RegExp, Reply]> = []) {
  const calls: string[] = [];
  const table: Array<[RegExp, Reply]> = [
    ...over,
    [/^aws sts get-caller-identity/, { out: { Account: "123456789012" } }],
    [/^aws eks list-clusters/, { out: { clusters: ["finals"] } }],
    [/^aws eks describe-cluster/, { out: { cluster: { name: "finals", version: "1.31", resourcesVpcConfig: { vpcId: "vpc-1", clusterSecurityGroupId: "sg-eks" } } } }],
    // infra/modules/aws/app: DB 보안 그룹은 EKS 클러스터 SG 에서만 5432
    [/^aws ec2 describe-security-groups --group-ids sg-0000000000000d0b1 /, { out: { SecurityGroups: [SG_DB] } }],
    [/^aws eks update-kubeconfig/, { out: "ok" }],
    [/^aws ecs list-clusters/, { out: { clusterArns: [] } }],
    [/^aws rds describe-db-instances/, { out: { DBInstances: [RDS] } }],
    [/^aws rds describe-db-parameters/, { out: { Parameters: [{ ParameterName: "rds.logical_replication", ParameterValue: "1" }] } }],
    [/^aws s3api list-buckets/, { out: { Buckets: [] } }], [/^aws sqs list-queues/, { out: {} }], [/^aws elasticache describe-replication-groups/, { out: { ReplicationGroups: [] } }],
    [/^aws (ec2|elbv2|ecr|secretsmanager) /, { out: {} }],
    [/^kubectl get deployments/, { out: { items: [API, WEB] } }],
    [/^kubectl get services/, { out: { items: [svc("shop-api", 8080), svc("shop-web", 80)] } }],
    [/^kubectl get configmaps/, { out: { items: [{ metadata: meta("api-config"), data: { LOG_LEVEL: "m-import-cfg-value-7" } }] } }],
    [/^kubectl get serviceaccounts/, { out: { items: [{ metadata: meta("shop-api") }, { metadata: meta("default") }] } }],
    [/^kubectl get pods/, { out: { items: [pod("shop-api", "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/api:1.0", D_API), pod("shop-web", "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/web:1.0", D_WEB)] } }],
    [/^kubectl get replicasets/, { out: null, code: 1, err: "forbidden" }],
    [/^kubectl get namespace /, { out: { metadata: { name: NS, labels: { "m-import": "1", "kubernetes.io/metadata.name": NS } } } }],
    [/^kubectl api-resources/, { out: "deployments.apps\nservices" }],
    [/^kubectl get /, { out: { items: [] } }],
  ];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    const o = hit[1].out;
    return { code: hit[1].code ?? 0, stdout: typeof o === "string" ? o : JSON.stringify(o ?? null), stderr: hit[1].err ?? "", ms: 1 };
  };
  return { exec, calls };
}
export const ENV = { AWS_REGION: "ap-northeast-2", IMPORT_NAMESPACE: NS };
export const GCP: TargetEnv = { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp", region: "asia-northeast3", migrationId: "44444444-4444-4444-8444-444444444444" } as TargetEnv;

export async function runImport(over: Array<[RegExp, Reply]> = []) {
  const { exec, calls } = fakeExec(over);
  const inv = await discoverAws({ exec, env: ENV }, {});
  const { result } = normalizeV2(inv);
  return { inv, result, calls };
}

test("PF-C 1회차: EKS 3티어 + RDS → IR v2 데이터 자원 (postgres 하나, api→db 링크, DB_HOST 다시 쓰기, 네임스페이스)", async () => {
  const { result } = await runImport();
  assert.equal(ImportResultV2.safeParse(result).success, true);
  assert.deepEqual(checkV2(result.spec).errors, []);
  const spec = AppSpecV2.parse(result.spec);
  const kinds = spec.components.map((c) => `${c.kind}:${c.id}`).sort();
  const pg = spec.components.filter((c) => c.kind === "postgres");
  assert.equal(pg.length, 1, kinds.join(","));
  const db = pg[0]! as Extract<typeof pg[number], { kind: "postgres" }>;
  const api = spec.components.find((c) => c.id === "shop-api") as any;
  const env = Object.fromEntries(api.props.env.map((e: any) => [e.name, e]));
  assert.deepEqual(env.DB_HOST.fromLink, { to: db.id, output: "host" });
  assert.ok(spec.links.some((l) => l.from === "shop-api" && l.to === db.id), JSON.stringify(spec.links));
  assert.equal(spec.namespaces?.[0]?.name, NS);
  assert.deepEqual(result.unmapped, []);
  const pgVars = JSON.parse(String(targetBuilderFor("gcp").toTerraformV2(spec, GCP).vars.postgres_json))[0];
  assert.equal(pgVars.major_version, "16");
  assert.equal(pgVars.db_name, "shop");
  assert.equal(pgVars.logical_replication, true);
});

test("PF-C-01 거부: Pod 목록을 못 읽고 이미지가 태그뿐이면 멈춤 (예전: 워크로드 전부 빠지고 DB 만 남은 명세로 성공)", async () => {
  await assert.rejects(runImport([[/^kubectl get pods/, { code: 1, err: "Error from server (Forbidden): pods is forbidden" }]]),
    (e: { code?: string; message: string }) => e.code === "SOURCE_INCOMPLETE" && /Pod/.test(e.message));
  // 이미지가 전부 @sha256 이면 Pod 없이도 계속 (digest 를 Pod 에서 안 찾음)
  const pinned = (d: Record<string, any>, dg: string) => { const x = structuredClone(d); x.spec.template.spec.containers[0].image += `@${dg}`; return x; };
  const { result } = await runImport([[/^kubectl get pods/, { code: 1, err: "forbidden" }], [/^kubectl get deployments/, { out: { items: [pinned(API, D_API), pinned(WEB, D_WEB)] } }]]);
  assert.equal(result.spec.components.filter((c) => c.kind === "service").length, 2);
});

test("FM-IR-02: RDS 보안 그룹을 읽어 방화벽을 채움 → 출발 클러스터 SG 규칙은 앱 자신이라 빼고, 점검에 '방화벽을 못 읽음' 이 없음", async () => {
  const fw = (spec: AppSpecV2) => spec.posture.network.find((n) => n.scope === "component" && n.subject === "shop-db") as { ingress: unknown } | undefined;
  const human = (spec: AppSpecV2) => v2Blockers(spec, targetBuilderFor("gcp").capabilities()).needsHuman.filter((m) => m.startsWith("shop-db"));
  const { result, calls } = await runImport();
  const spec = AppSpecV2.parse(result.spec);
  assert.ok(calls.some((c) => c.startsWith("aws ec2 describe-security-groups --group-ids sg-0000000000000d0b1 ")));
  assert.deepEqual(fw(spec)?.ingress, []);
  assert.deepEqual(human(spec), []);
  // 다른 곳(사내 대역 CIDR + 남의 SG)도 열려 있으면 CIDR 은 도착에 옮기고, 남의 SG 는 사람에게
  const wide = { ...SG_DB, IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: "10.20.0.0/16" }], UserIdGroupPairs: [{ GroupId: "sg-eks" }, { GroupId: "sg-bastion" }] }] };
  const w = AppSpecV2.parse((await runImport([[/^aws ec2 describe-security-groups/, { out: { SecurityGroups: [wide] } }]])).result.spec);
  assert.deepEqual(fw(w)?.ingress, [{ from: "10.20.0.0/16", port: 5432 }, { from: "sg:sg-bastion", port: 5432 }]);
  assert.deepEqual(human(w), ["shop-db: 출발 방화벽 원본 sg:sg-bastion 은 도착에 그대로 못 옮김"]);
});

test("FM-IR-02 거부: 보안 그룹을 못 읽으면 예전처럼 unknown → 사람 확인 (조용히 열지 않음)", async () => {
  const { result, inv } = await runImport([[/^aws ec2 describe-security-groups/, { code: 1, err: "UnauthorizedOperation" }]]);
  const spec = AppSpecV2.parse(result.spec);
  assert.equal((spec.posture.network.find((n) => n.scope === "component") as { ingress: unknown }).ingress, "unknown");
  const notes = (inv.items as Array<{ kind: string; text?: string }>).filter((i) => i.kind === "import.note").map((i) => i.text ?? "");
  assert.ok(notes.some((n) => n.startsWith("RDS 보안 그룹 못 읽음")), notes.join("\n"));
  assert.ok(v2Blockers(spec, targetBuilderFor("gcp").capabilities()).needsHuman.some((m) => m.startsWith("shop-db: 출발 방화벽을 못 읽음")));
});

// FM-ORC-06 (회차마다 다시 돌림): 종류 하나를 못 읽을 때 — 핵심은 멈추고(일시면 재시도 코드), 곁가지는 검토 줄을 남기고 계속
test("FM-ORC-06: 부분 실패 주입 — ConfigMap·Service 거부는 멈춤, RDS 시간 초과는 재시도, Namespace·ServiceAccount·DB 파라미터 거부는 계속", async () => {
  const forbid = (re: RegExp): [RegExp, Reply] => [re, { code: 1, err: "Error from server (Forbidden): forbidden" }];
  for (const re of [/^kubectl get configmaps/, /^kubectl get services/])
    await assert.rejects(runImport([forbid(re)]), (e: { code?: string }) => e.code === "SOURCE_INCOMPLETE", String(re));
  await assert.rejects(runImport([[/^aws rds describe-db-instances/, { code: 255, err: "Connect timeout on endpoint URL: \"https://rds.ap-northeast-2.amazonaws.com/\"" }]]),
    (e: { code?: string }) => e.code === "SOURCE_TRANSIENT");
  for (const re of [/^kubectl get namespace /, /^kubectl get serviceaccounts/, /^aws rds describe-db-parameters/]) {
    const { result } = await runImport([forbid(re)]);
    assert.equal(result.spec.components.filter((c) => c.kind === "service").length, 2, String(re));
    assert.equal(result.spec.components.filter((c) => c.kind === "postgres").length, 1, String(re));
  }
});

// 관점 5 비용: 같은 계정의 남의 DB·버킷·큐는 명세에 안 들어감(도착에 두 배로 안 만듦) · 데모 DB 는 DB_DISPOSABLE=1 이면 삭제 보호 끔(down 이 지울 수 있음)
test("비용: 앱이 안 쓰는 RDS·S3·SQS 는 빠지고, DB_DISPOSABLE=1 이면 Cloud SQL 삭제 보호 꺼짐 (없으면 켜짐 = down 이 못 지움)", async () => {
  const old = { ...RDS, DBInstanceIdentifier: "old-db", Endpoint: { Address: "old-db.zzz.ap-northeast-2.rds.amazonaws.com", Port: 5432 }, DBInstanceArn: "arn:aws:rds:ap-northeast-2:123456789012:db:old-db" };
  const { result } = await runImport([
    [/^aws rds describe-db-instances/, { out: { DBInstances: [RDS, old] } }],
    [/^aws s3api list-buckets/, { out: { Buckets: [{ Name: "svc-tfstate-123456789012" }, { Name: "shop-assets" }] } }],
    [/^aws sqs list-queues/, { out: { QueueUrls: ["https://sqs.ap-northeast-2.amazonaws.com/123456789012/old-q"] } }],
  ]);
  assert.deepEqual(result.spec.components.map((c) => `${c.kind}:${c.id}`).sort(), ["postgres:shop-db", "service:shop-api", "service:shop-web"]);
  const spec = AppSpecV2.parse(result.spec);
  const pg = (env: NodeJS.ProcessEnv) => JSON.parse(String(withDbNetworkV2(targetBuilderFor("gcp").toTerraformV2(spec, GCP), "gcp", env).vars.postgres_json))[0];
  assert.equal(pg({ DB_DISPOSABLE: "1" }).deletion_protection, false);
  assert.equal(pg({}).deletion_protection, true);
  assert.equal(pg({}).ha, false);   // 출발 MultiAZ=false → ZONAL (두 배 과금 안 함)
});

// 관점 8 재실행: 같은 출발을 두 번 가져오면 같은 결과 · FM-IR-02 고침 전 판에서 사람이 우회(PATCH posture)한 값은 다시 가져와도 유지(합의)
test("재실행: 두 번 가져오면 같은 결과, 고침 전 판(방화벽 unknown)에서 사람이 posture 를 [] 로 고친 값은 새 가져오기([])와 합의로 유지", async () => {
  const a = (await runImport()).result, b = (await runImport()).result;
  assert.deepEqual(b, a);
  const old = structuredClone(a);
  const fwOf = (r: typeof a) => r.spec.posture.network.find((n) => n.scope === "component" && n.subject === "shop-db") as { ingress: unknown };
  fwOf(old).ingress = "unknown";
  old.fresh = { ...old.fresh, posture: structuredClone(old.spec.posture) };
  const human = structuredClone(old);
  fwOf(human).ingress = [];
  human.fieldMeta.posture = { source: "human", confidence: 1, needs_review: false };
  const { result, report } = carryHumanEdits(b, [{ spec: human.spec, fieldMeta: human.fieldMeta, fresh: human.fresh }, { spec: old.spec, fieldMeta: old.fieldMeta, fresh: old.fresh }]);
  assert.deepEqual(fwOf(result).ingress, []);
  assert.deepEqual(report.flagged.filter((f) => f.startsWith("posture")), []);
});

// 관점 9 대용량: 같은 리전에 Postgres RDS 가 120개(각자 SG) → SG 는 50개씩 3번 부르고, 앱 DB 하나만 명세에 (나머지는 경계 밖)
test("대용량: RDS 120개·SG 120개 → describe-security-groups 50개씩 나눠 부르고, 명세엔 앱 DB 하나", async () => {
  const many = Array.from({ length: 119 }, (_, i) => ({ ...RDS, DBInstanceIdentifier: `other-${String(i).padStart(3, "0")}`, DBName: "x",
    Endpoint: { Address: `other-${i}.zzz.ap-northeast-2.rds.amazonaws.com`, Port: 5432 }, DBInstanceArn: `arn:aws:rds:ap-northeast-2:123456789012:db:other-${i}`,
    VpcSecurityGroups: [{ VpcSecurityGroupId: `sg-${(i + 4096).toString(16).padStart(17, "0")}`, Status: "active" }] }));
  const { result, calls } = await runImport([
    [/^aws rds describe-db-instances/, { out: { DBInstances: [RDS, ...many] } }],
    [/^aws ec2 describe-security-groups/, { out: { SecurityGroups: [SG_DB] } }],
  ]);
  const sgCalls = calls.filter((c) => c.startsWith("aws ec2 describe-security-groups"));
  assert.equal(sgCalls.length, 3);
  assert.ok(sgCalls.every((c) => c.split(" sg-").length - 1 <= 50));
  assert.deepEqual(result.spec.components.filter((c) => c.kind === "postgres").map((c) => c.id), ["shop-db"]);
  const fw = result.spec.posture.network.find((n) => n.scope === "component" && n.subject === "shop-db") as { ingress: unknown };
  assert.deepEqual(fw.ingress, []);
});

// 관점 11 보안 감사: FM-IR-02 로 RDS 방화벽을 읽게 되면서 출발 0.0.0.0/0 공개 DB 도 읽힌다. 넓은 주소도 그대로 옮기고 막지 않는 것이 결정(fc2 TF4-2, 2026-11-03)
//   → 가져오기 → 도착 변수까지 그 결정과 같게 이어지는지 본다 (RDS 출발 길로)
test("보안 감사: 출발 RDS 공개 + 0.0.0.0/0 → 결정(TF4-2)대로 도착 peer 에 그대로, 사람 확인 줄 없음 · /32 도 같음", async () => {
  const run = async (cidr: string) => {
    const sg = { ...SG_DB, IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: cidr }], UserIdGroupPairs: [] }] };
    const { result } = await runImport([[/^aws rds describe-db-instances/, { out: { DBInstances: [{ ...RDS, PubliclyAccessible: true }] } }], [/^aws ec2 describe-security-groups/, { out: { SecurityGroups: [sg] } }]]);
    const spec = AppSpecV2.parse(result.spec);
    const pg = JSON.parse(String(targetBuilderFor("gcp").toTerraformV2(spec, GCP).vars.postgres_json))[0];
    return { human: v2Blockers(spec, targetBuilderFor("gcp").capabilities()).needsHuman, pub: pg.public, peers: JSON.parse(pg.peer_cidrs_json) };
  };
  assert.deepEqual(await run("0.0.0.0/0"), { human: [], pub: true, peers: ["0.0.0.0/0"] });
  assert.deepEqual(await run("203.0.113.7/32"), { human: [], pub: true, peers: ["203.0.113.7/32"] });
});

// FM-IR-03 (지휘 결정 00:52Z: 도착 네임스페이스는 app-<앱> 유지, M-1 은 TODO(human)): 이름은 달라도 동작은 같아야 한다
//   = 출발 네임스페이스(shop-real)를 가리키던 서비스 주소가 env·ConfigMap 모두 도착 네임스페이스로 다시 써져야 한다
test("FM-IR-03: 도착 네임스페이스 app-shop-api — env 와 ConfigMap 의 <svc>.shop-real.svc 주소가 도착 이름으로 다시 써짐", async () => {
  const cm = { metadata: { name: "api-config", namespace: NS }, data: { LOG_LEVEL: "m-import-cfg-value-7", UPSTREAM: `shop-web.${NS}.svc.cluster.local:80`, SHORT: `http://shop-web.${NS}` } };
  const { result } = await runImport([[/^kubectl get configmaps/, { out: { items: [cm] } }]]);
  const v = targetBuilderFor("gcp").toWorkloadValues(AppSpecV2.parse(result.spec), {}, { ...GCP, tenantId: "11111111-1111-4111-8111-111111111111" } as never) as
    { namespace: string; workloads: Array<{ name: string; env: Array<{ name: string; value?: string }>; configs?: Array<{ name: string; data: Record<string, string> }> }> };
  assert.equal(v.namespace, "app-shop-api");
  const web = v.workloads.find((w) => w.name === "shop-web")!, api = v.workloads.find((w) => w.name === "shop-api")!;
  assert.equal(web.env.find((e) => e.name === "API_URL")?.value, "http://shop-api.app-shop-api.svc");
  const data = api.configs!.find((c) => c.name === "api-config")!.data;
  assert.equal(data.UPSTREAM, "shop-web.app-shop-api.svc:80");   // .cluster.local 은 떼고 씀 (파드 검색 도메인으로 같은 주소)
  assert.equal(data.SHORT, "http://shop-web.app-shop-api.svc");   // <svc>.<ns> 짧은 꼴도 도착 주소로
  assert.equal(data.LOG_LEVEL, "m-import-cfg-value-7");
  assert.ok(!JSON.stringify(v).includes(`.${NS}`), "출발 네임스페이스 주소가 남지 않음");
});

// 관점 12 다른 앱 모양 (FM-IR-C06): ECS 출발 + RDS. RDS SG 가 ECS 작업 SG 에서만 5432 → 앱 자신이라 빼야 점검이 안 막힘 (예전: EKS 클러스터 SG 만 앱으로 봄)
test("FM-IR-C06: ECS 출발 — RDS 방화벽의 ECS 작업 SG 규칙은 앱 자신으로 빼고 점검 막음 0, 모르는 SG 는 그대로 사람 확인", async () => {
  const ecs: Array<[RegExp, Reply]> = [
    [/^aws eks list-clusters/, { out: { clusters: [] } }],
    [/^aws ecs list-clusters/, { out: { clusterArns: ["arn:aws:ecs:ap-northeast-2:123456789012:cluster/shop"] } }],
    [/^aws ecs list-services --cluster shop/, { out: { serviceArns: ["arn:aws:ecs:ap-northeast-2:123456789012:service/shop/shop-api"] } }],
    [/^aws ecs describe-services --cluster shop --services/, { out: { services: [{ serviceName: "shop-api", serviceArn: "arn:aws:ecs:ap-northeast-2:123456789012:service/shop/shop-api",
      status: "ACTIVE", desiredCount: 1, launchType: "FARGATE", taskDefinition: "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/shop-api:1",
      networkConfiguration: { awsvpcConfiguration: { securityGroups: ["sg-ecs"], subnets: ["subnet-1"] } } }] } }],
    [/^aws ecs describe-task-definition/, { out: { taskDefinition: { family: "shop-api", cpu: "256", memory: "512", containerDefinitions: [{ name: "api",
      image: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/api:1.0", essential: true, portMappings: [{ containerPort: 8080, protocol: "tcp" }],
      environment: [{ name: "DB_HOST", value: RDS_HOST }] }] } } }],
    [/^aws ecs list-tasks/, { out: { taskArns: ["arn:aws:ecs:ap-northeast-2:123456789012:task/shop/abc"] } }],
    [/^aws ecs describe-tasks/, { out: { tasks: [{ taskDefinitionArn: "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/shop-api:1", containers: [{ name: "api", imageDigest: D_API }] }] } }],
    [/^aws application-autoscaling /, { out: {} }],
  ];
  const fwOf = async (sg: object) => {
    const { result, calls } = await runImport([...ecs, [/^aws ec2 describe-security-groups/, { out: { SecurityGroups: [sg] } }]]);
    const spec = AppSpecV2.parse(result.spec);
    assert.ok(calls.some((c) => c.startsWith("aws ec2 describe-security-groups --group-ids sg-0000000000000d0b1 ")));
    assert.deepEqual(spec.components.map((c) => `${c.kind}:${c.id}`).sort(), ["postgres:shop-db", "service:shop-api"]);
    return { fw: (spec.posture.network.find((n) => n.scope === "component" && n.subject === "shop-db") as { ingress: unknown }).ingress,
      human: v2Blockers(spec, targetBuilderFor("gcp").capabilities()).needsHuman.filter((m) => m.startsWith("shop-db")) };
  };
  const rule = (groups: string[]) => ({ ...SG_DB, IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [], UserIdGroupPairs: groups.map((GroupId) => ({ GroupId })) }] });
  assert.deepEqual(await fwOf(rule(["sg-ecs"])), { fw: [], human: [] });
  assert.deepEqual(await fwOf(rule(["sg-ecs", "sg-other"])), { fw: [{ from: "sg:sg-other", port: 5432 }], human: ["shop-db: 출발 방화벽 원본 sg:sg-other 은 도착에 그대로 못 옮김"] });
});

// FM-IR-C07 (관점 12): 앱이 쓰는 RDS 가 명세에 없으면(다른 리전·계정·경계 밖) env·ConfigMap 의 출발 RDS 주소가 글자 그대로 남아 도착 앱이 출발 DB 를 가리킴 → 검토 줄
test("FM-IR-C07: 명세에 없는 출발 RDS 주소가 env·ConfigMap 에 그대로 남으면 검토 줄 (DB 가 명세에 있으면 다시 써져 줄 없음)", async () => {
  const cm = { metadata: { name: "api-config", namespace: NS }, data: { LOG_LEVEL: "x", DB_URL: `postgres://${RDS_HOST}:5432/shop` } };
  const flagged = (r: Awaited<ReturnType<typeof runImport>>["result"]) =>
    Object.entries(r.fieldMeta).filter(([, m]) => m.needs_review && /출발 관리형 데이터 주소/.test(m.rationale ?? "")).map(([k]) => k).sort();
  assert.deepEqual(flagged((await runImport([[/^kubectl get configmaps/, { out: { items: [cm] } }]])).result), []);
  const none = (await runImport([[/^aws rds describe-db-instances/, { out: { DBInstances: [] } }], [/^kubectl get configmaps/, { out: { items: [cm] } }]])).result;
  assert.deepEqual(flagged(none), ["components.shop-api.configs.api-config.DB_URL", "components.shop-api.env.DB_HOST"]);
});

// FM-APP-hunt-deploy-db-02 (C 쪽 ①): Postgres 두 개를 쓰는 앱 → 복제 끝점이 하나뿐이라 apply·배포 뒤 복제가 빈 주소로 멈춤 → 계획 전 점검이 막음
test("Postgres 2개 앱: 점검이 계획 전에 막음 (하나면 안 막음)", async () => {
  const H2 = "report-db.abcdefghij.ap-northeast-2.rds.amazonaws.com";
  const two = { ...RDS, DBInstanceIdentifier: "report-db", DBName: "report", Endpoint: { Address: H2, Port: 5432 }, DBInstanceArn: "arn:aws:rds:ap-northeast-2:123456789012:db:report-db" };
  const api2 = structuredClone(API) as typeof API;
  api2.spec.template.spec.containers[0]!.env.push({ name: "REPORT_DB_HOST", value: H2 } as never);
  const { result } = await runImport([[/^aws rds describe-db-instances/, { out: { DBInstances: [RDS, two] } }], [/^kubectl get deployments/, { out: { items: [api2, WEB] } }]]);
  assert.deepEqual(result.spec.components.filter((c) => c.kind === "postgres").map((c) => c.id).sort(), ["report-db", "shop-db"]);
  const blocks = v2PrecheckItems("gcp", { specV2: AppSpecV2.parse(result.spec) }).filter((i) => i.level === "block").map((i) => i.message);
  assert.deepEqual(blocks.filter((m) => /Postgres 2개/.test(m)).length, 1, blocks.join("\n"));
  const one = (await runImport()).result;
  assert.deepEqual(v2PrecheckItems("gcp", { specV2: AppSpecV2.parse(one.spec) }).filter((i) => i.level === "block"), []);
});

// 관점 2 공격자: RDS 응답의 SG id 가 옵션 모양(--endpoint-url=…)이면 CLI 인자로 안 넘기고 그 DB 방화벽은 unknown (사람 확인)
test("공격자: 이상한 SG id 는 describe-security-groups 인자로 안 넘김 → 그 DB 는 unknown", async () => {
  const { result, calls } = await runImport([[/^aws rds describe-db-instances/, { out: { DBInstances: [{ ...RDS, VpcSecurityGroups: [{ VpcSecurityGroupId: "--endpoint-url=http://evil", Status: "active" }] }] } }]]);
  assert.equal(calls.some((c) => c.startsWith("aws ec2 describe-security-groups")), false);
  assert.ok(!calls.some((c) => c.includes("evil")));
  assert.equal((result.spec.posture.network.find((n) => n.scope === "component" && n.subject === "shop-db") as { ingress: unknown }).ingress, "unknown");
});
