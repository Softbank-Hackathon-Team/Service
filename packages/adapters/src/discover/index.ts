import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, RawInventory } from "@svc/contracts";
import {
  arr, awsRegion, CliError, gcpProject, get, onpremContext, runJson, runText, str, unavailable, incomplete, sourceFail, type CliDeps,
  maskAccount, mockSeed,
} from "../common/cli.js";
import { DEMO_INVENTORY, DEMO_INVENTORY_V2 } from "../common/fixtures.js";
import { readK8sApp, readK8sNamespace } from "./k8s.js";
import { appIdentities, readAwsIam } from "./aws-iam.js";
import { readAwsData, readGcpData } from "./data.js";
import { DATA_RAW_KINDS } from "../import/raw-data.js";
import { readEcs } from "../import/readers/aws-ecs.js";
import { readEc2 } from "../import/readers/aws-ec2.js";
import { readGce } from "../import/readers/gcp-gce.js";
import { readCloudRun } from "../import/readers/gcp-cloudrun.js";

// Z88: 출발 환경 진짜 읽기 (데모 원본 STUB 대체). 결과는 normalize 가 아는 원본 모양 + 둘레 자원 목록.
//   AWS  : sts → eks list/describe-cluster → kubeconfig(임시 파일) → kubectl 앱 읽기 · rds describe-db-instances
//          + ec2 describe-vpcs · elbv2 describe-load-balancers · ecr describe-repositories · secretsmanager list-secrets(이름만)
//   GCP  : projects describe → container clusters list → get-credentials(임시 KUBECONFIG) → kubectl 앱 읽기 · sql instances list
//          + compute networks list · forwarding-rules list · artifacts repositories list · secrets list(이름만)
//   온프레: kubectl --context <ONPREM_KUBE_CONTEXT> get nodes → 앱 읽기 · clusters.postgresql.cnpg.io
//   Azure: Mock 이라 출발 실자원이 없다 → 못 읽음
// 고르는 규칙 (여러 개일 때): IMPORT_APP·IMPORT_NAMESPACE / IMPORT_AWS_EKS_CLUSTER·IMPORT_AWS_DB_ID /
//   IMPORT_GCP_GKE_CLUSTER·IMPORT_GCP_SQL_INSTANCE / IMPORT_ONPREM_CNPG. 없으면 이름순 첫 번째 + notes 에 적는다.
// 둘레 자원(VPC·LB·레지스트리·시크릿) 하나가 실패해도 앱·DB 를 읽었으면 계속한다 (notes 에 이유). 앱을 못 읽으면 멈춘다.

type Obj = Record<string, unknown>;

/** I2: 가져오기 옵션. ir 를 안 주면 지금 동작(v1) 그대로. adapters 는 IMPORT_IR 환경변수를 읽지 않는다 (호출하는 쪽이 옵션으로만 넘김) */
/** I4: iam = true 면 (v2 + AWS 만) 앱 신원의 IAM 정책도 읽는다 (aws.iamPolicy). 기본 꺼짐 = 지금 그대로 */
export interface DiscoverOpts { ir?: "v1" | "v2"; namespace?: string; iam?: boolean }

/** v1 = 앱 Deployment 하나(readK8sApp), v2 = 네임스페이스 전체(readK8sNamespace). 같은 모양 {items, namespace, counts, notes} 로 맞춘다 */
async function readApp(d: CliDeps, kube: string[], opts: DiscoverOpts): Promise<{ items: Obj[]; namespace: string; counts: Record<string, number>; notes: string[] }> {
  if (opts.ir === "v2") {
    const r = await readK8sNamespace(d, kube, { namespace: opts.namespace });
    return { items: r.items as unknown as Obj[], namespace: r.namespace, counts: r.counts, notes: r.notes };
  }
  const r = await readK8sApp(d, kube);
  return { items: [{ ...r.item }], namespace: r.namespace, counts: r.counts, notes: r.notes };
}
const note = (text: string) => ({ kind: "import.note", text });
const peri = (kind: string, items: Obj[]) => items.map((o) => ({ kind, ...o }));

