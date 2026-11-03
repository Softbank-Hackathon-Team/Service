import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppSpec, AppSpecV2, MigrationStatus, Provider, type MigrationStatus as Status } from "@svc/contracts";
import { SPEC_DRAFT_KEY, withTenant } from "@svc/core";
import { aws, azure, cachedInventory, chooseRunner, gcp, onprem, resourceTypesV2For, serviceMap, stubStatus, type RunnerStatus } from "@svc/adapters";
import { EnvironmentStatus, errors } from "./responses.js";
import { IdParam, found, isoUtc } from "./kit.js";

// Z86: 읽기 전용 GET 2개
//   GET /api/v1/environments/:id/inventory   — "이 환경에 지금 무엇이 돌고 있고, 이전 때문에 무엇이 생기고 걷혔나"
//   GET /api/v1/migrations/:id/plan/resources — "이 이전에서 출발의 어떤 서비스가 도착의 어떤 서비스로, 어떤 방식으로 옮겨지나" (대응표)
// inventory 의 cloud 칸 = 클라우드에서 직접 읽은 실자원 (adapters inventory.ts: aws·gcloud·kubectl CLI 읽기 명령만, 30초 캐시).
//   자격·CLI 가 없으면 status "unavailable" + 이유 (가짜 값 없음). Azure 는 Mock 실행기 값이고 그렇게 표시한다
// 나머지 칸은 클라우드 호출 없이 세 곳에서 모은다
//   1) 환경 자체 자원 = 기존 GET /environments/:id/status 와 같은 실행기 상태 (진짜 값은 Azure Mock 만, 나머지는 health unknown)
//   2) 이전마다 이 환경 쪽 앱 자원 = 받아들인 최신 명세 + 어댑터 resourceTypes(명세) (Terraform 이 "만드는" 종류 표, 계약 테스트로 모듈과 맞춤)
//   3) 그 자원이 지금 어느 단계인가 = 이전 상태 + 감사 기록(apply 결과가 runner/terraform/STUB 중 무엇이었나, 정리 때 걷은 목록, 전환 도달 %)
// 그래서 "evidence" 칸으로 값의 출처를 같이 낸다. 클라우드에서 직접 센 값이 아니면 화면이 그렇게 표시한다 (모르면 모른다)

export const ResourceCategory = z.enum(["compute", "database", "identity", "secret", "network", "replication"]);
// planned 만들 예정 · creating 만드는 중 · running 돌고 있음 · standby 살아 있으나 트래픽 0/쓰기 막힘 · stopping 걷는 중
// stopped 0 으로 줄임(지우진 않음) · removed 걷음 · left 남아 있음(정리 확인 필요) · none 만들지 않음 · unknown 모름
export const FootprintState = z.enum(["planned", "creating", "running", "standby", "stopping", "stopped", "removed", "left", "none", "unknown"]);
// runner = 실행기(Azure Mock) 결과 · terraform = 실제 terraform apply 기록 · stub = 흉내 apply(만든 척) · adapter = 어댑터 설계표(아직 안 만듦)
// discovered = 가져오기 원본(지금은 데모 원본) · audit = 감사 기록(정리·복제 목록)
export const Evidence = z.enum(["runner", "terraform", "stub", "adapter", "discovered", "audit"]);

export const FootprintResource = z.object({
  category: ResourceCategory,
  type: z.string(),          // Terraform 자원 종류 또는 k8s 종류 (예: aws_db_instance, apps/deployments)
  label: z.string(),         // 사람이 읽는 이름 (예: "RDS PostgreSQL 16 · 20GB")
  state: FootprintState,
  evidence: Evidence,
}).strict();

export const SpecSummary = z.object({
  app: z.string(), image: z.string(), replicas: z.number().int(), cpu: z.string(), memory: z.string(), port: z.number().int(),
  hostname: z.string(), secrets: z.number().int(),
  database: z.object({ engine: z.string(), majorVersion: z.string(), storageGb: z.number().int() }).strict().nullable(),
}).strict();

