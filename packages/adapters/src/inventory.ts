import { envNumber, type BillingFacts, type Provider } from "@svc/contracts";
import { spawnExec, type Exec } from "./terraform/real-runner.js";
import type { ResourceState, RunnerStatus } from "./common/runner.js";
import { SERVICE_NAME, type ServiceCategory } from "./common/service-map.js";
import { arr, str as s, get, lastLine, maskAccount, awsRegion, gcpRegion, onpremContext } from "./common/cli.js";
import { AWS_BILLING_EXTRA, GCP_BILLING_EXTRA, awsBilling, gcpBilling, type RawByKey } from "./inventory-billing.js";

// Z86: 환경 실자원 읽기 (읽기 전용). 클라우드 SDK 를 새로 넣지 않고 맥에 이미 있는 CLI 를 쓴다 — tools/cloud-zero.sh 와 같은 명령 묶음
//   AWS  : aws sts get-caller-identity → eks list-clusters · rds describe-db-instances · ec2 describe-vpcs · elbv2 describe-load-balancers · ecr describe-repositories
//   GCP  : gcloud container clusters list · sql instances list · compute networks list · compute forwarding-rules list · artifacts repositories list
//   온프레: pull 모드(기본)는 Agent 가 보낸 마지막 보고(하트비트·facts). 플랫폼은 고객 클러스터에 붙을 길이 없다 (들어오는 포트 0)
//          push 시연(ONPREM_FLOOR_VIA_GIT=0, 로컬 k3d)만 kubectl --context <ONPREM_KUBE_CONTEXT, 기본 k3d-onprem> get nodes · clusters.postgresql.cnpg.io · deployments · services
//   Azure: Mock 실행기 상태 (진짜 Azure 는 만들지 않기로 함)
// 규칙: 쓰기 명령 0개(인자 배열 고정, 셸 없음, 사용자 입력이 인자에 안 들어감). 자격·CLI 가 없으면 가짜 값 없이 status "unavailable" + 이유.
// 명령 하나가 실패하면 그 묶음만 error 로 두고 나머지는 보여 준다
// INVENTORY_CLI=0 이면 아예 부르지 않는다 (시험·CI)
// #242: 클라우드 CLI 읽기는 worker 만 부른다 (jobs/inventory-refresh.ts 가 빌린 관찰 자격을 d.env 로 넘김). api 는 저장된 결과만 읽고 Azure Mock·Agent 보고만 직접 읽는다

export interface InventoryItem { name: string; status: string | null; detail: string | null }
export interface InventoryGroup { category: ServiceCategory; service: string; items: InventoryItem[]; error: string | null }
export interface CloudInventory {
  provider: Provider;
  status: "ok" | "partial" | "unavailable";
  reason: string | null;            // unavailable·partial 일 때 사람이 읽는 이유
  source: "aws-cli" | "gcloud" | "kubectl" | "agent" | "azure-mock" | "none";
  scope: string | null;             // 계정·프로젝트·kube context
  region: string | null;
  checkedAt: string;
  elapsedMs: number;
  groups: InventoryGroup[];
  /** 비용 계산용 사실 (inventory-billing.ts). AWS·GCP 만. 예전에 저장한 결과에는 없다 */
  billing?: BillingFacts;
}

// key = 관찰 권한 표(common/observe-permissions.ts)의 "서비스 동사". 비용 사실이 같은 응답을 다시 쓸 때 이 열쇠로 찾는다
interface Cmd { key: string; category: ServiceCategory; args: string[]; parse: (j: unknown) => InventoryItem[] }

// Z104: JSON 읽기 조각·리전 기본값·계정 가림은 common/cli.ts 하나로 (Z88 discover·Z97 precheck 와 같은 함수)
export { maskAccount };

function awsCmds(region: string): Cmd[] {
  const r = ["--region", region, "--output", "json"];
  return [
    { key: "eks list-clusters", category: "cluster", args: ["eks", "list-clusters", ...r], parse: (j) => arr(get(j, "clusters")).map((n) => ({ name: String(n), status: null, detail: null })) },
    { key: "rds describe-db-instances", category: "database", args: ["rds", "describe-db-instances", ...r], parse: (j) => arr(get(j, "DBInstances")).map((d) => ({
      name: s(d.DBInstanceIdentifier) ?? "?", status: s(d.DBInstanceStatus),
      detail: [s(d.Engine), s(d.EngineVersion), s(d.DBInstanceClass), d.AllocatedStorage ? `${s(d.AllocatedStorage)}GB` : null].filter(Boolean).join(" · ") })) },
    { key: "ec2 describe-vpcs", category: "network", args: ["ec2", "describe-vpcs", ...r], parse: (j) => arr(get(j, "Vpcs")).map((v) => ({
      name: s(arr(v.Tags).find((t) => t.Key === "Name")?.Value) ?? s(v.VpcId) ?? "?", status: s(v.State),
      detail: [s(v.VpcId), s(v.CidrBlock), v.IsDefault ? "기본 VPC" : null].filter(Boolean).join(" · ") })) },
    { key: "elbv2 describe-load-balancers", category: "ingress", args: ["elbv2", "describe-load-balancers", ...r], parse: (j) => arr(get(j, "LoadBalancers")).map((l) => ({
      name: s(l.LoadBalancerName) ?? "?", status: s(get(l, "State", "Code")), detail: [s(l.Type), s(l.Scheme)].filter(Boolean).join(" · ") })) },
    { key: "ecr describe-repositories", category: "registry", args: ["ecr", "describe-repositories", ...r], parse: (j) => arr(get(j, "repositories")).map((x) => ({
      name: s(x.repositoryName) ?? "?", status: null, detail: null })) },
  ];
}