/** 둘레 자원 하나: 실패하면 빈 목록 + 이유 한 줄 */
async function side(label: string, f: () => Promise<Obj[]>, notes: string[]): Promise<Obj[]> {
  try { return await f(); } catch (e) { notes.push(`${label} 못 읽음: ${(e as Error).message.slice(0, 160)}`); return []; }
}

function pick<T extends Obj>(list: T[], want: string | undefined, nameOf: (x: T) => string, what: string, notes: string[]): T | undefined {
  const sorted = [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  if (want) return sorted.find((x) => nameOf(x) === want);
  if (sorted.length > 1) notes.push(`${what} ${sorted.length}개 중 ${nameOf(sorted[0]!)} 를 골랐다`);
  return sorted[0];
}

function coverage(items: Obj[], extra: Record<string, number> = {}): Record<string, number> {
  const c: Record<string, number> = { ...extra };
  for (const i of items) if (i.kind !== "import.note" && !(String(i.kind) in extra)) c[String(i.kind)] = (c[String(i.kind)] ?? 0) + 1;
  return c;
}

async function withTempKube<T>(f: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "svc-import-"));
  try { return await f(join(dir, "kubeconfig")); } finally { await rm(dir, { recursive: true, force: true }); }
}

const cliReason = (e: unknown, bin: string) =>
  e instanceof CliError && e.missing ? `${bin} 명령이 없음` : (e as Error).message.slice(0, 200);

