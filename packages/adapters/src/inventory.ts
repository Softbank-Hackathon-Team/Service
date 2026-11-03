import { envNumber, type Provider } from "@svc/contracts";
import { spawnExec, type Exec } from "./terraform/real-runner.js";
import type { ResourceState, RunnerStatus } from "./common/runner.js";
import { SERVICE_NAME, type ServiceCategory } from "./common/service-map.js";
import { arr, str as s, get, lastLine, maskAccount, awsRegion, gcpRegion, onpremContext } from "./common/cli.js";

// Z86: 환경 실자원 읽기 (읽기 전용). 클라우드 SDK 를 새로 넣지 않고 맥에 이미 있는 CLI 를 쓴다 — tools/cloud-zero.sh 와 같은 명령 묶음
//   AWS  : aws sts get-caller-identity → eks list-clusters · rds describe-db-instances · ec2 describe-vpcs · elbv2 describe-load-balancers · ecr describe-repositories
//   GCP  : gcloud container clusters list · sql instances list · compute networks list · compute forwarding-rules list · artifacts repositories list
//   온프레: kubectl --context <ONPREM_KUBE_CONTEXT, 기본 k3d-onprem> get nodes · clusters.postgresql.cnpg.io · deployments · services
//   Azure: Mock 실행기 상태 (진짜 Azure 는 만들지 않기로 함)
// 규칙: 쓰기 명령 0개(인자 배열 고정, 셸 없음, 사용자 입력이 인자에 안 들어감). 자격·CLI 가 없으면 가짜 값 없이 status "unavailable" + 이유.
// 명령 하나가 실패하면 그 묶음만 error 로 두고 나머지는 보여 준다. 결과는 환경별 30초 캐시 (INVENTORY_CACHE_SEC)
// INVENTORY_CLI=0 이면 아예 부르지 않는다 (시험·CI)
// STUB(L5c): 이 읽기는 API 프로세스에서 돌고, 임시 역할 중개자(보관함·장부)는 워커에만 있다 → 아직 프로세스 자격(맥 프로필)으로 읽는다.
//   precheck 는 워커라 빌린 관찰 자격으로 바꿨다 (L5c). 상태·인벤토리 화면은 발표에서 "프로세스 자격"이라고 숨기지 않는다
// TODO(human): 인벤토리·상태를 빌린 자격으로 바꾸는 길 — (a) API 가 워커에 읽기 작업(큐)을 맡기고 결과 캐시를 읽음 (b) API 에도 중개자를 둠(보관함이 프로세스마다 생김)

export interface InventoryItem { name: string; status: string | null; detail: string | null }
export interface InventoryGroup { category: ServiceCategory; service: string; items: InventoryItem[]; error: string | null }
export interface CloudInventory {
  provider: Provider;
  status: "ok" | "partial" | "unavailable";
  reason: string | null;            // unavailable·partial 일 때 사람이 읽는 이유
  source: "aws-cli" | "gcloud" | "kubectl" | "azure-mock" | "none";
  scope: string | null;             // 계정·프로젝트·kube context
  region: string | null;
  checkedAt: string;
  elapsedMs: number;
  groups: InventoryGroup[];
}

interface Cmd { category: ServiceCategory; args: string[]; parse: (j: unknown) => InventoryItem[] }

// Z104: JSON 읽기 조각·리전 기본값·계정 가림은 common/cli.ts 하나로 (Z88 discover·Z97 precheck 와 같은 함수)
export { maskAccount };

function awsCmds(region: string): Cmd[] {
  const r = ["--region", region, "--output", "json"];
  return [
    { category: "cluster", args: ["eks", "list-clusters", ...r], parse: (j) => arr(get(j, "clusters")).map((n) => ({ name: String(n), status: null, detail: null })) },
    { category: "database", args: ["rds", "describe-db-instances", ...r], parse: (j) => arr(get(j, "DBInstances")).map((d) => ({
      name: s(d.DBInstanceIdentifier) ?? "?", status: s(d.DBInstanceStatus),
      detail: [s(d.Engine), s(d.EngineVersion), s(d.DBInstanceClass), d.AllocatedStorage ? `${s(d.AllocatedStorage)}GB` : null].filter(Boolean).join(" · ") })) },
    { category: "network", args: ["ec2", "describe-vpcs", ...r], parse: (j) => arr(get(j, "Vpcs")).map((v) => ({
      name: s(arr(v.Tags).find((t) => t.Key === "Name")?.Value) ?? s(v.VpcId) ?? "?", status: s(v.State),
      detail: [s(v.VpcId), s(v.CidrBlock), v.IsDefault ? "기본 VPC" : null].filter(Boolean).join(" · ") })) },
    { category: "ingress", args: ["elbv2", "describe-load-balancers", ...r], parse: (j) => arr(get(j, "LoadBalancers")).map((l) => ({
      name: s(l.LoadBalancerName) ?? "?", status: s(get(l, "State", "Code")), detail: [s(l.Type), s(l.Scheme)].filter(Boolean).join(" · ") })) },
    { category: "registry", args: ["ecr", "describe-repositories", ...r], parse: (j) => arr(get(j, "repositories")).map((x) => ({
      name: s(x.repositoryName) ?? "?", status: null, detail: null })) },
  ];
}