function gcpCmds(project: string): Cmd[] {
  const p = ["--project", project, "--format", "json"];
  return [
    { key: "container clusters list", category: "cluster", args: ["container", "clusters", "list", ...p], parse: (j) => arr(j).map((c) => ({
      name: s(c.name) ?? "?", status: s(c.status), detail: [s(c.location), s(c.currentMasterVersion), c.currentNodeCount ? `노드 ${s(c.currentNodeCount)}개` : null].filter(Boolean).join(" · ") })) },
    { key: "sql instances list", category: "database", args: ["sql", "instances", "list", ...p], parse: (j) => arr(j).map((d) => ({
      name: s(d.name) ?? "?", status: s(d.state), detail: [s(d.databaseVersion), s(get(d, "settings", "tier")), s(d.region)].filter(Boolean).join(" · ") })) },
    { key: "compute networks list", category: "network", args: ["compute", "networks", "list", ...p], parse: (j) => arr(j).map((n) => ({
      name: s(n.name) ?? "?", status: null, detail: n.autoCreateSubnetworks ? "자동 서브넷" : "사용자 서브넷" })) },
    { key: "compute forwarding-rules list", category: "ingress", args: ["compute", "forwarding-rules", "list", ...p], parse: (j) => arr(j).map((f) => ({
      name: s(f.name) ?? "?", status: null, detail: [s(f.IPAddress), s(f.loadBalancingScheme)].filter(Boolean).join(" · ") })) },
    { key: "artifacts repositories list", category: "registry", args: ["artifacts", "repositories", "list", ...p], parse: (j) => arr(j).map((x) => ({
      name: (s(x.name) ?? "?").split("/").pop()!, status: null, detail: s(x.format) })) },
  ];
}

function kubeCmds(ctx: string): Cmd[] {
  const k = ["--context", ctx, "--request-timeout=5s", "-o", "json"];
  const items = (j: unknown) => arr(get(j, "items"));
  const nm = (o: Record<string, unknown>) => `${s(get(o, "metadata", "namespace")) ? s(get(o, "metadata", "namespace")) + "/" : ""}${s(get(o, "metadata", "name")) ?? "?"}`;
  const sys = (o: Record<string, unknown>) => /^(kube-|cnpg-system|cert-manager|argocd|external-secrets)/.test(s(get(o, "metadata", "namespace")) ?? "");
  return [
    { key: "get nodes", category: "cluster", args: ["get", "nodes", ...k], parse: (j) => items(j).map((n) => ({
      name: s(get(n, "metadata", "name")) ?? "?",
      status: arr(get(n, "status", "conditions")).find((c) => c.type === "Ready")?.status === "True" ? "Ready" : "NotReady",
      detail: [s(get(n, "status", "nodeInfo", "kubeletVersion")), s(get(n, "status", "capacity", "cpu")) ? `CPU ${s(get(n, "status", "capacity", "cpu"))}` : null].filter(Boolean).join(" · ") })) },
    { key: "get cnpg", category: "database", args: ["get", "clusters.postgresql.cnpg.io", "-A", ...k], parse: (j) => items(j).map((c) => ({
      name: nm(c), status: s(get(c, "status", "phase")), detail: [`인스턴스 ${s(get(c, "spec", "instances")) ?? "?"}개`, s(get(c, "spec", "storage", "size"))].filter(Boolean).join(" · ") })) },
    { key: "get deployments", category: "workload", args: ["get", "deployments", "-A", ...k], parse: (j) => items(j).filter((d) => !sys(d)).map((d) => ({
      name: nm(d), status: `${s(get(d, "status", "readyReplicas")) ?? 0}/${s(get(d, "spec", "replicas")) ?? 0} 준비`, detail: s(get(d, "spec", "template", "spec", "containers", "0", "image")) })) },
    { key: "get services", category: "ingress", args: ["get", "services", "-A", ...k], parse: (j) => items(j).filter((v) => !sys(v) && s(get(v, "metadata", "name")) !== "kubernetes").map((v) => ({
      name: nm(v), status: s(get(v, "spec", "type")), detail: arr(get(v, "spec", "ports")).map((p) => s(p.port)).join(",") || null })) },
  ];
}