// ── AWS ───────────────────────────────────────────────────────────────
export async function discoverAws(d: CliDeps = {}, opts: DiscoverOpts = {}): Promise<RawInventory> {
  const env = d.env ?? process.env, region = awsRegion(env), r = ["--region", region, "--output", "json"];
  let account: string | null;
  try { account = str(get(await runJson(d, "aws", ["sts", "get-caller-identity", "--output", "json"]), "Account")); }
  catch (e) { throw sourceFail(e, `AWS 자격 없음 (${cliReason(e, "aws")})`); }
  const notes: string[] = [`AWS 계정 ${maskAccount(account)} · 리전 ${region}${env.AWS_PROFILE ? ` · 프로필 ${env.AWS_PROFILE}` : ""}`];

  const clusters = arr(get(await runJson(d, "aws", ["eks", "list-clusters", ...r]).catch((e) => { throw sourceFail(e, cliReason(e, "aws")); }), "clusters"))
    .map((n) => ({ name: String(n) }));
  const cl = pick(clusters, env.IMPORT_AWS_EKS_CLUSTER, (x) => x.name, "EKS 클러스터", notes);
  // I9: v2 는 ECS 서비스도 읽는다 (관리형 컨테이너 갈래). EKS 가 없어도 ECS 서비스가 있으면 계속. v1 은 지금 그대로(EKS 필수)
  const ecs = opts.ir === "v2" ? await readEcs(d, region, env).catch((e) => ({ items: [] as Obj[], counts: {}, notes: [`ECS 못 읽음: ${cliReason(e, "aws")}`] })) : null;
  const hasEcs = (ecs?.items ?? []).some((i) => i.kind === "ecs.service");
  // VMIMPORT: v2 는 VM(EC2) 도 읽는다 — 명시(IMPORT_VM=1·IMPORT_AWS_VM_TAG)했거나 EKS·ECS 가 없을 때만 (있는 앱의 호출 수·권한은 안 늘린다). 못 읽어도 계속(notes)
  const wantVm = opts.ir === "v2" && (env.IMPORT_VM === "1" || !!env.IMPORT_AWS_VM_TAG?.trim() || (!cl && !hasEcs));
  const vm = wantVm ? await readEc2(d, region, env).catch((e) => ({ items: [] as Obj[], counts: {}, notes: [`EC2 못 읽음: ${cliReason(e, "aws")}`] })) : null;
  const hasVm = (vm?.items ?? []).length > 0;
  if (!cl && !hasEcs && !hasVm) throw incomplete(env.IMPORT_AWS_EKS_CLUSTER ? `EKS 클러스터 ${env.IMPORT_AWS_EKS_CLUSTER} 없음` : `리전 ${region} 에 EKS 클러스터 없음${ecs ? " (ECS 서비스도 없음)" : ""}${vm ? ` (VM 도 없음${vm.notes.length ? `: ${vm.notes[0]}` : ""})` : ""}`);
  const desc = cl ? get(await runJson(d, "aws", ["eks", "describe-cluster", "--name", cl.name, ...r]), "cluster") as Obj | undefined : undefined;
  const vpcId = str(get(desc, "resourcesVpcConfig", "vpcId"));

  const app = !cl ? { items: [] as Obj[], namespace: "", counts: {} as Record<string, number>, notes: [] as string[] } : await withTempKube(async (kc) => {
    try { await runText(d, "aws", ["eks", "update-kubeconfig", "--name", cl.name, "--kubeconfig", kc, "--region", region]); }
    catch (e) { throw sourceFail(e, `EKS ${cl.name} kubeconfig 만들기 실패 (${cliReason(e, "aws")})`); }
    try { return await readApp(d, ["--kubeconfig", kc], opts); }
    catch (e) { if (e instanceof CliError) throw sourceFail(e, `EKS ${cl.name} 쿠버네티스 API 읽기 실패 (access entry 확인): ${e.message.slice(0, 160)}`); throw e; }
  });

  // I4: 앱 신원의 IAM 정책 (v2 + 옵션 켬). 못 읽어도 앱·DB 는 계속 (notes 에 이유)
  // I9: EKS 없이 ECS 만 읽은 경우는 아직 안 읽음 (ECS 작업 역할 → grants 는 TODO: 다음 묶음)
  const iam = opts.ir === "v2" && opts.iam && cl
    ? await side("IAM", async () => (await readAwsIam(d, r, cl.name, appIdentities(app.items), notes)) as unknown as Obj[], notes)
    : [];

  const dbs = arr(get(await runJson(d, "aws", ["rds", "describe-db-instances", ...r]), "DBInstances")).filter((x) => x.Engine === "postgres");
  const db = pick(dbs, env.IMPORT_AWS_DB_ID, (x) => String(x.DBInstanceIdentifier), "RDS Postgres", notes);
  if (env.IMPORT_AWS_DB_ID && !db) notes.push(`RDS ${env.IMPORT_AWS_DB_ID} 없음 → DB 없이 명세를 만든다`);

  const [vpcs, lbs, repos, secrets] = await Promise.all([
    side("VPC", async () => peri("aws.vpc", arr(get(await runJson(d, "aws", ["ec2", "describe-vpcs", ...(vpcId ? ["--vpc-ids", vpcId] : []), ...r]), "Vpcs"))
      .map((v) => ({ id: v.VpcId, cidr: v.CidrBlock, isDefault: v.IsDefault }))), notes),
    side("ALB", async () => peri("aws.alb", arr(get(await runJson(d, "aws", ["elbv2", "describe-load-balancers", ...r]), "LoadBalancers"))
      .filter((l) => !vpcId || l.VpcId === vpcId).map((l) => ({ name: l.LoadBalancerName, dns: l.DNSName, type: l.Type, scheme: l.Scheme }))), notes),
    side("ECR", async () => peri("aws.ecr", arr(get(await runJson(d, "aws", ["ecr", "describe-repositories", ...r]), "repositories"))
      .map((x) => ({ name: x.repositoryName, uri: x.repositoryUri }))), notes),
    side("Secrets Manager", async () => peri("aws.secret", arr(get(await runJson(d, "aws", ["secretsmanager", "list-secrets", ...r]), "SecretList"))
      .map((x) => ({ name: x.Name }))), notes),   // 이름만. GetSecretValue 는 부르지 않는다
  ]);

  // I6: v2 만 S3·SQS·ElastiCache 를 읽는다 (v1 은 지금 동작 그대로 — 호출 수·권한이 늘지 않는다)
  const data = opts.ir === "v2" ? await readAwsData(d, region, notes) : [];
  const items: Obj[] = [
    ...app.items,
    ...data,
    ...(db ? [{ kind: "rds.dbInstance", DBInstanceIdentifier: db.DBInstanceIdentifier, Engine: db.Engine, EngineVersion: db.EngineVersion,
      AllocatedStorage: db.AllocatedStorage, DBInstanceClass: db.DBInstanceClass, Endpoint: get(db, "Endpoint", "Address") ?? null,
      ...(opts.ir === "v2" ? { MultiAZ: db.MultiAZ ?? null, PubliclyAccessible: db.PubliclyAccessible ?? null, MaxAllocatedStorage: db.MaxAllocatedStorage ?? null, DBInstanceArn: db.DBInstanceArn ?? null } : {}) }] : []),
    ...(cl ? [{ kind: "eks.cluster", name: cl.name, version: get(desc, "version") ?? null, vpcId }] : []),
    ...(ecs?.items ?? []),
    ...(vm?.items ?? []),
    ...vpcs, ...lbs, ...repos, ...secrets, ...iam,
    ...[...notes, ...app.notes, ...(ecs?.notes ?? []), ...(vm?.notes ?? [])].map(note),
  ];
  return { provider: "aws", items, coverage: coverage(items, { ...app.counts, ...(ecs?.counts ?? {}), ...(vm?.counts ?? {}) }) };
}