export const AppFootprint = z.object({
  migrationId: z.uuid(),
  role: z.enum(["source", "target"]),       // 이 환경이 이 이전의 출발인가 도착인가
  peer: z.object({ envId: z.uuid(), name: z.string(), provider: Provider }).strict(),   // 반대편 환경
  migrationStatus: MigrationStatus,
  updatedAt: z.string(),
  stage: z.enum(["before", "changing", "after", "undone"]),   // 이전 전 · 이전 중 · 이전 끝 · 되돌림/취소/실패
  trafficPct: z.number().nullable(),        // 이 환경 쪽이 받는 트래픽 % (모르면 null)
  spec: SpecSummary.nullable(),
  resources: z.array(FootprintResource),
}).strict();

// 클라우드에서 직접 읽은 실자원 (adapters CloudInventory 를 Zod 로 옮겨 적음)
export const InventoryCategory = z.enum(["cluster", "workload", "database", "ingress", "registry", "secret", "identity", "network", "storage"]);
export const CloudInventory = z.object({
  provider: Provider,
  status: z.enum(["ok", "partial", "unavailable"]),
  reason: z.string().nullable(),
  source: z.enum(["aws-cli", "gcloud", "kubectl", "azure-mock", "none"]),
  scope: z.string().nullable(), region: z.string().nullable(), checkedAt: z.string(), elapsedMs: z.number().int(),
  groups: z.array(z.object({
    category: InventoryCategory, service: z.string(),
    items: z.array(z.object({ name: z.string(), status: z.string().nullable(), detail: z.string().nullable() }).strict()),
    error: z.string().nullable(),
  }).strict()),
}).strict();

export const EnvResources = z.object({
  envId: z.uuid(), name: z.string(), provider: Provider, generatedAt: z.string(),
  cloud: CloudInventory,                    // 실자원 (클라우드에서 직접 읽음)
  base: EnvironmentStatus,                  // 환경 자체 (리소스 그룹·네트워크 등). /status 와 같은 값
  apps: z.array(AppFootprint),
  totals: z.object({ running: z.number().int(), changing: z.number().int(), planned: z.number().int(), gone: z.number().int() }).strict(),
}).strict();
export type EnvResources = z.infer<typeof EnvResources>;
type Footprint = z.infer<typeof AppFootprint>;
type Res = z.infer<typeof FootprintResource>;
type FState = z.infer<typeof FootprintState>;

// ---- 순수 함수 (DB 없이 시험) ----

export interface MigrationRow {
  id: string; status: Status; pausedFrom: Status | null; failedAtStatus: Status | null; updatedAt: string;
  sourceEnvId: string; targetEnvId: string;
  sourceName: string; sourceProvider: Provider; targetName: string; targetProvider: Provider;
  spec: unknown;                                   // 받아들인 최신 명세 원본 (없으면 null)
  applyEvidence: "runner" | "terraform" | "stub" | null;   // provisioning → deploying 감사 줄에 무엇이 있었나
  cleanupRemoved: string[] | null;                 // 정리(→completed)·롤백 때 걷었다고 적힌 것
  reachedPct: number | null;                       // 전환이 남긴 마지막 도달 % (0~100)
  // TA11: 최신 계획서 irVersion(없으면 null = v1) + 같은 판의 spec_v2->'spec'(칸이 없거나 NULL 이면 null). 둘 다 선택 칸 → 예전 호출 그대로
  planIrVersion?: string | null;
  specV2?: unknown;
}

const TYPES: Record<Provider, (s: AppSpec) => string[]> = {
  aws: aws.resourceTypes, gcp: gcp.resourceTypes, onprem: onprem.resourceTypes, azure_mock: azure.resourceTypes,
};

// TA11 (설계 27번 A11): 계획서가 v2(irVersion "2")이고 v2 명세가 있으면 "생길 자원"은 v2 Builder 기준. 아니면 v1 그대로 (깃발 off = 지금 동작)
export function targetTypesOf(m: MigrationRow, s: AppSpec): string[] {
  if (m.planIrVersion === "2") {
    const v2 = AppSpecV2.safeParse(m.specV2);
    if (v2.success) return resourceTypesV2For(m.targetProvider, v2.data);
  }
  return TYPES[m.targetProvider](s);
}