// 온프레 pull 모드에서 api 가 DB(agent_keys·agent_reports)에서 읽어 넘기는 값. 판정 기준은 연결 확인·사전 점검과 같다 (살아 있는 키, AGENT_STALE_SEC)
export interface AgentInventory {
  keys: number; heartbeatAgeSec: number | null; staleSec: number; k3sVersion: string | null;
  cnpg: { cluster: string; ready: boolean } | null;   // 마지막 하트비트
  dbs: { namespace: string; cluster: string; majorVersion: number | null; tlsEnforced: boolean | null; exposed: boolean | null }[] | null;   // 마지막 facts (없으면 null)
}
export interface InventoryDeps { exec?: Exec; env?: NodeJS.ProcessEnv; now?: () => Date; azureStatus?: () => Promise<RunnerStatus>; agent?: () => Promise<AgentInventory> }

/** 온프레 pull 모드 실자원 = Agent 마지막 보고. Agent 가 보내지 않는 것(Deployment·Service 목록)은 지어내지 않고 묶음을 안 만든다 */
export function agentInventory(a: AgentInventory, t0: number, now: Date): CloudInventory {
  const scope = `Agent 키 ${a.keys}개`;
  if (a.keys <= 0) return unavailable("onprem", "agent", "확인 불가: Agent 키 없음 (AGENT_KEY_MISSING) — 콘솔 등록 토큰으로 onprem-agent --enroll", t0, now, scope);
  if (a.heartbeatAgeSec == null) return unavailable("onprem", "agent", "확인 불가: Agent 하트비트가 한 번도 안 옴 (AGENT_HEARTBEAT_STALE)", t0, now, scope);
  if (a.heartbeatAgeSec > a.staleSec)
    return unavailable("onprem", "agent", `확인 불가: 마지막 Agent 하트비트 ${a.heartbeatAgeSec}초 전 (기준 ${a.staleSec}초, AGENT_HEARTBEAT_STALE)`, t0, now, scope);
  const yn = (v: boolean | null, y: string, n: string) => v == null ? null : v ? y : n;
  const dbs: InventoryItem[] = a.dbs
    ? a.dbs.map((d) => ({ name: `${d.namespace}/${d.cluster}`, status: null,
        detail: [d.majorVersion ? `PostgreSQL ${d.majorVersion}` : null, yn(d.tlsEnforced, "TLS 강제", "TLS 미강제"), yn(d.exposed, "바깥 노출", "클러스터 안만")].filter(Boolean).join(" · ") || null }))
    : a.cnpg ? [{ name: a.cnpg.cluster, status: a.cnpg.ready ? "Ready" : "NotReady", detail: null }] : [];
  const groups: InventoryGroup[] = [
    { category: "cluster", service: SERVICE_NAME.onprem.cluster, error: null,
      items: [{ name: "k3s", status: "Ready", detail: [a.k3sVersion, `하트비트 ${a.heartbeatAgeSec}초 전`].filter(Boolean).join(" · ") }] },
    { category: "database", service: SERVICE_NAME.onprem.database, error: null, items: dbs },
  ];
  return { provider: "onprem", status: "ok", reason: "Agent 보고 기준 (플랫폼은 클러스터에 직접 붙지 않음). Deployment·Service 목록은 Agent 가 보내지 않아 없음",
    source: "agent", scope, region: "local", checkedAt: now.toISOString(), elapsedMs: Math.round(performance.now() - t0), groups };
}

// 명령 하나 → JSON 또는 이유. 묶음과 비용 사실이 같이 쓴다
async function runRaw(bin: string, args: string[], exec: Exec, env: NodeJS.ProcessEnv): Promise<RawByKey[string] & object> {
  const r = await exec(bin, args, { cwd: process.cwd(), env, timeoutMs: envNumber(env.INVENTORY_TIMEOUT_MS, 10000) });
  if (r.code !== 0) return { ok: false, error: lastLine(r.stderr) || `exit ${r.code}` };
  try { return { ok: true, json: JSON.parse(r.stdout || "null") }; }
  catch (e) { return { ok: false, error: `응답 해석 실패: ${(e as Error).message.slice(0, 100)}` }; }
}