// ── GCP ───────────────────────────────────────────────────────────────
export async function discoverGcp(d: CliDeps = {}, opts: DiscoverOpts = {}): Promise<RawInventory> {
  const env = d.env ?? process.env;
  const project = await gcpProject(d);
  if (!project) throw unavailable("GCP 프로젝트가 정해지지 않음 (GCP_PROJECT)");
  const p = ["--project", project, "--format", "json"];
  try { await runJson(d, "gcloud", ["projects", "describe", project, "--format", "json"]); }
  catch (e) { throw sourceFail(e, `GCP 자격 없음 또는 프로젝트 ${project} 접근 불가 (${cliReason(e, "gcloud")})`); }
  const notes: string[] = [`GCP 프로젝트 ${project}`];

  const clusters = arr(await runJson(d, "gcloud", ["container", "clusters", "list", ...p]).catch((e) => { throw sourceFail(e, cliReason(e, "gcloud")); }));
  const cl = pick(clusters, env.IMPORT_GCP_GKE_CLUSTER, (x) => String(x.name), "GKE 클러스터", notes);
  // VMIMPORT: v2 는 GCE VM 도 읽는다 — 명시(IMPORT_VM=1·IMPORT_GCP_VM_LABEL)했거나 GKE 가 없을 때만. 못 읽어도 계속(notes)
  const wantVm = opts.ir === "v2" && (env.IMPORT_VM === "1" || !!env.IMPORT_GCP_VM_LABEL?.trim() || !cl);
  const vm = wantVm ? await readGce(d, project, env).catch((e) => ({ items: [] as Obj[], counts: {}, notes: [`GCE 못 읽음: ${cliReason(e, "gcloud")}`] })) : null;
  // CRIMPORT: v2 는 Cloud Run 서비스·잡도 읽는다 (관리형 컨테이너 갈래, ECS 와 같은 규칙). GKE 가 없어도 Cloud Run 서비스가 있으면 계속. v1 은 지금 그대로(GKE 필수)
  //   DRAFT(ai): 따로 깃발 없음 — 가져오기 v2(IMPORT_IR=v2) 면 켜짐 (ECS 와 같음)
  const run = opts.ir === "v2" ? await readCloudRun(d, project, env).catch((e) => ({ items: [] as Obj[], counts: {}, notes: [`Cloud Run 못 읽음: ${cliReason(e, "gcloud")}`] })) : null;
  const hasRun = (run?.items ?? []).some((i) => i.kind === "cloudrun.service");
  // VMIMPORT×CRIMPORT: GKE·VM·Cloud Run 서비스 셋 다 없을 때만 멈춘다
  if (!cl && !(vm?.items ?? []).length && !hasRun) throw incomplete(env.IMPORT_GCP_GKE_CLUSTER ? `GKE 클러스터 ${env.IMPORT_GCP_GKE_CLUSTER} 없음` : `프로젝트 ${project} 에 GKE 클러스터 없음${vm ? ` (VM 도 없음${vm.notes.length ? `: ${vm.notes[0]}` : ""})` : ""}${run ? " (Cloud Run 서비스도 없음)" : ""}`);
  const name = cl ? String(cl.name) : "", loc = cl ? String(cl.location ?? cl.zone ?? "") : "";

  const app = !cl ? { items: [] as Obj[], namespace: "", counts: {} as Record<string, number>, notes: [] as string[] } : await withTempKube(async (kc) => {
    try { await runText(d, "gcloud", ["container", "clusters", "get-credentials", name, "--location", loc, "--project", project], { KUBECONFIG: kc }); }
    catch (e) { throw sourceFail(e, `GKE ${name} kubeconfig 만들기 실패 (${cliReason(e, "gcloud")})`); }
    try { return await readApp(d, ["--kubeconfig", kc], opts); }
    catch (e) { if (e instanceof CliError) throw sourceFail(e, `GKE ${name} 쿠버네티스 API 읽기 실패: ${e.message.slice(0, 160)}`); throw e; }
  });

  const sqls = arr(await side("Cloud SQL", async () => arr(await runJson(d, "gcloud", ["sql", "instances", "list", ...p])), notes))
    .filter((x) => String(x.databaseVersion ?? "").startsWith("POSTGRES_"));
  const db = pick(sqls, env.IMPORT_GCP_SQL_INSTANCE, (x) => String(x.name), "Cloud SQL Postgres", notes);

  const [nets, fwd, repos, secrets] = await Promise.all([
    side("VPC", async () => peri("gcp.network", arr(await runJson(d, "gcloud", ["compute", "networks", "list", ...p])).map((n) => ({ name: n.name, auto: n.autoCreateSubnetworks }))), notes),
    side("부하 분산기", async () => peri("gcp.forwardingRule", arr(await runJson(d, "gcloud", ["compute", "forwarding-rules", "list", ...p])).map((f) => ({ name: f.name, ip: f.IPAddress, scheme: f.loadBalancingScheme }))), notes),
    side("Artifact Registry", async () => peri("gcp.artifactRepo", arr(await runJson(d, "gcloud", ["artifacts", "repositories", "list", ...p])).map((x) => ({ name: String(x.name ?? "").split("/").pop(), format: x.format }))), notes),
    side("Secret Manager", async () => peri("gcp.secret", arr(await runJson(d, "gcloud", ["secrets", "list", ...p])).map((x) => ({ name: String(x.name ?? "").split("/").pop() }))), notes),
  ]);

  const data = opts.ir === "v2" ? await readGcpData(d, project, notes) : [];   // I6: v2 만 Cloud Storage·Pub/Sub·Memorystore
  const items: Obj[] = [
    ...app.items,
    ...data,
    ...(db ? [{ kind: "cloudsql.instance", name: db.name, databaseVersion: db.databaseVersion,
      settings: { dataDiskSizeGb: get(db, "settings", "dataDiskSizeGb") == null && opts.ir === "v2" ? null : String(get(db, "settings", "dataDiskSizeGb") ?? "10"),   // v2: 못 읽은 값을 지어내지 않는다
        tier: get(db, "settings", "tier") ?? null,
        ...(opts.ir === "v2" ? { availabilityType: get(db, "settings", "availabilityType") ?? null, ipConfiguration: get(db, "settings", "ipConfiguration") ?? null } : {}) },
      region: db.region ?? null,
      ...(opts.ir === "v2" ? { ipAddresses: arr(db.ipAddresses).map((a) => ({ type: a.type ?? null, ipAddress: a.ipAddress ?? null })), selfLink: db.selfLink ?? null } : {}) }] : []),
    ...(cl ? [{ kind: "gke.cluster", name, location: loc, version: cl.currentMasterVersion ?? null }] : []),
    ...(vm?.items ?? []),
    ...(run?.items ?? []),
    ...nets, ...fwd, ...repos, ...secrets,
    ...[...notes, ...app.notes, ...(vm?.notes ?? []), ...(run?.notes ?? [])].map(note),
  ];
  return { provider: "gcp", items, coverage: coverage(items, { ...app.counts, ...(vm?.counts ?? {}), ...(run?.counts ?? {}) }) };
}