function gcpCmds(project: string): Cmd[] {
  const p = ["--project", project, "--format", "json"];
  return [
    { category: "cluster", args: ["container", "clusters", "list", ...p], parse: (j) => arr(j).map((c) => ({
      name: s(c.name) ?? "?", status: s(c.status), detail: [s(c.location), s(c.currentMasterVersion), c.currentNodeCount ? `노드 ${s(c.currentNodeCount)}개` : null].filter(Boolean).join(" · ") })) },
    { category: "database", args: ["sql", "instances", "list", ...p], parse: (j) => arr(j).map((d) => ({
      name: s(d.name) ?? "?", status: s(d.state), detail: [s(d.databaseVersion), s(get(d, "settings", "tier")), s(d.region)].filter(Boolean).join(" · ") })) },
    { category: "network", args: ["compute", "networks", "list", ...p], parse: (j) => arr(j).map((n) => ({
      name: s(n.name) ?? "?", status: null, detail: n.autoCreateSubnetworks ? "자동 서브넷" : "사용자 서브넷" })) },
    { category: "ingress", args: ["compute", "forwarding-rules", "list", ...p], parse: (j) => arr(j).map((f) => ({
      name: s(f.name) ?? "?", status: null, detail: [s(f.IPAddress), s(f.loadBalancingScheme)].filter(Boolean).join(" · ") })) },
    { category: "registry", args: ["artifacts", "repositories", "list", ...p], parse: (j) => arr(j).map((x) => ({
      name: (s(x.name) ?? "?").split("/").pop()!, status: null, detail: s(x.format) })) },
  ];
}

function kubeCmds(ctx: string): Cmd[] {
  const k = ["--context", ctx, "--request-timeout=5s", "-o", "json"];
  const items = (j: unknown) => arr(get(j, "items"));
  const nm = (o: Record<string, unknown>) => `${s(get(o, "metadata", "namespace")) ? s(get(o, "metadata", "namespace")) + "/" : ""}${s(get(o, "metadata", "name")) ?? "?"}`;
  const sys = (o: Record<string, unknown>) => /^(kube-|cnpg-system|cert-manager|argocd|external-secrets)/.test(s(get(o, "metadata", "namespace")) ?? "");
  return [
    { category: "cluster", args: ["get", "nodes", ...k], parse: (j) => items(j).map((n) => ({
      name: s(get(n, "metadata", "name")) ?? "?",
      status: arr(get(n, "status", "conditions")).find((c) => c.type === "Ready")?.status === "True" ? "Ready" : "NotReady",
      detail: [s(get(n, "status", "nodeInfo", "kubeletVersion")), s(get(n, "status", "capacity", "cpu")) ? `CPU ${s(get(n, "status", "capacity", "cpu"))}` : null].filter(Boolean).join(" · ") })) },
    { category: "database", args: ["get", "clusters.postgresql.cnpg.io", "-A", ...k], parse: (j) => items(j).map((c) => ({
      name: nm(c), status: s(get(c, "status", "phase")), detail: [`인스턴스 ${s(get(c, "spec", "instances")) ?? "?"}개`, s(get(c, "spec", "storage", "size"))].filter(Boolean).join(" · ") })) },
    { category: "workload", args: ["get", "deployments", "-A", ...k], parse: (j) => items(j).filter((d) => !sys(d)).map((d) => ({
      name: nm(d), status: `${s(get(d, "status", "readyReplicas")) ?? 0}/${s(get(d, "spec", "replicas")) ?? 0} 준비`, detail: s(get(d, "spec", "template", "spec", "containers", "0", "image")) })) },
    { category: "ingress", args: ["get", "services", "-A", ...k], parse: (j) => items(j).filter((v) => !sys(v) && s(get(v, "metadata", "name")) !== "kubernetes").map((v) => ({
      name: nm(v), status: s(get(v, "spec", "type")), detail: arr(get(v, "spec", "ports")).map((p) => s(p.port)).join(",") || null })) },
  ];
}

