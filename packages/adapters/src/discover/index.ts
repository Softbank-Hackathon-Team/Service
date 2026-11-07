import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, RawInventory, SourceScope } from "@svc/contracts";
import {
  arr, awsRegion, CliError, gcpProject, get, onpremContext, runJson, runText, str, unavailable, incomplete, sourceFail, type CliDeps,
  maskAccount, mockSeed, classifyCliError,
} from "../common/cli.js";
import { DEMO_INVENTORY } from "../common/fixtures.js";
import { readK8sNamespace } from "./k8s.js";
import { appIdentities, readAwsIam, readEcsTaskIam, readGcpIam } from "./aws-iam.js";
import { readAwsNet, readGcpNet } from "./net.js";
import { readAwsData, readGcpData } from "./data.js";
import { DATA_RAW_KINDS } from "../import/raw-data.js";
import { dnsUnreadStub } from "../import/dns-records.js";
import { readEcs } from "../import/readers/aws-ecs.js";
import { readEc2 } from "../import/readers/aws-ec2.js";
import { readGce } from "../import/readers/gcp-gce.js";
import { readCloudRun } from "../import/readers/gcp-cloudrun.js";
import { PICK_KIND, UNREAD_KIND, pickItem, unreadItem, unreadOrThrow } from "../common/unread.js";
import { eksKubeconfig } from "./eks-kubeconfig.js";

// Z88: 출발 환경 진짜 읽기 (데모 원본 STUB 대체). 결과는 normalize 가 아는 원본 모양 + 둘레 자원 목록.
//   AWS  : sts → eks list/describe-cluster → kubeconfig(임시 파일, #373 B4 정적 토큰) → kubectl 앱 읽기 · rds describe-db-instances
//          + ec2 describe-vpcs · elbv2 describe-load-balancers · ecr describe-repositories · secretsmanager list-secrets(이름만)
//   GCP  : projects describe → container clusters list → get-credentials(임시 KUBECONFIG) → kubectl 앱 읽기 · sql instances list
//          + compute networks list · forwarding-rules list · artifacts repositories list · secrets list(이름만)
//   온프레: kubectl --context <ONPREM_KUBE_CONTEXT> get nodes → 앱 읽기 · clusters.postgresql.cnpg.io
//   Azure: Mock 이라 출발 실자원이 없다 → 못 읽음
// 고르는 규칙 (여러 개일 때): IMPORT_APP·IMPORT_NAMESPACE / IMPORT_AWS_EKS_CLUSTER / IMPORT_GCP_GKE_CLUSTER. 없으면 이름순 첫 번째 + notes 에 적는다.
//   G3b-3: DB(RDS·Aurora·Cloud SQL·CNPG)는 고르지 않고 전부 읽어 앱 경계가 근거로 고른다. IMPORT_AWS_DB_ID·IMPORT_GCP_SQL_INSTANCE·IMPORT_ONPREM_CNPG 를
//   주면 그것만 (없으면 검토 줄).
// 둘레 자원(VPC·LB·레지스트리·시크릿) 하나가 실패해도 앱·DB 를 읽었으면 계속한다 (notes 에 이유). 앱을 못 읽으면 멈춘다.

type Obj = Record<string, unknown>;

/** 가져오기 옵션. I4: iam = true 면 (AWS 만) 앱 신원의 IAM 정책도 읽는다 (aws.iamPolicy). 기본 꺼짐.
 *  K-1: scope = 이 이전의 출발 범위 (migrations.source_scope). 있는 칸은 워커 환경변수(IMPORT_*)보다 먼저 */
export interface DiscoverOpts { namespace?: string; iam?: boolean; scope?: SourceScope }

/** K-1 DRAFT(ai): 출발 범위 → 읽기 코드가 이미 보는 IMPORT_* 이름으로 덮어 쓴 env (이 가져오기 한 번의 자식 CLI·고르기에만, 프로세스 env 는 안 바꿈).
 *  범위 칸이 비면 env 값(개발용 기본값) 그대로. 고르기 규칙을 두 군데 두지 않으려고 이름을 맞춘다 */
export function scopedEnv(env: NodeJS.ProcessEnv, scope: SourceScope | undefined): NodeJS.ProcessEnv {
  if (!scope) return env;
  const o: Record<string, string> = {};
  if (scope.namespaces?.length) o.IMPORT_NAMESPACE = scope.namespaces.join(",");
  if (scope.cluster) { o.IMPORT_AWS_EKS_CLUSTER = scope.cluster; o.IMPORT_GCP_GKE_CLUSTER = scope.cluster; }
  if (scope.ecsCluster) o.IMPORT_AWS_ECS_CLUSTER = scope.ecsCluster;
  if (scope.database) { o.IMPORT_AWS_DB_ID = scope.database; o.IMPORT_GCP_SQL_INSTANCE = scope.database; o.IMPORT_ONPREM_CNPG = scope.database; }
  if (scope.partOf) o.IMPORT_APP = scope.partOf;
  return Object.keys(o).length ? { ...env, ...o } : env;
}

/** 앱 네임스페이스 전체(readK8sNamespace). {items, namespace, counts, notes} 모양 */
async function readApp(d: CliDeps, kube: string[], opts: DiscoverOpts): Promise<{ items: Obj[]; namespace: string; counts: Record<string, number>; notes: string[] }> {
  const r = await readK8sNamespace(d, kube, { namespace: opts.namespace });
  return { items: r.items as unknown as Obj[], namespace: r.namespace, counts: r.counts, notes: r.notes };
}
const note = (text: string) => ({ kind: "import.note", text });
/** B-3: 앱 원본 글자 (버킷 이름이 나오는지 볼 재료). 메모리에서만 쓰고 저장·로그 안 함 */
const refsOf = (items: Obj[]) => JSON.stringify(items);
const peri = (kind: string, items: Obj[]) => items.map((o) => ({ kind, ...o }));