// 종류 → (분류, 이름표). 모르는 종류는 network 로 두고 종류 이름 그대로
const KIND: Record<string, [z.infer<typeof ResourceCategory>, string]> = {
  kubernetes_namespace_v1: ["compute", "k8s 네임스페이스"],
  "core/namespaces": ["compute", "k8s 네임스페이스"], "core/resourcequotas": ["compute", "자원 한도(ResourceQuota)"],
  "apps/deployments": ["compute", "k8s Deployment"], "batch/cronjobs": ["compute", "k8s CronJob"], "core/services": ["network", "k8s Service"],
  "networking.k8s.io/networkpolicies": ["network", "네트워크 정책"], "core/serviceaccounts": ["identity", "서비스 계정(k8s)"],
  "external-secrets.io/externalsecrets": ["secret", "외부 비밀 연결"], "postgresql.cnpg.io/clusters": ["database", "CNPG PostgreSQL"],
  aws_db_instance: ["database", "RDS PostgreSQL"], aws_db_parameter_group: ["database", "RDS 파라미터 그룹"],
  aws_db_subnet_group: ["network", "RDS 서브넷 그룹"], aws_security_group: ["network", "보안 그룹"],
  aws_secretsmanager_secret: ["secret", "Secrets Manager 비밀"], aws_iam_role: ["identity", "IAM 앱 역할"],
  aws_iam_role_policy: ["identity", "IAM 역할 정책"], aws_eks_pod_identity_association: ["identity", "EKS Pod Identity 연결"],
  google_service_account: ["identity", "GCP 서비스 계정"], google_service_account_iam_member: ["identity", "Workload Identity 연결"],
  google_secret_manager_secret: ["secret", "Secret Manager 비밀"], google_secret_manager_secret_version: ["secret", "비밀 값 판"],
  google_secret_manager_secret_iam_member: ["identity", "비밀 읽기 권한"], google_sql_database_instance: ["database", "Cloud SQL PostgreSQL"],
  google_sql_database: ["database", "Cloud SQL 데이터베이스"], google_sql_user: ["database", "Cloud SQL 사용자"],
  random_password: ["secret", "DB 비밀번호(생성)"],
  azurerm_key_vault: ["secret", "Key Vault"], azurerm_user_assigned_identity: ["identity", "관리 ID"],
  azurerm_federated_identity_credential: ["identity", "페더레이션 자격"],
  azurerm_postgresql_flexible_server: ["database", "PostgreSQL Flexible Server"],
  azurerm_postgresql_flexible_server_database: ["database", "Flexible Server 데이터베이스"],
};

// 출발 쪽(가져온 원본)에 있던 것의 이름표. 가져오기(discover)는 아직 데모 원본이다 (adapters common/fixtures.ts)
const SOURCE_KIND: Record<Provider, { app: [string, string]; db: [string, string] }> = {
  aws: { app: ["ecs.service", "ECS 서비스"], db: ["rds.dbInstance", "RDS PostgreSQL"] },
  gcp: { app: ["k8s.deployment", "GKE Deployment"], db: ["cloudsql.instance", "Cloud SQL PostgreSQL"] },
  onprem: { app: ["k8s.deployment", "k3s Deployment"], db: ["cnpg.cluster", "CNPG PostgreSQL"] },
  azure_mock: { app: ["containerapp", "Container App(Mock)"], db: ["flexibleServer", "PostgreSQL Flexible Server(Mock)"] },
};

const BEFORE: Status[] = ["draft", "importing", "spec_review", "prechecking", "planning", "awaiting_approval", "approved", "rejected", "stale"];
const CHANGING: Status[] = ["provisioning", "deploying", "syncing", "shifting", "cutover", "rollback_window", "cleanup", "rolling_back"];

// paused 는 멈춘 칸으로, failed 는 실패한 칸으로 본다 (자원은 그 칸에 머물러 있다)
export const effectiveStatus = (m: Pick<MigrationRow, "status" | "pausedFrom" | "failedAtStatus">): Status =>
  m.status === "paused" ? (m.pausedFrom ?? "deploying") : m.status === "failed" ? (m.failedAtStatus ?? "provisioning") : m.status;

export function stageOf(m: Pick<MigrationRow, "status" | "pausedFrom" | "failedAtStatus">): Footprint["stage"] {
  if (m.status === "completed") return "after";
  if (m.status === "rolled_back" || m.status === "cancelled" || m.status === "failed") return "undone";
  if (m.status === "paused") return "changing";
  return BEFORE.includes(m.status) ? "before" : CHANGING.includes(m.status) ? "changing" : "before";
}