export interface InventoryDeps { exec?: Exec; env?: NodeJS.ProcessEnv; now?: () => Date; azureStatus?: () => Promise<RunnerStatus> }

async function runGroups(bin: string, cmds: Cmd[], provider: Provider, exec: Exec, env: NodeJS.ProcessEnv): Promise<InventoryGroup[]> {
  const timeoutMs = envNumber(env.INVENTORY_TIMEOUT_MS, 10000);
  return Promise.all(cmds.map(async (c) => {
    const r = await exec(bin, c.args, { cwd: process.cwd(), env, timeoutMs });
    const service = SERVICE_NAME[provider][c.category];
    if (r.code !== 0) return { category: c.category, service, items: [], error: lastLine(r.stderr) || `exit ${r.code}` };
    try { return { category: c.category, service, items: c.parse(JSON.parse(r.stdout || "null")), error: null }; }
    catch (e) { return { category: c.category, service, items: [], error: `응답 해석 실패: ${(e as Error).message.slice(0, 100)}` }; }
  }));
}

const unavailable = (provider: Provider, source: CloudInventory["source"], reason: string, t0: number, now: Date, scope: string | null = null, region: string | null = null): CloudInventory =>
  ({ provider, status: "unavailable", reason, source, scope, region, checkedAt: now.toISOString(), elapsedMs: Math.round(performance.now() - t0), groups: [] });

const done = (provider: Provider, source: CloudInventory["source"], scope: string | null, region: string | null, groups: InventoryGroup[], t0: number, now: Date): CloudInventory => {
  const bad = groups.filter((g) => g.error);
  return { provider, source, scope, region, groups, checkedAt: now.toISOString(), elapsedMs: Math.round(performance.now() - t0),
    status: bad.length === 0 ? "ok" : bad.length === groups.length ? "unavailable" : "partial",
    reason: bad.length ? `${bad.map((g) => g.service).join(", ")} 읽기 실패: ${bad[0]!.error}` : null };
};