// ── 온프레 (k3s·k3d + CNPG) ──────────────────────────────────────────
export async function discoverOnprem(d: CliDeps = {}, opts: DiscoverOpts = {}): Promise<RawInventory> {
  const env = d.env ?? process.env, ctx = onpremContext(env), k = ["--context", ctx];
  let nodes: Obj[];
  try { nodes = arr(get(await runJson(d, "kubectl", ["get", "nodes", ...k, "--request-timeout=10s", "-o", "json"]), "items")); }
  catch (e) { throw sourceFail(e, `온프레 클러스터(context ${ctx})에 닿지 않음 (${cliReason(e, "kubectl")})`); }
  const notes: string[] = [`온프레 context ${ctx} · 노드 ${nodes.length}개`];
  let app;
  try { app = await readApp(d, k, opts); }
  catch (e) { if (e instanceof CliError) throw sourceFail(e, `온프레 쿠버네티스 API 읽기 실패: ${e.message.slice(0, 160)}`); throw e; }

  let cnpg: Obj[] = [];
  try { cnpg = arr(get(await runJson(d, "kubectl", ["get", "clusters.postgresql.cnpg.io", "-A", ...k, "--request-timeout=10s", "-o", "json"]), "items")); }
  catch (e) {
    if (e instanceof CliError && /doesn't have a resource type/i.test(e.stderr)) notes.push("CNPG 가 안 깔림 → DB 없이 명세를 만든다");
    else notes.push(`CNPG 못 읽음: ${(e as Error).message.slice(0, 160)}`);
  }
  const nm = (x: Obj) => `${str(get(x, "metadata", "namespace"))}/${str(get(x, "metadata", "name"))}`;
  const sameNs = cnpg.filter((x) => get(x, "metadata", "namespace") === app.namespace);
  const db = env.IMPORT_ONPREM_CNPG ? cnpg.find((x) => nm(x) === env.IMPORT_ONPREM_CNPG || get(x, "metadata", "name") === env.IMPORT_ONPREM_CNPG)
    : pick(sameNs.length ? sameNs : cnpg, undefined, nm, "CNPG 클러스터", notes);

  const items: Obj[] = [
    ...app.items,
    ...(db ? [{ kind: "cnpg.cluster", metadata: { name: get(db, "metadata", "name"), namespace: get(db, "metadata", "namespace") },
      spec: { imageName: str(get(db, "spec", "imageName")) ?? str(get(db, "status", "image")) ?? undefined,
              storage: { size: str(get(db, "spec", "storage", "size")) ?? (opts.ir === "v2" ? null : "1Gi") }, instances: get(db, "spec", "instances") ?? null } }] : []),
    ...nodes.map((n) => ({ kind: "k8s.node", name: get(n, "metadata", "name"), version: get(n, "status", "nodeInfo", "kubeletVersion") ?? null,
      cpu: get(n, "status", "allocatable", "cpu") ?? null, memory: get(n, "status", "allocatable", "memory") ?? null })),
    ...[...notes, ...app.notes].map(note),
  ];
  return { provider: "onprem", items, coverage: coverage(items, app.counts) };
}

/** 감사·화면에 남길 판: 환경변수는 이름만 (평문 값은 비밀일 수 있다, Z38b). 원본은 바꾸지 않는다.
 *  I2: env 가 있는 모든 워크로드(deployment·cronjob)의 containers·initContainers 에 적용하고, 값이 박힐 수 있는 command·args 도 지운다 */
// VI3bfix: 감사 사본에서 값을 가리는 주소 칸 (종류별). 가져오기 매퍼는 원본을 읽으므로 명세에는 영향 없음
const ADDRESS_KEYS: Record<string, readonly string[]> = {
  "rds.dbInstance": ["Endpoint"],
  [DATA_RAW_KINDS.elasticache]: ["PrimaryEndpoint", "ConfigurationEndpoint"],
  [DATA_RAW_KINDS.memorystore]: ["host"],
};
export function inventoryForAudit(inv: RawInventory): RawInventory {
  const scrub = (pod: unknown) => {
    for (const key of ["containers", "initContainers"])
      for (const c of arr(get(pod, key))) {
        if (Array.isArray(c.env)) c.env = arr(c.env).map((e) => ({ name: e.name }));
        delete c.args; delete c.command;
      }
  };
  const items = inv.items.map((raw) => {
    const i = raw as Obj;
    // I9: ECS 작업 정의 환경변수도 이름만 (평문 비밀일 수 있음), 시작 명령 지움. secrets 는 ARN 이라 그대로
    // CRIMPORT: Cloud Run 컨테이너 환경변수도 이름만 (평문 비밀일 수 있음), 시작 명령·인자 지움. 비밀 참조는 이름·버전이라 그대로
    if (i.kind === "cloudrun.service" || i.kind === "cloudrun.job") {
      const copy = JSON.parse(JSON.stringify(i)) as Obj;
      for (const c of arr(copy.containers)) {
        if (Array.isArray(c.env)) c.env = arr(c.env).map((e) => (e.secret ? { name: e.name, secret: e.secret } : { name: e.name }));
        delete c.command; delete c.args;
      }
      return copy;
    }
    if (i.kind === "ecs.service") {
      const copy = JSON.parse(JSON.stringify(i)) as Obj;
      for (const c of arr(get(copy, "taskDefinition", "containerDefinitions"))) {
        if (Array.isArray(c.environment)) c.environment = arr(c.environment).map((e) => ({ name: e.name }));
        delete c.command; delete c.entryPoint;
      }
      return copy;
    }
    // I3bfix DRAFT(ai): Cloud SQL 등의 주소(ipAddresses·ipAddress)는 감사 표에 종류(type)만 남기고 값은 가린다 (사설 IP 노출 방지).
    //   가져오기 매퍼는 이 사본이 아니라 원본 inv 를 읽으므로 명세·id 에는 영향이 없다
    if (i.kind !== "k8s.deployment" && i.kind !== "k8s.cronjob") {
      // VI3bfix: RDS(Endpoint)·ElastiCache(Primary/ConfigurationEndpoint)·Memorystore(host) 주소도 같은 규칙.
      //   DRAFT(ai): 값이 있었으면 "<hidden>" 으로 바꿔 "주소가 있었다"만 남긴다 (null 은 그대로 null)
      const addrKeys = ADDRESS_KEYS[String(i.kind)] ?? [];
      if (!("ipAddresses" in i) && !("ipAddress" in i) && !addrKeys.some((k) => k in i)) return i;
      const c = { ...i } as Obj;
      if (Array.isArray(c.ipAddresses)) c.ipAddresses = arr(c.ipAddresses).map((a) => ({ type: a.type ?? null }));
      delete c.ipAddress;
      for (const k of addrKeys) if (k in c) c[k] = c[k] == null ? null : "<hidden>";
      return c;
    }
    const copy = JSON.parse(JSON.stringify(i)) as Obj;
    scrub(i.kind === "k8s.cronjob" ? get(copy, "spec", "jobTemplate", "spec", "template", "spec") : get(copy, "spec", "template", "spec"));
    return copy;
  });
  return { provider: inv.provider, coverage: inv.coverage, items };
}

export async function discoverSource(p: Provider, d: CliDeps = {}, opts: DiscoverOpts = {}): Promise<RawInventory> {
  if (p === "aws") return discoverAws(d, opts);
  if (p === "gcp") return discoverGcp(d, opts);
  if (p === "onprem") return discoverOnprem(d, opts);
  throw unavailable("Azure 는 Mock 실행기만 있어 출발 환경으로 읽을 실자원이 없음 (결정: 진짜 Azure 안 만듦)");
}

/** 가져오기 진입점. MOCK_SEED=1 이면 데모 원본(v2 면 DEMO_INVENTORY_V2[p], 없으면 DEMO_INVENTORY[p]), 아니면 진짜 읽기. I9: aws 도 v2 데모(ECS 3티어) */
export async function discoverForImport(p: Provider, opts: DiscoverOpts = {}, d: CliDeps = {}): Promise<RawInventory> {
  if (mockSeed(d.env ?? process.env)) return (opts.ir === "v2" ? DEMO_INVENTORY_V2[p] : undefined) ?? DEMO_INVENTORY[p];
  return discoverSource(p, d, opts);
}