async function runGroups(bin: string, cmds: Cmd[], provider: Provider, exec: Exec, env: NodeJS.ProcessEnv, raw: RawByKey = {}): Promise<InventoryGroup[]> {
  return Promise.all(cmds.map(async (c) => {
    const r = await runRaw(bin, c.args, exec, env);
    raw[c.key] = r;
    const service = SERVICE_NAME[provider][c.category];
    if (!r.ok) return { category: c.category, service, items: [], error: r.error };
    try { return { category: c.category, service, items: c.parse(r.json), error: null }; }
    catch (e) { return { category: c.category, service, items: [], error: `응답 해석 실패: ${(e as Error).message.slice(0, 100)}` }; }
  }));
}

// 비용 사실용으로 더 부르는 명령 (묶음과 동시에). 실패해도 묶음·건강에는 영향 없음
async function runExtra(bin: string, extra: Record<string, string[]>, exec: Exec, env: NodeJS.ProcessEnv, raw: RawByKey): Promise<void> {
  await Promise.all(Object.entries(extra).map(async ([key, args]) => { raw[key] = await runRaw(bin, args, exec, env); }));
}

const unavailable = (provider: Provider, source: CloudInventory["source"], reason: string, t0: number, now: Date, scope: string | null = null, region: string | null = null): CloudInventory =>
  ({ provider, status: "unavailable", reason, source, scope, region, checkedAt: now.toISOString(), elapsedMs: Math.round(performance.now() - t0), groups: [] });

const done = (provider: Provider, source: CloudInventory["source"], scope: string | null, region: string | null, groups: InventoryGroup[], t0: number, now: Date): CloudInventory => {
  const bad = groups.filter((g) => g.error);
  return { provider, source, scope, region, groups, checkedAt: now.toISOString(), elapsedMs: Math.round(performance.now() - t0),
    status: bad.length === 0 ? "ok" : bad.length === groups.length ? "unavailable" : "partial",
    reason: bad.length ? `${bad.map((g) => g.service).join(", ")} 읽기 실패: ${bad[0]!.error}` : null };
};

/** 어떤 이유로 읽지 않았을 때의 결과. 묶음 없음, 이유만 (가짜 값 없음) */
export function inventoryUnavailable(provider: Provider, reason: string, now: Date = new Date()): CloudInventory {
  const source = ({ aws: "aws-cli", gcp: "gcloud", onprem: "kubectl", azure_mock: "azure-mock" } as const)[provider];
  return unavailable(provider, source, reason, performance.now(), now);
}

/** 환경 하나의 실자원. 저장은 부르는 쪽 몫 */
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
  // Agent 보고는 CLI 가 아니라서 INVENTORY_CLI=0 과 상관없이 읽는다
  if (provider === "onprem" && d.agent) return agentInventory(await d.agent(), t0, now());
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
    const raw: RawByKey = {};
    const r = ["--region", region, "--output", "json"];
    const extra = Object.fromEntries(Object.entries(AWS_BILLING_EXTRA).map(([k, a]) => [k, [...a, ...r]]));
    const [groups] = await Promise.all([runGroups("aws", awsCmds(region), provider, exec, env, raw), runExtra("aws", extra, exec, env, raw)]);
    return { ...done(provider, "aws-cli", scope, region, groups, t0, now()), billing: awsBilling(raw) };
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
    const raw: RawByKey = {};
    const extra = Object.fromEntries(Object.entries(GCP_BILLING_EXTRA).map(([k, a]) => [k, a(project)]));
    const [groups] = await Promise.all([runGroups("gcloud", gcpCmds(project), provider, exec, env, raw), runExtra("gcloud", extra, exec, env, raw)]);
    return { ...done(provider, "gcloud", `프로젝트 ${project}`, region, groups, t0, now()), billing: gcpBilling(raw) };
  }
  // onprem push 시연 (d.agent 없음): kubectl
  const ctx = onpremContext(env);
  const v = await exec("kubectl", ["version", "--client", "-o", "json"], { cwd: process.cwd(), env, timeoutMs: 5000 });
  if (v.code === 127) return unavailable(provider, "kubectl", "확인 불가: kubectl 명령이 없음", t0, now(), `context ${ctx}`);
  const inv = done(provider, "kubectl", `context ${ctx}`, "local", await runGroups("kubectl", kubeCmds(ctx), provider, exec, env), t0, now());
  // CNPG 가 안 깔린 클러스터면 database 묶음만 "종류 없음" → 오류가 아니라 0개로
  for (const g of inv.groups) if (g.category === "database" && g.error && /the server doesn't have a resource type/i.test(g.error)) g.error = null;
  return { ...inv, ...(inv.groups.every((g) => !g.error) ? { status: "ok" as const, reason: null } : {}) };
}

// Z100 (기능 #4): GET /environments/:id/status 의 aws·gcp·onprem 칸을 실자원 읽기로 채운다.
//   예전: 진짜 실행기가 없어 health "unknown" + 빈 목록(stubStatus). 이제 같은 CLI 읽기 결과(#242 부터는 worker 가 저장한 값)를 실행기 상태 모양으로 바꾼다.
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