/** 둘레 자원 하나: 실패하면 빈 목록 + 이유 한 줄 */
async function side(label: string, f: () => Promise<Obj[]>, notes: string[]): Promise<Obj[]> {
  try { return await f(); } catch (e) { notes.push(`${label} 못 읽음: ${(e as Error).message.slice(0, 160)}`); return []; }
}
// PF-A13 DRAFT(ai): 명세에 들어가는 부가 읽기(RDS 파라미터·보안 그룹, Cloud SQL DB 목록)는 일시 오류면 던져 가져오기를 다시 한다.
//   예전엔 note 만 남고 값이 null → 파라미터 "권한 확인" 검토 줄, 보안 그룹 unknown → 사전 점검이 "출발 방화벽을 못 읽음" 으로 막았다(FM-IR-02).
//   거부 등 그 밖은 예전처럼 note + 빈 값. 둘레 정보(VPC·ALB·ECR·Secrets Manager 이름, 명세에 안 씀)는 side 그대로
async function sideCore(label: string, f: () => Promise<Obj[]>, notes: string[]): Promise<Obj[]> {
  try { return await f(); }
  catch (e) {
    if (e instanceof CliError && classifyCliError(e) === "transient") throw sourceFail(e, `${label} (${e.message.slice(0, 160)})`);
    if ((e as { code?: unknown } | null)?.code === "SOURCE_TRANSIENT") throw e;   // 안쪽(IAM 읽기)이 이미 일시 오류로 바꾼 것
    notes.push(`${label} 못 읽음: ${(e as Error).message.slice(0, 160)}`); return [];
  }
}

function pick<T extends Obj>(list: T[], want: string | undefined, nameOf: (x: T) => string, what: string, notes: string[], picks?: Obj[], key?: string): T | undefined {
  const sorted = [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  if (want) return sorted.find((x) => nameOf(x) === want);
  if (sorted.length > 1) {
    notes.push(`${what} ${sorted.length}개 중 ${nameOf(sorted[0]!)} 를 골랐다`);
    if (picks && key) picks.push(pickItem(key, `${what} ${sorted.length}개(${sorted.map(nameOf).slice(0, 5).join(", ")}${sorted.length > 5 ? " …" : ""}) 중 이름순 첫 번째 ${nameOf(sorted[0]!)}`));   // K-1
  }
  return sorted[0];
}

function coverage(items: Obj[], extra: Record<string, number> = {}): Record<string, number> {
  const c: Record<string, number> = { ...extra };
  for (const i of items) if (i.kind !== "import.note" && i.kind !== UNREAD_KIND && i.kind !== PICK_KIND && !(String(i.kind) in extra)) c[String(i.kind)] = (c[String(i.kind)] ?? 0) + 1;
  return c;
}

// #373 B3: 파일 이름 = 클러스터 신원 (<종류>-<위치>-<이름>.kubeconfig). 가져오기 캐시(import-cache.ts)가 임의 폴더 이름 대신 이 이름을 키에 넣는다.
//   이름이 다르면 다른 클러스터라 같은 kubectl 명령이어도 기록을 나누지 않는다
async function withTempKube<T>(label: string, f: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "svc-import-"));
  try { return await f(join(dir, `${label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160)}.kubeconfig`)); } finally { await rm(dir, { recursive: true, force: true }); }
}

// RF-1: GCP API 를 프로젝트에서 안 켬 = 그 종류 자원이 없음 (못 읽음 아님)
const SERVICE_DISABLED = /SERVICE_DISABLED|has not been used in project|API .* is (not enabled|disabled)/i;
const cliReason = (e: unknown, bin: string) =>
  e instanceof CliError && e.missing ? `${bin} 명령이 없음` : (e as Error).message.slice(0, 200);

// VNEW DRAFT(ai): 클러스터는 있는데 앱 Deployment 가 없을 때(빈 클러스터·시스템 것만), v2 에서 다른 출발 갈래(ECS·VM·Cloud Run)에 앱이 있으면
//   그 갈래만으로 계속한다 (예전엔 클러스터가 있다는 이유만으로 SOURCE_INCOMPLETE 로 멈춰 Cloud Run·ECS 앱을 못 가져왔다). 다른 오류(권한·연결)는 그대로 던진다
const EMPTY_APP = (note: string) => ({ items: [] as Obj[], namespace: "", counts: {} as Record<string, number>, notes: [note] });
const noAppInCluster = (e: unknown) => (e as { code?: string } | null)?.code === "SOURCE_INCOMPLETE";