const ORDER: Status[] = ["provisioning", "deploying", "syncing", "shifting", "cutover", "rollback_window", "cleanup", "completed"];
const reached = (s: Status, at: Status) => ORDER.indexOf(s) >= ORDER.indexOf(at) && ORDER.indexOf(at) >= 0;

// 도착 쪽 트래픽 % (contracts traffic EXPECTED_TARGET_PCT 와 같은 규칙. shifting 은 감사의 마지막 도달 %)
export function targetPct(m: MigrationRow): number | null {
  const s = effectiveStatus(m);
  if (m.status === "rolled_back" || m.status === "rolling_back" || m.status === "cancelled") return 0;
  if (BEFORE.includes(s) || s === "provisioning" || s === "deploying" || s === "syncing") return 0;
  if (s === "shifting") return m.reachedPct;
  if (reached(s, "cutover")) return 100;
  return null;
}

function specSummary(raw: unknown): { spec: AppSpec; sum: z.infer<typeof SpecSummary> } | null {
  const p = AppSpec.safeParse(raw);
  if (!p.success) return null;
  const s = p.data;
  return { spec: s, sum: { app: s.app.name, image: s.service.image, replicas: s.service.replicas, cpu: s.service.cpu,
    memory: s.service.memory, port: s.service.port, hostname: s.ingress.hostname, secrets: s.service.secretRefs.length,
    database: s.database ? { engine: s.database.engine, majorVersion: s.database.majorVersion, storageGb: s.database.storageGb } : null } };
}

const dbLabel = (base: string, s: AppSpec) => `${base} ${s.database?.majorVersion ?? ""} · ${s.database?.storageGb ?? 0}GB`.replace("  ", " ");

// 도착 쪽: 어댑터가 만드는 자원 + Helm 으로 올라가는 앱 + 복제 받는 쪽
export function targetResources(m: MigrationRow, s: AppSpec): Res[] {
  const st = effectiveStatus(m);
  const failed = m.status === "failed", cancelled = m.status === "cancelled";
  const applied = m.applyEvidence !== null;
  // 인프라(Terraform) 자원 상태
  let infra: FState;
  if (m.status === "rolled_back") infra = "left";            // 롤백은 트래픽·복제만 되돌린다. 도착 자원은 남는다 (정리 확인 필요)
  else if (m.status === "rolling_back") infra = "running";
  else if (cancelled) infra = applied ? "left" : "none";
  else if (failed && st === "provisioning") infra = "unknown";  // 만들다 멈춤: 일부만 생겼을 수 있다 (tf:real destroy 로 정리)
  else if (BEFORE.includes(st)) infra = failed ? "none" : "planned";
  else if (st === "provisioning") infra = "creating";
  else infra = failed ? (applied ? "left" : "unknown") : "running";   // 실패로 멈춤: 만든 자원은 남는다 (다시 계획하거나 취소+정리)
  const evInfra: z.infer<typeof Evidence> = applied ? m.applyEvidence! : "adapter";

  const out: Res[] = [];
  for (const type of targetTypesOf(m, s)) {
    if (type.startsWith("data.")) continue;    // 읽기만 하는 data 원본은 자원이 아니다
    const [category, base] = KIND[type] ?? ["network", type];
    const label = category === "database" && /RDS PostgreSQL|Cloud SQL PostgreSQL|CNPG|Flexible Server$/.test(base) ? dbLabel(base, s) : base;
    out.push({ category, type, label, state: infra, evidence: evInfra });
  }
  // 앱 컨테이너 (Helm 차트 → Argo CD). deploying 에서 생긴다
  let app: FState;
  if (m.status === "rolled_back") app = "left";
  else if (m.status === "rolling_back") app = "standby";
  else if (cancelled) app = reached(st, "syncing") ? "left" : "none";
  else if (BEFORE.includes(st) || st === "provisioning") app = failed ? "none" : "planned";
  else if (st === "deploying") app = failed ? "unknown" : "creating";
  else app = failed ? "left" : "running";
  out.push({ category: "compute", type: "helm.release", label: `앱 컨테이너 ${s.service.replicas}개 (${s.service.cpu} CPU · ${s.service.memory})`,
             state: app, evidence: reached(st, "syncing") || m.status === "rolled_back" ? (applied ? m.applyEvidence! : "stub") : "adapter" });
  if (s.database) {
    // 논리 복제 받는 쪽(구독). syncing 에서 생기고 정리(cleanup)·롤백에서 걷는다
    const gone = m.status === "completed" || m.status === "rolled_back";
    const sub: FState = gone ? "removed" : st === "syncing" || st === "shifting" || st === "cutover" ? "running"
      : st === "rollback_window" ? "standby" : st === "cleanup" ? "stopping" : BEFORE.includes(st) || st === "provisioning" || st === "deploying" ? (failed || cancelled ? "none" : "planned") : "unknown";
    out.push({ category: "replication", type: "pg.subscription", label: st === "rollback_window" ? "복제 구독 (역방향 발행으로 바뀜)" : "복제 구독 (출발 → 도착)",
               state: sub, evidence: gone && m.cleanupRemoved ? "audit" : "adapter" });
  }
  return out;
}