/** 환경 하나의 실자원. 캐시 없음 (캐시는 cachedInventory) */
export async function readInventory(provider: Provider, d: InventoryDeps = {}): Promise<CloudInventory> {
  const env = d.env ?? process.env, exec = d.exec ?? spawnExec, now = d.now ?? (() => new Date());
  const t0 = performance.now();
  if (provider === "azure_mock") {
    if (!d.azureStatus) return unavailable(provider, "azure-mock", "Azure Mock 실행기가 꺼져 있음 (AZURE_MOCK=0)", t0, now());
    const st = await d.azureStatus();
    const cat = (type: string): ServiceCategory => /kubernetes_cluster|aks/.test(type) ? "cluster" : /container_registry/.test(type) ? "registry"
      : /virtual_network|subnet|resource_group/.test(type) ? "network" : /postgres/.test(type) ? "database" : /key_vault/.test(type) ? "secret" : "identity";
    const by = new Map<ServiceCategory, InventoryItem[]>();
    for (const r of st.resources) by.set(cat(r.type), [...(by.get(cat(r.type)) ?? []), { name: r.name, status: r.state, detail: r.type }]);
    return { provider, status: "ok", reason: "Mock: 실제 Azure 계정이 아니라 모양만 맞춘 가짜 자원", source: "azure-mock", scope: "Mock 구독", region: st.region,
      checkedAt: now().toISOString(), elapsedMs: Math.round(performance.now() - t0),
      groups: [...by].map(([category, items]) => ({ category, service: SERVICE_NAME.azure_mock[category], items, error: null })) };
  }
  if (env.INVENTORY_CLI === "0") return unavailable(provider, "none", "INVENTORY_CLI=0 (실자원 읽기 끔)", t0, now());

  if (provider === "aws") {
    const region = awsRegion(env);
    const id = await exec("aws", ["sts", "get-caller-identity", "--output", "json"], { cwd: process.cwd(), env, timeoutMs: 8000 });
    if (id.code === 127) return unavailable(provider, "aws-cli", "확인 불가: aws 명령이 없음", t0, now(), null, region);
    if (id.code !== 0) return unavailable(provider, "aws-cli", `확인 불가: AWS 자격 없음 (${lastLine(id.stderr) || "sts 실패"})`, t0, now(), null, region);
    let account: string | null = null;
    try { account = s(get(JSON.parse(id.stdout), "Account")); } catch { /* 계정 번호 못 읽어도 목록은 읽는다 */ }
    // Z38 R8-46: 계정 번호 12자리는 화면·응답에 내지 않는다 (끝 4자리만)
    const scope = `계정 ${maskAccount(account)}${env.AWS_PROFILE ? ` · 프로필 ${env.AWS_PROFILE}` : ""}`;
    return done(provider, "aws-cli", scope, region, await runGroups("aws", awsCmds(region), provider, exec, env), t0, now());
  }
  if (provider === "gcp") {
    let project = env.GCP_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? "";
    if (!project) {
      const p = await exec("gcloud", ["config", "get-value", "project"], { cwd: process.cwd(), env, timeoutMs: 8000 });
      if (p.code === 127) return unavailable(provider, "gcloud", "확인 불가: gcloud 명령이 없음", t0, now());
      project = p.code === 0 ? p.stdout.trim() : "";
    }
    if (!project || project === "(unset)") return unavailable(provider, "gcloud", "확인 불가: GCP 프로젝트가 정해지지 않음 (GCP_PROJECT)", t0, now());
    const region = gcpRegion(env);
    return done(provider, "gcloud", `프로젝트 ${project}`, region, await runGroups("gcloud", gcpCmds(project), provider, exec, env), t0, now());
  }
  // onprem
  const ctx = onpremContext(env);
  const v = await exec("kubectl", ["version", "--client", "-o", "json"], { cwd: process.cwd(), env, timeoutMs: 5000 });
  if (v.code === 127) return unavailable(provider, "kubectl", "확인 불가: kubectl 명령이 없음", t0, now(), `context ${ctx}`);
  const inv = done(provider, "kubectl", `context ${ctx}`, "local", await runGroups("kubectl", kubeCmds(ctx), provider, exec, env), t0, now());
  // CNPG 가 안 깔린 클러스터면 database 묶음만 "종류 없음" → 오류가 아니라 0개로
  for (const g of inv.groups) if (g.category === "database" && g.error && /the server doesn't have a resource type/i.test(g.error)) g.error = null;
  return { ...inv, ...(inv.groups.every((g) => !g.error) ? { status: "ok" as const, reason: null } : {}) };
}

const CACHE = new Map<string, { at: number; v: Promise<CloudInventory> }>();
/** 환경별 30초 캐시 (같은 화면을 여러 탭이 15초마다 불러도 CLI 는 30초에 한 번) */
export function cachedInventory(key: string, provider: Provider, d: InventoryDeps = {}): Promise<CloudInventory> {
  const ttl = envNumber((d.env ?? process.env).INVENTORY_CACHE_SEC, 30) * 1000;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = readInventory(provider, d);
  CACHE.set(key, { at: Date.now(), v });
  v.catch(() => CACHE.delete(key));
  return v;
}
export const clearInventoryCache = () => CACHE.clear();

// Z100 (기능 #4): GET /environments/:id/status 의 aws·gcp·onprem 칸을 실자원 읽기로 채운다.
//   예전: 진짜 실행기가 없어 health "unknown" + 빈 목록(stubStatus). 이제 같은 CLI 읽기(cachedInventory) 결과를 실행기 상태 모양으로 바꾼다.
//   못 읽으면(unavailable) 가짜 값 없이 예전과 같은 unknown + 빈 목록.
const STATE_RULES: [RegExp, ResourceState][] = [
  [/^(creating|provisioning|pending|starting|pending_create|reconciling|setting up)/i, "Creating"],
  [/^(deleting|stopping|terminating|pending_delete)/i, "Deleting"],
  [/^(deleted|terminated)$/i, "Deleted"],
  [/^(failed|error|notready|incompatible|storage-full|unknown_state|suspended|degraded)/i, "Failed"],
];
export function itemState(status: string | null): ResourceState {
  if (!status) return "Succeeded";                       // 상태 칸이 없는 자원(VPC 이름·저장소 등) = 있음
  const ready = /^(\d+)\/(\d+) 준비$/.exec(status);       // kubectl deployments "준비 수/원하는 수"
  if (ready) return Number(ready[2]) > 0 && ready[1] !== ready[2] ? "Failed" : "Succeeded";
  for (const [re, st] of STATE_RULES) if (re.test(status)) return st;
  return "Succeeded";
}
export function inventoryToStatus(inv: CloudInventory, t: { envId: string; provider: Provider; region: string }): RunnerStatus {
  const resources = inv.groups.flatMap((g) => g.items.map((i) => ({
    type: `${g.category}:${g.service}`, name: i.name, id: i.name, state: itemState(i.status) })));
  const health: RunnerStatus["health"] = inv.status === "unavailable" ? "unknown"
    : inv.status === "partial" || resources.some((r) => r.state === "Failed") ? "degraded" : "healthy";
  return { provider: t.provider, mock: false, envId: t.envId, region: inv.region ?? t.region, health, checkedAt: inv.checkedAt, resources };
}