// ── AWS ───────────────────────────────────────────────────────────────
export async function discoverAws(d: CliDeps = {}, opts: DiscoverOpts = {}): Promise<RawInventory> {
  const env = d.env ?? process.env, region = awsRegion(env), r = ["--region", region, "--output", "json"];
  let account: string | null;
  try { account = str(get(await runJson(d, "aws", ["sts", "get-caller-identity", "--output", "json"]), "Account")); }
  catch (e) { throw sourceFail(e, `AWS 자격 없음 (${cliReason(e, "aws")})`); }
  const notes: string[] = [`AWS 계정 ${maskAccount(account)} · 리전 ${region}${env.AWS_PROFILE ? ` · 프로필 ${env.AWS_PROFILE}` : ""}`];
  const unreadDb: Obj[] = [];   // G3b-3·RF-3: 지정한 DB 가 없음 등 → 검토 줄

  const clusters = arr(get(await runJson(d, "aws", ["eks", "list-clusters", ...r]).catch((e) => { throw sourceFail(e, cliReason(e, "aws")); }), "clusters"))
    .map((n) => ({ name: String(n) }));
  const cl = pick(clusters, env.IMPORT_AWS_EKS_CLUSTER, (x) => x.name, "EKS 클러스터", notes, unreadDb, "cluster");
  // K-1: 지정한 클러스터가 없으면 다른 갈래(ECS·VM)로 조용히 넘어가지 않는다
  if (env.IMPORT_AWS_EKS_CLUSTER && !cl) throw incomplete(`EKS 클러스터 ${env.IMPORT_AWS_EKS_CLUSTER} 없음 (출발 범위 확인)`);
  // I9: ECS 서비스도 읽는다 (관리형 컨테이너 갈래). EKS 가 없어도 ECS 서비스가 있으면 계속
  // RF-1: 못 읽음 ≠ 없음. 일시 오류면 던져 재시도, 아니면 "ECS 못 읽음" 검토 줄을 남기고 다른 갈래로 계속
  const ecs = await readEcs(d, region, env).catch((e) => ({ items: [unreadOrThrow(e, "ecs", "ECS 서비스") as unknown as Obj], counts: {}, notes: [`ECS 못 읽음: ${cliReason(e, "aws")}`] }));
  const ecsWhy = ecs.notes.find((n) => n.startsWith("ECS 못 읽음"));
  const hasEcs = ecs.items.some((i) => i.kind === "ecs.service");
  // VMIMPORT: VM(EC2) 도 읽는다 — 명시(IMPORT_VM=1·IMPORT_AWS_VM_TAG)했거나 EKS·ECS 가 없을 때만 (있는 앱의 호출 수·권한은 안 늘린다). 못 읽어도 계속(notes)
  const wantVm = (env.IMPORT_VM === "1" || !!env.IMPORT_AWS_VM_TAG?.trim() || (!cl && !hasEcs));
  const vm = wantVm ? await readEc2(d, region, env).catch((e) => ({ items: [unreadOrThrow(e, "ec2", "EC2 인스턴스") as unknown as Obj], counts: {}, notes: [`EC2 못 읽음: ${cliReason(e, "aws")}`] })) : null;
  const hasVm = (vm?.items ?? []).some((i) => i.kind !== UNREAD_KIND);
  if (!cl && !hasEcs && !hasVm) throw incomplete(env.IMPORT_AWS_EKS_CLUSTER ? `EKS 클러스터 ${env.IMPORT_AWS_EKS_CLUSTER} 없음` : `리전 ${region} 에 EKS 클러스터 없음 (${ecsWhy ? ecsWhy.slice(0, 200) : "ECS 서비스도 없음"})${vm ? ` (VM 도 없음${vm.notes.length ? `: ${vm.notes[0]}` : ""})` : ""}`);
  // RF-3: describe-cluster 실패도 원인 분류(일시 → 재시도, 거부 → 출발 못 읽음)
  const desc = cl ? get(await runJson(d, "aws", ["eks", "describe-cluster", "--name", cl.name, ...r]).catch((e) => { throw sourceFail(e, `EKS ${cl.name} 읽기 실패 (${cliReason(e, "aws")})`); }), "cluster") as Obj | undefined : undefined;
  const vpcId = str(get(desc, "resourcesVpcConfig", "vpcId"));

  const app = !cl ? { items: [] as Obj[], namespace: "", counts: {} as Record<string, number>, notes: [] as string[] } : await withTempKube(`eks-${region}-${cl.name}`, async (kc) => {
    // #373 B4: 토큰을 한 번 받아 정적 토큰 kubeconfig (kubectl 마다 aws eks get-token 이 뜨지 않게). 못 쓰면 예전 exec kubeconfig (eks-kubeconfig.ts)
    let kd: CliDeps;
    try {
      kd = (await eksKubeconfig(d, { cluster: cl.name, region, desc, path: kc,
        execKubeconfig: async () => { await runText(d, "aws", ["eks", "update-kubeconfig", "--name", cl.name, "--kubeconfig", kc, "--region", region]); } })).deps;
    } catch (e) { throw sourceFail(e, `EKS ${cl.name} kubeconfig 만들기 실패 (${cliReason(e, "aws")})`); }
    try { return await readApp(kd, ["--kubeconfig", kc], opts); }
    catch (e) {
      if (e instanceof CliError) throw sourceFail(e, `EKS ${cl.name} 쿠버네티스 API 읽기 실패 (access entry 확인): ${e.message.slice(0, 160)}`);
      if ((hasEcs || hasVm) && noAppInCluster(e)) return EMPTY_APP(`EKS ${cl.name} 에 앱 Deployment 없음 → ${hasEcs ? "ECS" : "VM"} 만 가져옴`);
      throw e;
    }
  });

  // I4: 앱 신원의 IAM 정책 (옵션 켬). 못 읽어도 앱·DB 는 계속 (notes 에 이유)
  // RF-3: ECS 작업 역할(taskRoleArn)도 읽는다 (예전: EKS 신원만 → ECS 앱은 grants 근거 없음)
  // ID-5: 못 읽은 신원은 unread 항목(→ unread.IAM.<ns>/<sa> 검토 줄)
  const iamUnread: Obj[] = [];
  const iam = opts.iam
    ? [...(cl ? await sideCore("IAM", async () => (await readAwsIam(d, r, cl.name, appIdentities(app.items), notes, account, iamUnread)) as unknown as Obj[], notes) : []),
      ...(hasEcs ? await sideCore("ECS 작업 역할 IAM", async () => (await readEcsTaskIam(d, ecs.items, notes, account)) as unknown as Obj[], notes) : [])]
    : [];

  // RF-1·RF-3: DB 목록은 핵심이라 못 읽으면 멈춘다 (일시 → 재시도, 거부 → 출발 못 읽음). 예전엔 원인 분류 없이 IMPORT_FAILED
  const allDbs = arr(get(await runJson(d, "aws", ["rds", "describe-db-instances", ...r]).catch((e) => { throw sourceFail(e, `RDS 목록 못 읽음 (${cliReason(e, "aws")})`); }), "DBInstances"));
  // G3b-3 DRAFT(ai): DB 도 다른 데이터 자원처럼 전부 읽고 앱 경계(boundary)가 근거로 고른다 (예전: 이름순 첫 번째 하나만 → 앱 DB 가 아니면 명세에 DB 없음).
  //   읽기 복제본은 따로 안 옮기고 원본 DB 의 별칭 주소로 (앱이 복제본 주소를 써도 원본 DB 로 이어짐). Aurora Postgres 는 클러스터 하나 = 한 줄 (아래)
  const isPg = (x: Obj) => x.Engine === "postgres" || x.Engine === "aurora-postgresql";
  const replicaOf = (x: Obj) => str(x.ReadReplicaSourceDBInstanceIdentifier);
  const replicaEndpoints = new Map<string, string[]>();
  for (const x of allDbs.filter((x) => isPg(x) && replicaOf(x))) {
    const src = replicaOf(x)!.split(":").pop()!.split("/").pop()!;   // 다른 리전 원본이면 ARN
    const ep = str(get(x, "Endpoint", "Address"));
    if (ep) replicaEndpoints.set(src, [...(replicaEndpoints.get(src) ?? []), ep].sort());
  }
  const auroraSeen = new Set<string>();
  const dbs = allDbs.filter((x) => isPg(x) && !replicaOf(x)).sort((a, b) => String(a.DBInstanceIdentifier).localeCompare(String(b.DBInstanceIdentifier)))
    .filter((x) => {   // Aurora: 클러스터마다 이름순 첫 인스턴스 하나 (구성원끼리 같은 데이터)
      if (x.Engine !== "aurora-postgresql") return true;
      const c = str(x.DBClusterIdentifier) ?? String(x.DBInstanceIdentifier);
      if (auroraSeen.has(c)) return false;
      auroraSeen.add(c); return true;
    });
  const wantDb = env.IMPORT_AWS_DB_ID?.trim() || undefined;
  const picked = wantDb ? dbs.filter((x) => x.DBInstanceIdentifier === wantDb || x.DBClusterIdentifier === wantDb) : dbs;
  if (wantDb && !picked.length) unreadDb.push(unreadItem("rds.wanted", `지정한 RDS ${wantDb} 가 이 리전 Postgres 목록에 없음 → DB 없이 명세를 만듦. 이름·리전을 사람이 확인`));
  if (!wantDb && dbs.length > 1) notes.push(`RDS Postgres ${dbs.length}개를 모두 읽음 → 앱 경계가 근거로 고름`);
  // N8·SSL-1: 파라미터 그룹의 사용자 값 (rds.force_ssl 포함). 그룹 이름마다 한 번. 못 읽으면 note 만 (값은 null → 매퍼가 검토 표시)
  const pgNameOf = (x: Obj) => str(get(arr(x.DBParameterGroups)[0], "DBParameterGroupName"));
  const pgParams = new Map<string, unknown>();
  for (const pgName of [...new Set(picked.map(pgNameOf).filter((n): n is string => !!n && !n.startsWith("default.")))].sort()) {
    const got = await sideCore(`RDS 파라미터 그룹 ${pgName}`, async () => [{ params: Object.fromEntries(arr(get(await runJson(d, "aws", ["rds", "describe-db-parameters", "--db-parameter-group-name", pgName, "--source", "user", ...r]), "Parameters"))
        .filter((x) => typeof x.ParameterName === "string" && x.ParameterValue != null).map((x) => [String(x.ParameterName), String(x.ParameterValue)])) }], notes);
    pgParams.set(pgName, (got[0] as { params?: unknown } | undefined)?.params ?? null);
  }
  // FM-IR-02 DRAFT(ai): RDS 보안 그룹(들어오는 규칙)을 읽어 posture.network 를 채운다 (예전: 늘 unknown → 점검이 "출발 방화벽을 못 읽음" 으로 막음).
  //   출발지가 출발 EKS 클러스터의 보안 그룹(클러스터 SG·추가 SG)이면 = 옮기는 앱 자신 → 도착은 링크(connect 의존성)로 여니 규칙에서 뺀다.
  //   그 밖의 SG·접두어 목록은 그대로 남겨 사람이 본다. 못 읽으면 null(→ unknown, 예전과 같음)
  //   FM-IR-C06: ECS 작업·EC2 VM 출발이면 그 작업·VM 의 보안 그룹도 앱 자신 (예전: EKS 만 → ECS·VM 앱의 RDS 는 남의 SG 로 보여 점검이 막음)
  const appSgs = new Set([str(get(desc, "resourcesVpcConfig", "clusterSecurityGroupId")), ...arr(get(desc, "resourcesVpcConfig", "securityGroupIds")).map((x) => String(x)),
    ...[...ecs.items, ...(vm?.items ?? [])].flatMap((i) => (Array.isArray(i.securityGroups) ? (i.securityGroups as unknown[]).map(String) : []))]
    .filter((x): x is string => !!x));
  // 관점 2(공격자): CLI 인자로 넘기므로 SG id 모양만 받는다 (-- 로 시작하는 값이 옵션으로 읽히지 않게). 모양이 틀린 SG 가 있으면 그 DB 는 unknown
  const SG_ID = /^sg-[0-9a-f]{8,17}$/;
  const dbSgIds = (db: Obj) => arr(db.VpcSecurityGroups).filter((g) => g.Status === undefined || g.Status === "active").map((g) => String(g.VpcSecurityGroupId)).filter(Boolean);
  const okSg = (id: string) => SG_ID.test(id);
  const wantSgs = [...new Set(picked.flatMap(dbSgIds).filter(okSg))].sort();
  const dbSgs = new Map<string, Obj>();
  // 대용량(관점 9): 계정에 DB 가 많으면 SG 도 많다 → 50개씩 나눠 부른다 (aws-ec2 와 같은 크기). 한 묶음 실패는 그 묶음 DB 만 unknown
  for (let i = 0; i < wantSgs.length; i += 50) {
    const part = wantSgs.slice(i, i + 50);
    for (const g of await sideCore("RDS 보안 그룹", async () => arr(get(await runJson(d, "aws", ["ec2", "describe-security-groups", "--group-ids", ...part, ...r]), "SecurityGroups")), notes))
      dbSgs.set(String(g.GroupId), g);
  }
  const dbIngress = (db: Obj): { ingress: Obj[] | null; appSg: number } => {
    const ids = dbSgIds(db);
    if (!ids.length || !ids.every((g) => dbSgs.has(g))) return { ingress: null, appSg: 0 };
    const out = new Map<string, Obj>(); let appSg = 0;
    for (const g of ids) for (const p of arr(dbSgs.get(g)?.IpPermissions)) {
      const proto = str(p.IpProtocol);
      if (proto !== "-1" && proto !== "tcp") continue;
      const from = Number(p.FromPort), to = Number(p.ToPort);
      const port = proto === "tcp" && from === to && Number.isInteger(from) && from >= 1 && from <= 65535 ? from : undefined;
      const srcs = [...arr(p.IpRanges).map((x) => String(x.CidrIp)), ...arr(p.Ipv6Ranges).map((x) => String(x.CidrIpv6)),
        ...arr(p.PrefixListIds).map((x) => `pl:${String(x.PrefixListId)}`),
        ...arr(p.UserIdGroupPairs).map((x) => String(x.GroupId)).filter((sg) => (appSgs.has(sg) ? (appSg++, false) : true)).map((sg) => `sg:${sg}`)];
      for (const f of srcs) out.set(`${f}|${port ?? ""}`, { from: f, ...(port !== undefined ? { port } : {}) });
    }
    return { ingress: [...out.values()].sort((a, b) => `${a.from}|${a.port ?? ""}`.localeCompare(`${b.from}|${b.port ?? ""}`)), appSg };
  };
  const rdsItems: Obj[] = picked.map((db) => {
    const pgName = pgNameOf(db);
    const aurora = db.Engine === "aurora-postgresql";
    return { kind: "rds.dbInstance", DBInstanceIdentifier: db.DBInstanceIdentifier, Engine: db.Engine, EngineVersion: db.EngineVersion,
      AllocatedStorage: db.AllocatedStorage, DBInstanceClass: db.DBInstanceClass, Endpoint: get(db, "Endpoint", "Address") ?? null,
      Port: get(db, "Endpoint", "Port") ?? null,   // DM-7
      MultiAZ: db.MultiAZ ?? null, PubliclyAccessible: db.PubliclyAccessible ?? null, MaxAllocatedStorage: db.MaxAllocatedStorage ?? null, DBInstanceArn: db.DBInstanceArn ?? null,
      StorageEncrypted: db.StorageEncrypted ?? null,
      // N8·SSL-1: 읽기 복제본·처음 DB 이름·파라미터 그룹(이름·사용자 값). 기본 그룹(default.*)은 값이 버전 기본이라 안 부름
      ReadReplicaDBInstanceIdentifiers: Array.isArray(db.ReadReplicaDBInstanceIdentifiers) ? db.ReadReplicaDBInstanceIdentifiers : null, DBName: db.DBName ?? null,
      MasterUsername: db.MasterUsername ?? null,   // DBN-1
      BackupRetentionPeriod: typeof db.BackupRetentionPeriod === "number" ? db.BackupRetentionPeriod : null, PreferredMaintenanceWindow: db.PreferredMaintenanceWindow ?? null,   // BK-1
      DBParameterGroupName: pgName ?? null, ...(pgName && !pgName.startsWith("default.") ? { Parameters: pgParams.get(pgName) ?? null } : {}),
      // G3b-3: 복제본 주소(앱이 읽기용으로 쓰는 주소) · Aurora 클러스터 이름
      ...(replicaEndpoints.get(String(db.DBInstanceIdentifier))?.length ? { ReplicaEndpoints: replicaEndpoints.get(String(db.DBInstanceIdentifier)) } : {}),
      ...(aurora ? { DBClusterIdentifier: str(db.DBClusterIdentifier) ?? null } : {}),
      ...(() => { const x = dbIngress(db); return { Ingress: x.ingress, IngressAppSg: x.appSg }; })() };
  });

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

  // I6: S3·SQS·ElastiCache
  // B-3: 앱 원본(env·ConfigMap 값·IAM 정책)에 이름이 나오는 버킷은 개수 상한과 상관없이 읽는다
  const data = await readAwsData(d, region, notes, new Date(), refsOf([...app.items, ...ecs.items, ...(vm?.items ?? []), ...iam]));
  // E-1·E-2: 출발 나가는 IP(NAT)·사설 DNS 레코드 (EKS VPC 기준)
  const net = await readAwsNet(d, region, vpcId, notes);
  const items: Obj[] = [
    ...app.items,
    ...data,
    ...rdsItems, ...unreadDb,   // 보안 판정용 출발 사실 (import/security-facts.ts). KmsKeyId 는 키 소유를 못 가려 안 읽는다
    ...(cl ? [{ kind: "eks.cluster", name: cl.name, version: get(desc, "version") ?? null, vpcId }] : []),
    ...ecs.items,
    ...(vm?.items ?? []),
    ...vpcs, ...lbs, ...repos, ...secrets, ...iam, ...iamUnread, ...net,
    { ...dnsUnreadStub("route53") },   // GW-2 STUB: DNS 읽기 권한 TODO(human) (import/dns-records.ts)
    ...[...notes, ...app.notes, ...ecs.notes, ...(vm?.notes ?? [])].map(note),
  ];
  return { provider: "aws", items, coverage: coverage(items, { ...app.counts, ...ecs.counts, ...(vm?.counts ?? {}) }) };
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
  const picks: Obj[] = [];   // K-1: 자동으로 고른 것 → 검토 줄

  const clusters = arr(await runJson(d, "gcloud", ["container", "clusters", "list", ...p]).catch((e) => { throw sourceFail(e, cliReason(e, "gcloud")); }));
  // RF-3: 같은 이름이 다른 location 에 있을 수 있다 → IMPORT_GCP_GKE_CLUSTER 는 "location/이름" 도 받는다. 이름만 주고 여럿이면 멈춤(아무거나 안 고름)
  const gkeWant = env.IMPORT_GCP_GKE_CLUSTER?.trim() || undefined;
  const gkeLoc = (x: Obj) => String(x.location ?? x.zone ?? "");
  if (gkeWant && !gkeWant.includes("/") && clusters.filter((x) => String(x.name) === gkeWant).length > 1)
    throw incomplete(`GKE 클러스터 ${gkeWant} 가 여러 location 에 있음 (${clusters.filter((x) => String(x.name) === gkeWant).map(gkeLoc).sort().join(",")}) → "location/이름" 으로 지정`);
  const cl = pick(clusters, gkeWant, (x) => (gkeWant?.includes("/") ? `${gkeLoc(x)}/${String(x.name)}` : String(x.name)), "GKE 클러스터", notes, picks, "cluster");
  if (gkeWant && !cl) throw incomplete(`GKE 클러스터 ${gkeWant} 없음 (출발 범위 확인)`);
  // VMIMPORT: GCE VM 도 읽는다 — 명시(IMPORT_VM=1·IMPORT_GCP_VM_LABEL)했거나 GKE 가 없을 때만. 못 읽어도 계속(notes)
  const wantVm = (env.IMPORT_VM === "1" || !!env.IMPORT_GCP_VM_LABEL?.trim() || !cl);
  const vm = wantVm ? await readGce(d, project, env).catch((e) => ({ items: [unreadOrThrow(e, "gce", "GCE 인스턴스") as unknown as Obj], counts: {}, notes: [`GCE 못 읽음: ${cliReason(e, "gcloud")}`] })) : null;
  // CRIMPORT: Cloud Run 서비스·잡도 읽는다 (관리형 컨테이너 갈래, ECS 와 같은 규칙). GKE 가 없어도 Cloud Run 서비스가 있으면 계속
  const run = await readCloudRun(d, project, env).catch((e) => ({ items: [unreadOrThrow(e, "cloudrun", "Cloud Run 서비스") as unknown as Obj], counts: {}, notes: [`Cloud Run 못 읽음: ${cliReason(e, "gcloud")}`] }));
  const hasRun = run.items.some((i) => i.kind === "cloudrun.service");
  const hasVm = (vm?.items ?? []).some((i) => i.kind !== UNREAD_KIND);
  // VMIMPORT×CRIMPORT: GKE·VM·Cloud Run 서비스 셋 다 없을 때만 멈춘다. VNEW: Cloud Run 을 못 읽은 경우 이유도 붙인다 (없음과 못 읽음 구별)
  const runWhy = run.notes.find((n) => n.startsWith("Cloud Run 못 읽음"));
  if (!cl && !hasVm && !hasRun) throw incomplete(env.IMPORT_GCP_GKE_CLUSTER ? `GKE 클러스터 ${env.IMPORT_GCP_GKE_CLUSTER} 없음` : `프로젝트 ${project} 에 GKE 클러스터 없음${vm ? ` (VM 도 없음${vm.notes.length ? `: ${vm.notes[0]}` : ""})` : ""} (Cloud Run 서비스도 없음${runWhy ? `: ${runWhy.slice(0, 200)}` : ""})`);
  const name = cl ? String(cl.name) : "", loc = cl ? String(cl.location ?? cl.zone ?? "") : "";

  const app = !cl ? { items: [] as Obj[], namespace: "", counts: {} as Record<string, number>, notes: [] as string[] } : await withTempKube(`gke-${project}-${loc}-${name}`, async (kc) => {
    try { await runText(d, "gcloud", ["container", "clusters", "get-credentials", name, "--location", loc, "--project", project], { KUBECONFIG: kc }); }
    catch (e) { throw sourceFail(e, `GKE ${name} kubeconfig 만들기 실패 (${cliReason(e, "gcloud")})`); }
    try { return await readApp(d, ["--kubeconfig", kc], opts); }
    catch (e) {
      if (e instanceof CliError) throw sourceFail(e, `GKE ${name} 쿠버네티스 API 읽기 실패: ${e.message.slice(0, 160)}`);
      if ((hasRun || hasVm) && noAppInCluster(e)) return EMPTY_APP(`GKE ${name} 에 앱 Deployment 없음 → ${[hasRun ? "Cloud Run" : "", hasVm ? "VM" : ""].filter(Boolean).join("·")} 만 가져옴`);
      throw e;
    }
  });

  // RF-1: Cloud SQL 목록은 핵심이라 못 읽으면 멈춘다 (예전엔 side() 로 빈 목록 = "DB 없음"). API 를 안 켠 프로젝트만 "없음"
  const sqls = arr(await runJson(d, "gcloud", ["sql", "instances", "list", ...p]).catch((e) => {
    if (e instanceof CliError && SERVICE_DISABLED.test(e.stderr)) { notes.push("Cloud SQL API 가 꺼진 프로젝트 → Cloud SQL 없음"); return []; }
    throw sourceFail(e, `Cloud SQL 목록 못 읽음 (${cliReason(e, "gcloud")})`);
  })).filter((x) => String(x.databaseVersion ?? "").startsWith("POSTGRES_"));
  // G3b-3: Cloud SQL 도 전부 읽고 경계가 고른다. 읽기 복제본은 원본의 별칭 주소로 (따로 안 옮김)
  const wantSql = env.IMPORT_GCP_SQL_INSTANCE?.trim() || undefined;
  const sqlReplicaIps = new Map<string, string[]>();
  for (const x of sqls.filter((x) => str(x.masterInstanceName))) {
    const src = String(x.masterInstanceName).split(":").pop()!;
    sqlReplicaIps.set(src, [...(sqlReplicaIps.get(src) ?? []), ...arr(x.ipAddresses).map((a) => str(a.ipAddress)).filter((v): v is string => !!v)].sort());
  }
  const primaries = sqls.filter((x) => !str(x.masterInstanceName)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const pickedSql = wantSql ? primaries.filter((x) => x.name === wantSql) : primaries;
  const unreadDb: Obj[] = [];
  if (wantSql && !pickedSql.length) unreadDb.push(unreadItem("cloudsql.wanted", `지정한 Cloud SQL ${wantSql} 가 프로젝트 Postgres 목록에 없음 → DB 없이 명세를 만듦. 이름을 사람이 확인`));
  if (!wantSql && primaries.length > 1) notes.push(`Cloud SQL Postgres ${primaries.length}개를 모두 읽음 → 앱 경계가 근거로 고름`);
  const sqlItems: Obj[] = [];
  // GCP-SQL-NET: Cloud SQL 방화벽(posture.network)은 RDS 처럼 따로 부르지 않는다 — 목록 응답의 settings.ipConfiguration(공개 IP·승인된 네트워크)이
  //   그 자리라 그대로 넘기고 매퍼(mappers/cloudsql.ts cloudSqlIngress)가 FM-IR-02 와 같은 모양으로 바꾼다. 새 권한 없음 (cloudsql.instances.list)
  for (const db of pickedSql) {
    // N8: 데이터베이스 목록 (이름만). 못 읽으면 note
    const sqlDbs = await sideCore(`Cloud SQL ${String(db.name)} 데이터베이스`, async () => arr(await runJson(d, "gcloud", ["sql", "databases", "list", "--instance", String(db.name), ...p])).map((x) => ({ name: x.name })), notes);
    sqlItems.push({ kind: "cloudsql.instance", name: db.name, databaseVersion: db.databaseVersion,
      settings: { dataDiskSizeGb: get(db, "settings", "dataDiskSizeGb") == null ? null : String(get(db, "settings", "dataDiskSizeGb")),   // 못 읽은 값을 지어내지 않는다
        tier: get(db, "settings", "tier") ?? null,
        availabilityType: get(db, "settings", "availabilityType") ?? null, ipConfiguration: get(db, "settings", "ipConfiguration") ?? null,
          databaseFlags: Array.isArray(get(db, "settings", "databaseFlags")) ? get(db, "settings", "databaseFlags") : null,   // N8
          backupConfiguration: get(db, "settings", "backupConfiguration") ?? null, maintenanceWindow: get(db, "settings", "maintenanceWindow") ?? null },   // BK-1
      replicaNames: Array.isArray(db.replicaNames) ? db.replicaNames : null, databases: sqlDbs.length ? sqlDbs.map((x) => x.name) : null,   // N8
      region: db.region ?? null,
      ipAddresses: arr(db.ipAddresses).map((a) => ({ type: a.type ?? null, ipAddress: a.ipAddress ?? null })), selfLink: db.selfLink ?? null,
      connectionName: db.connectionName ?? null,   // DM-4: Auth Proxy·/cloudsql 소켓이 쓰는 "프로젝트:리전:인스턴스"
      ...(sqlReplicaIps.get(String(db.name))?.length ? { replicaIpAddresses: sqlReplicaIps.get(String(db.name)) } : {}) });
  }

  const [nets, fwd, repos, secrets] = await Promise.all([
    side("VPC", async () => peri("gcp.network", arr(await runJson(d, "gcloud", ["compute", "networks", "list", ...p])).map((n) => ({ name: n.name, auto: n.autoCreateSubnetworks }))), notes),
    side("부하 분산기", async () => peri("gcp.forwardingRule", arr(await runJson(d, "gcloud", ["compute", "forwarding-rules", "list", ...p])).map((f) => ({ name: f.name, ip: f.IPAddress, scheme: f.loadBalancingScheme }))), notes),
    side("Artifact Registry", async () => peri("gcp.artifactRepo", arr(await runJson(d, "gcloud", ["artifacts", "repositories", "list", ...p])).map((x) => ({ name: String(x.name ?? "").split("/").pop(), format: x.format }))), notes),
    side("Secret Manager", async () => peri("gcp.secret", arr(await runJson(d, "gcloud", ["secrets", "list", ...p])).map((x) => ({ name: String(x.name ?? "").split("/").pop() }))), notes),
  ]);

  const data = await readGcpData(d, project, notes, refsOf([...app.items, ...run.items, ...(vm?.items ?? [])]));   // I6: Cloud Storage·Pub/Sub·Memorystore. B-3: refs
  // WI-1: GKE 앱 신원(Workload Identity GSA)의 프로젝트 IAM 바인딩. opts.iam 이 꺼져 있으면 안 읽음. 못 읽으면 unread.IAM 검토 줄
  const gcpIamUnread: Obj[] = [];
  const net = await readGcpNet(d, project, notes);   // E-1·E-2
  const gcpIam = opts.iam && cl ? (await readGcpIam(d, project, appIdentities(app.items), notes, gcpIamUnread)) as unknown as Obj[] : [];
  const items: Obj[] = [
    ...app.items,
    ...data,
    ...sqlItems, ...unreadDb, ...picks,
    ...(cl ? [{ kind: "gke.cluster", name, location: loc, version: cl.currentMasterVersion ?? null }] : []),
    ...(vm?.items ?? []),
    ...run.items,
    ...nets, ...fwd, ...repos, ...secrets, ...gcpIam, ...gcpIamUnread, ...net,
    { ...dnsUnreadStub("clouddns") },   // GW-2 STUB: DNS 읽기 권한 TODO(human) (import/dns-records.ts)
    ...[...notes, ...app.notes, ...(vm?.notes ?? []), ...run.notes].map(note),
  ];
  return { provider: "gcp", items, coverage: coverage(items, { ...app.counts, ...(vm?.counts ?? {}), ...run.counts }) };
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
    // RF-1: 안 깔림이 아닌 오류(권한·시간 초과)는 "DB 없음"이 아니다 → 멈춘다 (일시 → 재시도)
    else throw sourceFail(e, `CNPG 클러스터 목록 못 읽음 (${cliReason(e, "kubectl")})`);
  }
  const nm = (x: Obj) => `${str(get(x, "metadata", "namespace"))}/${str(get(x, "metadata", "name"))}`;
  // G3b-3·RF-3: CNPG 도 전부 읽고 경계가 근거(-rw 주소)로 고른다 (예전: 앱 네임스페이스에 없으면 다른 네임스페이스 것을 이름순으로 고름).
  //   지정했는데 없으면 조용히 DB 없음이 아니라 검토 줄
  const wantCnpg = env.IMPORT_ONPREM_CNPG?.trim() || undefined;
  const cnpgPicked = (wantCnpg ? cnpg.filter((x) => nm(x) === wantCnpg || get(x, "metadata", "name") === wantCnpg) : cnpg).sort((a, b) => nm(a).localeCompare(nm(b)));
  const unreadDb: Obj[] = wantCnpg && !cnpgPicked.length ? [unreadItem("cnpg.wanted", `지정한 CNPG ${wantCnpg} 가 클러스터에 없음 → DB 없이 명세를 만듦. 이름을 사람이 확인`)] : [];
  if (!wantCnpg && cnpgPicked.length > 1) notes.push(`CNPG 클러스터 ${cnpgPicked.length}개를 모두 읽음 → 앱 경계가 근거로 고름`);

  const items: Obj[] = [
    ...app.items,
    ...cnpgPicked.map((db) => ({ kind: "cnpg.cluster", metadata: { name: get(db, "metadata", "name"), namespace: get(db, "metadata", "namespace") },
            // DM-3: 버전 칸(spec.postgresVersion)과 실제 이미지(status.image)도 넘긴다. 매퍼가 태그 자리만 읽는다
      ...(str(get(db, "status", "image")) ? { status: { image: str(get(db, "status", "image")) } } : {}),
      spec: { imageName: str(get(db, "spec", "imageName")) ?? undefined,
              ...(get(db, "spec", "postgresVersion") != null ? { postgresVersion: get(db, "spec", "postgresVersion") } : {}),
              storage: { size: str(get(db, "spec", "storage", "size")) ?? null }, instances: get(db, "spec", "instances") ?? null,
              ...(get(db, "spec", "walStorage") ? { walStorage: { size: str(get(db, "spec", "walStorage", "size")) ?? null } } : {}),   // DM-8
              // N8·SSL-1: 파라미터·pg_hba·처음 DB·자원
              postgresql: get(db, "spec", "postgresql") ? { parameters: get(db, "spec", "postgresql", "parameters") ?? undefined, pg_hba: get(db, "spec", "postgresql", "pg_hba") ?? undefined } : undefined,
                bootstrap: get(db, "spec", "bootstrap", "initdb", "database") || get(db, "spec", "bootstrap", "initdb", "owner")
                  ? { initdb: { database: get(db, "spec", "bootstrap", "initdb", "database") ?? undefined, owner: get(db, "spec", "bootstrap", "initdb", "owner") ?? undefined } } : undefined,   // DBN-1: 소유 역할
                resources: get(db, "spec", "resources") ?? undefined,
                backup: get(db, "spec", "backup") ? { retentionPolicy: get(db, "spec", "backup", "retentionPolicy") ?? null, barmanObjectStore: get(db, "spec", "backup", "barmanObjectStore") ? true : null } : null } })),   // BK-1
    ...unreadDb,
    ...nodes.map((n) => ({ kind: "k8s.node", name: get(n, "metadata", "name"), version: get(n, "status", "nodeInfo", "kubeletVersion") ?? null,
      cpu: get(n, "status", "allocatable", "cpu") ?? null, memory: get(n, "status", "allocatable", "memory") ?? null })),
    ...[...notes, ...app.notes].map(note),
  ];
  return { provider: "onprem", items, coverage: coverage(items, app.counts) };
}