// 출발 쪽: 가져온 앱 + DB + 복제 보내는 쪽(슬롯·발행)
export function sourceResources(m: MigrationRow, s: AppSpec): Res[] {
  const st = effectiveStatus(m);
  const k = SOURCE_KIND[m.sourceProvider];
  const done = m.status === "completed";
  const removedStub = (m.cleanupRemoved ?? []).some((x) => /source app scaled to 0/.test(x));
  const app: FState = done ? "stopped" : st === "rollback_window" ? "standby" : st === "cleanup" ? "stopping" : "running";
  const out: Res[] = [{ category: "compute", type: k.app[0], label: `${k.app[1]} · 컨테이너 ${s.service.replicas}개`, state: app,
                        evidence: done && removedStub ? "audit" : "discovered" }];
  if (s.database) {
    // 컷오버 뒤 출발 DB 는 쓰기 권한을 회수한 채 남는다 (지울지는 TODO(human), 워커 cleanup.ts)
    const db: FState = reached(st, "rollback_window") && m.status !== "rolled_back" ? "standby" : "running";
    out.push({ category: "database", type: k.db[0], label: dbLabel(k.db[1], s), state: db, evidence: "discovered" });
    const gone = done || m.status === "rolled_back";
    const slot: FState = gone ? "removed" : st === "syncing" || st === "shifting" || st === "cutover" ? "running"
      : st === "rollback_window" ? "standby" : st === "cleanup" ? "stopping" : m.status === "failed" || m.status === "cancelled" ? "none" : "planned";
    out.push({ category: "replication", type: "pg.replication_slot", label: "복제 슬롯·발행 (변경 보내기)", state: slot,
               evidence: gone && m.cleanupRemoved ? "audit" : "adapter" });
  }
  if (s.service.secretRefs.length)
    out.push({ category: "secret", type: "source.secrets", label: `비밀 ${s.service.secretRefs.length}개`, state: "running", evidence: "discovered" });
  return out;
}

export function footprintOf(envId: string, m: MigrationRow): Footprint {
  const role = m.targetEnvId === envId ? "target" : "source";
  const sp = specSummary(m.spec);
  const tPct = targetPct(m);
  return {
    migrationId: m.id, role,
    peer: role === "target" ? { envId: m.sourceEnvId, name: m.sourceName, provider: m.sourceProvider }
                            : { envId: m.targetEnvId, name: m.targetName, provider: m.targetProvider },
    migrationStatus: m.status, updatedAt: m.updatedAt, stage: stageOf(m),
    trafficPct: tPct === null ? null : role === "target" ? tPct : 100 - tPct,
    spec: sp?.sum ?? null,
    resources: sp ? (role === "target" ? targetResources(m, sp.spec) : sourceResources(m, sp.spec)) : [],
  };
}

const LIVE: FState[] = ["running", "standby"];
const MOVING: FState[] = ["creating", "stopping"];
const GONE: FState[] = ["removed", "stopped"];

export function buildEnvResources(env: { id: string; name: string; provider: Provider }, base: RunnerStatus,
  rows: MigrationRow[], cloud: z.infer<typeof CloudInventory>, now: () => Date = () => new Date()): EnvResources {
  // 같은 이전이 출발=도착(같은 환경)이면 도착으로 한 번만 센다
  const apps = rows.map((m) => footprintOf(env.id, m));
  const all = apps.flatMap((a) => a.resources);
  return {
    envId: env.id, name: env.name, provider: env.provider, generatedAt: now().toISOString(), cloud, base, apps,
    totals: {
      running: all.filter((r) => LIVE.includes(r.state)).length + base.resources.filter((r) => r.state === "Succeeded").length,
      changing: all.filter((r) => MOVING.includes(r.state)).length,
      planned: all.filter((r) => r.state === "planned").length,
      gone: all.filter((r) => GONE.includes(r.state)).length,
    },
  };
}

// ---- 경로 ----

const APP_LIMIT = 20;

export const PlanResourceRow = z.object({
  category: InventoryCategory, label: z.string(),
  source: z.object({ service: z.string(), detail: z.string().nullable() }).strict().nullable(),
  target: z.object({ service: z.string(), detail: z.string().nullable(), tfTypes: z.array(z.string()) }).strict().nullable(),
  method: z.enum(["redeploy", "logical_replication", "traffic_shift", "create_new", "image_copy", "reuse_existing", "out_of_scope"]),
  methodLabel: z.string(),
  step: z.enum(["provision", "deploy", "sync", "shift", "cutover", "cleanup"]).nullable(),
  stepState: z.enum(["todo", "doing", "done", "skipped", "undone"]),
  afterSource: z.string().nullable(),
}).strict();
const EnvRef = z.object({ envId: z.uuid(), name: z.string(), provider: Provider }).strict();
export const PlanResources = z.object({
  migrationId: z.uuid(), status: MigrationStatus, source: EnvRef, target: EnvRef, specKnown: z.boolean(),
  rows: z.array(PlanResourceRow),
}).strict();

// 계획서 단계 → 그 단계가 끝났나 (이전 상태 기준)
const STEP_DONE_AT: Record<string, Status> = { provision: "deploying", deploy: "syncing", sync: "shifting", shift: "cutover", cutover: "rollback_window", cleanup: "completed" };
const STEP_RUN_AT: Record<string, Status> = { provision: "provisioning", deploy: "deploying", sync: "syncing", shift: "shifting", cutover: "cutover", cleanup: "cleanup" };
export function stepStateOf(step: string | null, m: Pick<MigrationRow, "status" | "pausedFrom" | "failedAtStatus">): z.infer<typeof PlanResourceRow>["stepState"] {
  if (step === null) return "skipped";
  const st = effectiveStatus(m);
  if (reached(st, STEP_DONE_AT[step]!)) return m.status === "rolled_back" ? "undone" : "done";
  if (m.status === "rolled_back" || m.status === "cancelled" || m.status === "failed") return "undone";
  return st === STEP_RUN_AT[step] ? "doing" : "todo";
}

export function buildPlanResources(m: MigrationRow): z.infer<typeof PlanResources> {
  const sp = AppSpec.safeParse(m.spec);
  return {
    migrationId: m.id, status: m.status,
    source: { envId: m.sourceEnvId, name: m.sourceName, provider: m.sourceProvider },
    target: { envId: m.targetEnvId, name: m.targetName, provider: m.targetProvider },
    specKnown: sp.success,
    rows: serviceMap(m.sourceProvider, m.targetProvider, sp.success ? sp.data : null)
      .map((r) => ({ ...r, stepState: r.method === "out_of_scope" ? "skipped" as const : stepStateOf(r.step, m) })),
  };
}