/** 감사·화면에 남길 판: 환경변수는 이름만 (평문 값은 비밀일 수 있다, Z38b). 원본은 바꾸지 않는다.
 *  I2: env 가 있는 모든 워크로드의 containers·initContainers 에 적용하고, 값이 박힐 수 있는 command·args 도 지운다
 *  IA-1: pod 템플릿이 있는 모든 k8s 종류, 프로브·수명 훅 exec 명령까지 */
// VI3bfix: 감사 사본에서 값을 가리는 주소 칸 (종류별). 가져오기 매퍼는 원본을 읽으므로 명세에는 영향 없음
const ADDRESS_KEYS: Record<string, readonly string[]> = {
  "rds.dbInstance": ["Endpoint"],
  [DATA_RAW_KINDS.elasticache]: ["PrimaryEndpoint", "ConfigurationEndpoint", "ReaderEndpoint"],   // G3b-4: 읽기 주소도
  [DATA_RAW_KINDS.memorystore]: ["host", "readEndpoint"],
};
const hasPodSpec = (o: unknown, depth = 0): boolean => {
  if (!o || typeof o !== "object" || depth > 8) return false;
  if (Array.isArray(o)) return o.some((x) => hasPodSpec(x, depth + 1));
  if (Array.isArray((o as Obj).containers)) return true;
  return Object.values(o as Obj).some((v) => hasPodSpec(v, depth + 1));
};
export function inventoryForAudit(inv: RawInventory): RawInventory {
  // IA-1: 프로브 exec 명령(redis-cli -a 비번 같은 값이 박힘)도 지운다. "exec 프로브였다"는 남김 (exec: {})
  const scrub = (pod: unknown) => {
    for (const key of ["containers", "initContainers", "ephemeralContainers"])
      for (const c of arr(get(pod, key))) {
        if (Array.isArray(c.env)) c.env = arr(c.env).map((e) => ({ name: e.name }));
        delete c.args; delete c.command;
        for (const pk of ["readinessProbe", "livenessProbe", "startupProbe"]) {
          const pr = c[pk] as Obj | undefined;
          if (pr && typeof pr === "object" && pr.exec && typeof pr.exec === "object") pr.exec = {};
        }
      }
  };
  // IA-1: 종류 이름 목록(deployment·cronjob) 대신 모양으로 파드 템플릿을 찾는다 → StatefulSet·DaemonSet·Job 이 새로 들어와도 가림.
  //   containers 배열을 가진 객체(파드 spec 모양)를 다 찾는다. 깊이 상한은 남용 막기
  const scrubPods = (o: unknown, depth = 0): void => {
    if (!o || typeof o !== "object" || depth > 8) return;
    if (Array.isArray((o as Obj).containers)) scrub(o);
    for (const v of Array.isArray(o) ? o : Object.values(o as Obj)) scrubPods(v, depth + 1);
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
    // N3 DRAFT(ai): ConfigMap 값은 감사 판에 안 남긴다 (키 이름만 = 예전 원본과 같은 모양). 가져오기 매퍼는 원본 inv 를 읽는다
    if (i.kind === "k8s.configMapKeys" && "data" in i) { const c = { ...i } as Obj; delete c.data; return c; }
    if (hasPodSpec(i)) {
      const copy = JSON.parse(JSON.stringify(i)) as Obj;
      scrubPods(copy);
      return copy;
    }
    {
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
  });
  return { provider: inv.provider, coverage: inv.coverage, items };
}

export async function discoverSource(p: Provider, d0: CliDeps = {}, opts: DiscoverOpts = {}): Promise<RawInventory> {
  const d: CliDeps = opts.scope ? { ...d0, env: scopedEnv(d0.env ?? process.env, opts.scope) } : d0;   // K-1
  if (p === "aws") return discoverAws(d, opts);
  if (p === "gcp") return discoverGcp(d, opts);
  if (p === "onprem") return discoverOnprem(d, opts);
  throw unavailable("Azure 는 Mock 실행기만 있어 출발 환경으로 읽을 실자원이 없음 (결정: 진짜 Azure 안 만듦)");
}

/** 가져오기 진입점. MOCK_SEED=1 이면 데모 원본 DEMO_INVENTORY[p], 아니면 진짜 읽기. I9: aws 데모는 ECS 3티어 */
export async function discoverForImport(p: Provider, opts: DiscoverOpts = {}, d: CliDeps = {}): Promise<RawInventory> {
  if (mockSeed(d.env ?? process.env)) return DEMO_INVENTORY[p];
  return discoverSource(p, d, opts);
}