// 이전 한 줄 + 받아들인 명세 + 감사 근거 3개. 이전 번호(하나) 또는 환경 번호(여러 개)로
const MIGRATION_SQL = (where: string, limit: string) =>
  `SELECT m.id, m.status, m.paused_from AS "pausedFrom", m.failed_at_status AS "failedAtStatus",
          ${isoUtc("m.updated_at")} AS "updatedAt",
          m.source_env_id AS "sourceEnvId", m.target_env_id AS "targetEnvId",
          se.name AS "sourceName", se.provider AS "sourceProvider", te.name AS "targetName", te.provider AS "targetProvider",
          (SELECT s.spec FROM spec_versions s WHERE s.migration_id = m.id AND NOT (s.field_meta ? $2)
            ORDER BY s.version DESC LIMIT 1) AS spec,
          -- TA11: to_jsonb(s) 로 읽어 spec_v2 칸(0023)이 아직 없는 DB 에서도 NULL. 계획서 irVersion 은 PlanDoc 칸(A3)이 없으면 NULL
          (SELECT to_jsonb(s)->'spec_v2'->'spec' FROM spec_versions s WHERE s.migration_id = m.id AND NOT (s.field_meta ? $2)
            ORDER BY s.version DESC LIMIT 1) AS "specV2",
          (SELECT p.plan_doc->>'irVersion' FROM plans p WHERE p.migration_id = m.id ORDER BY p.created_at DESC LIMIT 1) AS "planIrVersion",
          (SELECT CASE WHEN a.detail ? 'terraform' THEN 'terraform' WHEN a.detail ? 'runner' THEN 'runner' ELSE 'stub' END
             FROM audit_events a WHERE a.target = m.id::text AND a.detail->>'from' = 'provisioning' AND a.detail->>'to' = 'deploying'
            ORDER BY a.seq DESC LIMIT 1) AS "applyEvidence",
          (SELECT a.detail->'removed' FROM audit_events a WHERE a.target = m.id::text AND jsonb_typeof(a.detail->'removed') = 'array'
            ORDER BY a.seq DESC LIMIT 1) AS "cleanupRemoved",
          (SELECT (a.detail->>'reachedPct')::float8 FROM audit_events a WHERE a.target = m.id::text
              AND jsonb_typeof(a.detail->'reachedPct') = 'number' ORDER BY a.seq DESC LIMIT 1) AS "reachedPct"
     FROM migrations m
     JOIN environments se ON se.id = m.source_env_id
     JOIN environments te ON te.id = m.target_env_id
    WHERE ${where}
    ORDER BY m.updated_at DESC ${limit}`;

// reachedPct 는 0~1(비율)로 남는 경우가 있어 %로 맞춘다
const normPct = (rows: MigrationRow[]) => {
  for (const m of rows) if (m.reachedPct !== null && m.reachedPct <= 1) m.reachedPct = Math.round(m.reachedPct * 100);
  return rows;
};

export async function envInventoryRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/migrations/:id/plan/resources", { schema: { params: IdParam,
    response: { 200: PlanResources, ...errors(400, 401, 404, 500) } } }, async (req) => {
    const m = await withTenant(req.tenantId, async (tx) => {
      const q = await tx.query(MIGRATION_SQL("m.id = $1", "LIMIT 1"), [req.params.id, SPEC_DRAFT_KEY]);
      return found(q.rows[0] as MigrationRow | undefined, "migration", req.params.id);
    });
    return buildPlanResources(normPct([m])[0]!);
  });

  r.get("/environments/:id/inventory", { schema: { params: IdParam,
    response: { 200: EnvResources, ...errors(400, 401, 404, 409, 500) } } }, async (req) => {
    const { env, rows } = await withTenant(req.tenantId, async (tx) => {
      const e = await tx.query(`SELECT id, name, provider FROM environments WHERE id=$1`, [req.params.id]);
      const env = found(e.rows[0] as { id: string; name: string; provider: Provider } | undefined, "environment", req.params.id);
      // 감사 기록은 이전 번호(target)로 찾는다 (audit_events target 은 text). 하위 질의 셋 다 최신 1줄
      const q = await tx.query(MIGRATION_SQL("m.source_env_id = $1 OR m.target_env_id = $1", `LIMIT ${APP_LIMIT}`), [req.params.id, SPEC_DRAFT_KEY]);
      return { env, rows: q.rows as MigrationRow[] };
    });
    // 환경 자체 상태는 /status 와 같은 길 (막힘이면 409, STUB 이면 health unknown + 빈 목록)
    const target = { envId: env.id, provider: env.provider, region: "default" };
    const c = chooseRunner(env.provider);
    if (c.kind === "unavailable") throw c.error;
    const runner = c.kind === "runner" ? c.runner : null;
    const [base, cloud] = await Promise.all([
      runner ? runner.status(target) : Promise.resolve(stubStatus(target)),
      cachedInventory(env.id, env.provider, runner ? { azureStatus: () => runner.status(target) } : {}),
    ]);
    return buildEnvResources(env, base, normPct(rows), cloud);
  });
}
