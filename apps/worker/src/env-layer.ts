import type { PlanDoc, Provider } from "@svc/contracts";
import { tfBudget } from "@svc/contracts";
import { AWS_TARGET_FACT_KEYS, createEnvLayerRunner, ENV_LAYER_KEYS, ENV_LAYER_MODULE_DIGEST, envLayerVars, envLayerVarsHash, factsFromEnv, factsOfLayer, gcpTerraformEnv,
  regionOf, spawnExec, type EnvLayerFacts, type EnvLayerRunner, type EnvLayerRunnerOpts, type Exec, type GcpTerraformCred } from "@svc/adapters";
import { redactText } from "@svc/contracts";
import { withTenant, writeAudit, type Tx } from "@svc/core";
import { GcpIssueError } from "@svc/security";
import { tenantSlug } from "./gitops/bundle.js";
import { withGcpCred } from "./gcp-token-server.js";
import { withStepRoles } from "./jobs/_roles.js";
import type { MigrationRow } from "./jobs/_step.js";

// 환경 층 (도착 GCP 프로젝트의 VPC·GKE·AR·ESO) 확보. 아키텍처 이전 9단계 "4 기반 생성".
// 부르는 곳: apply 작업 맨 앞 (승인 뒤 provisioning). apply-real prepare() 안에서는 만들지 않는다 —
//   prepare 는 컷오버·롤백의 다시 apply(reapplyDbWriter)에서도 불려 그때 GKE 를 만들 수 있기 때문.
// 환경 단위 함수다: 나중에 "환경 연결 직후 작업"으로 옮길 때 부르는 위치만 바꾼다 (이전 번호는 감사 대상으로만 쓴다).
//
// 사실 고르는 순서 (chooseEnvLayerSource):
//   1) DB environment_layers 줄이 ready → 그 값
//   2) 없으면 워커 TF_FACT_* (예전 데모 방식). TF_FACT_CLUSTER_NAME="" (클러스터 없이, aws) 뜻은 그대로
//   3) 둘 다 없고 GCP 이고 ENV_LAYER_AUTO=1 → 만든다
//      - 도착 프로젝트에 클러스터가 이미 있는데 DB 줄이 없으면 만들지 않고 NEEDS_HUMAN (고객 GKE 를 덮어쓰지 않게)
//   4) 둘 다 없고 AWS → 연결 때 적은 도착 EKS 를 실자원 읽기(inventory-refresh, 관찰 역할)가 읽어 둔 사실 (VPC·서브넷).
//      못 쓰면 만들지 않고 TARGET_FACTS_UNAVAILABLE (이유 한 줄)
//   5) 그 밖 → 아무것도 안 함 (realApply 가 예전처럼 TF_FACTS_MISSING)
// DRAFT(ai): ENV_LAYER_AUTO 기본 꺼짐. 꺼져 있으면 DB 줄이 없는 한 예전과 완전히 같다 (DB 줄은 켜져 있을 때만 생긴다)

export type EnvLayerStatus = "creating" | "ready" | "failed";
export interface EnvLayerRow { status: EnvLayerStatus; facts: EnvLayerFacts | null; varsHash: string; moduleDigest: string; updatedAt?: string }
export type EnvLayerSource = "db" | "env" | "create" | "inventory" | "none";

export const envLayerAuto = (env: NodeJS.ProcessEnv = process.env) => env.ENV_LAYER_AUTO === "1";

/** 워커 env 에 그 클라우드의 도착 사실(TF_FACT_NETWORK_ID·TF_FACT_VPC_ID 등)이 있는가. TF_FACT_CLUSTER_NAME="" 도 "있음" (클러스터 없이 만들기) */
export function hasEnvFacts(env: NodeJS.ProcessEnv, provider: Provider): boolean {
  const f = factsFromEnv(env);
  const keys: readonly string[] = provider === "aws" ? AWS_TARGET_FACT_KEYS : ENV_LAYER_KEYS;
  return keys.some((k) => f[k] !== undefined);
}

/** 순수 함수: 위 순서 1)~5) */
export function chooseEnvLayerSource(provider: Provider, row: EnvLayerRow | null, env: NodeJS.ProcessEnv): EnvLayerSource {
  if (row?.status === "ready" && row.facts) return "db";
  if (hasEnvFacts(env, provider)) return "env";
  if (provider === "gcp" && envLayerAuto(env)) return "create";
  if (provider === "aws") return "inventory";
  return "none";
}

/** AWS 도착 사실 (실자원 읽기가 저장한 targetFacts). 못 쓰면 사람이 읽을 이유 */
export type InventoryFacts = { ok: true; facts: Record<string, string> } | { ok: false; reason: string };

/** 순수 함수: 저장된 targetFacts(adapters AwsTargetFactsRead) → 사실. 지금 환경의 클러스터·도착 지역과 같은 읽기일 때만 */
export function inventoryFactsOf(stored: unknown, cluster: string | null, region: string): InventoryFacts {
  const t = stored as { ok?: unknown; cluster?: unknown; region?: unknown; facts?: unknown; reason?: unknown } | null | undefined;
  if (!t || typeof t !== "object" || typeof t.ok !== "boolean")
    return { ok: false, reason: "도착 EKS 를 아직 읽지 않았다. 도착 환경 화면을 열면 실자원을 읽는다" };
  if (!t.ok) return { ok: false, reason: `도착 EKS 를 읽었지만 쓸 수 없다: ${String(t.reason ?? "이유 없음")}` };
  if (t.cluster !== cluster)
    return { ok: false, reason: `읽어 둔 클러스터(${String(t.cluster)})가 환경의 클러스터(${cluster ?? "없음"})와 다르다. 도착 환경 화면을 다시 열어 실자원을 다시 읽는다` };
  if (t.region !== region) return { ok: false, reason: `도착 EKS 지역 ${String(t.region)} 은 아직 못 쓴다 (도착 자원은 ${region} 에 만든다)` };
  const facts = t.facts as Record<string, unknown> | null;
  if (!facts || typeof facts !== "object" || !Object.values(facts).every((v) => typeof v === "string"))
    return { ok: false, reason: "읽어 둔 도착 사실 모양이 틀리다. 도착 환경 화면을 다시 열어 실자원을 다시 읽는다" };
  return { ok: true, facts: facts as Record<string, string> };
}

// ---- DB ----
/** 환경 층 줄 읽기. 0052 가 아직 안 들어간 DB 면 null (표가 없어도 예전 동작 그대로, 트랜잭션도 안 깨짐) */
export async function readEnvLayer(tx: Pick<Tx, "query">, envId: string): Promise<EnvLayerRow | null> {
  const t = await tx.query(`SELECT to_regclass('public.environment_layers') IS NOT NULL AS ok`, []);
  if (!t.rows[0]?.ok) return null;
  const r = await tx.query(`SELECT status, facts, vars_hash, module_digest, updated_at FROM environment_layers WHERE env_id = $1`, [envId]);
  const x = r.rows[0] as { status: EnvLayerStatus; facts: EnvLayerFacts | null; vars_hash: string; module_digest: string; updated_at: Date } | undefined;
  if (!x) return null;
  const facts = x.facts && typeof x.facts === "object" && "cluster_name" in x.facts ? x.facts : null;
  return { status: x.status, facts, varsHash: x.vars_hash, moduleDigest: x.module_digest, updatedAt: new Date(x.updated_at).toISOString() };
}

/** AWS 도착 사실 읽기 (environment_inventory.result.targetFacts + 환경의 cluster_name). 도착 지역 = 계획과 같은 regionOf("default") */
export async function readInventoryFacts(tx: Pick<Tx, "query">, envId: string): Promise<InventoryFacts> {
  const t = await tx.query(`SELECT to_regclass('public.environment_inventory') IS NOT NULL AS ok`, []);
  if (!t.rows[0]?.ok) return { ok: false, reason: "실자원 표(environment_inventory)가 없는 DB 다" };
  const r = await tx.query(
    `SELECT e.cluster_name, i.result->'targetFacts' AS facts FROM environments e LEFT JOIN environment_inventory i ON i.environment_id = e.id WHERE e.id = $1`, [envId]);
  const x = r.rows[0] as { cluster_name: string | null; facts: unknown } | undefined;
  return inventoryFactsOf(x?.facts, x?.cluster_name ?? null, regionOf({ envId, provider: "aws", region: "default" }));
}

export interface EnvLayerStore {
  get(tenantId: string, envId: string): Promise<EnvLayerRow | null>;
  /** creating 선점. 없음·failed·오래된 creating 이면 true. 다른 이전이 만드는 중이면 false */
  claim(tenantId: string, envId: string, varsHash: string, moduleDigest: string): Promise<boolean>;
  ready(tenantId: string, envId: string, facts: EnvLayerFacts, varsHash: string, moduleDigest: string): Promise<void>;
  failed(tenantId: string, envId: string): Promise<void>;
  audit(tenantId: string, migrationId: string, action: string, result: "ok" | "error", detail: Record<string, unknown>): Promise<void>;
}

// DRAFT(ai): creating 이 이 시간보다 오래되면 워커가 죽은 것으로 보고 다시 선점한다 (= apply 큐 기한. 그 전에 작업이 끝나거나 만료된다)
const staleCreatingSec = () => tfBudget().applyExpireSec;

export const dbEnvLayerStore: EnvLayerStore = {
  get: (tenantId, envId) => withTenant(tenantId, (tx) => readEnvLayer(tx, envId)),
  claim: (tenantId, envId, varsHash, moduleDigest) => withTenant(tenantId, async (tx) => {
    const r = await tx.query(
      `INSERT INTO environment_layers (env_id, tenant_id, provider, status, vars_hash, module_digest)
       VALUES ($1, $2, 'gcp', 'creating', $3, $4)
       ON CONFLICT (env_id) DO UPDATE SET status = 'creating', vars_hash = EXCLUDED.vars_hash, module_digest = EXCLUDED.module_digest, updated_at = now()
       WHERE environment_layers.status = 'failed'
          OR (environment_layers.status = 'creating' AND environment_layers.updated_at < now() - make_interval(secs => $5))
       RETURNING env_id`, [envId, tenantId, varsHash, moduleDigest, staleCreatingSec()]);
    return r.rows.length === 1;
  }),
  ready: (tenantId, envId, facts, varsHash, moduleDigest) => withTenant(tenantId, async (tx) => {
    await tx.query(`UPDATE environment_layers SET status = 'ready', facts = $2, vars_hash = $3, module_digest = $4, updated_at = now() WHERE env_id = $1`,
      [envId, JSON.stringify(facts), varsHash, moduleDigest]);
    // gke-freeze·연결 확인이 읽는 칸. 사람이 이미 넣은 값은 덮지 않는다
    // DRAFT(ai): 비어 있을 때만 채움. 다른 이름이 들어 있으면 그대로 두고 env 층 사실(gke-freeze 는 env 층을 먼저 읽음)이 이긴다
    await tx.query(`UPDATE environments SET cluster_name = $2 WHERE id = $1 AND (cluster_name IS NULL OR cluster_name = '')`, [envId, facts.cluster_name]);
  }),
  failed: (tenantId, envId) => withTenant(tenantId, async (tx) => {
    await tx.query(`UPDATE environment_layers SET status = 'failed', updated_at = now() WHERE env_id = $1`, [envId]);
  }),
  audit: (tenantId, migrationId, action, result, detail) => withTenant(tenantId, (tx) =>
    writeAudit(tx, tenantId, { actor: "worker", action, target: migrationId, result, detail })),
};

// ---- 도착 프로젝트에 이미 클러스터가 있나 (빌린 토큰으로 gcloud 읽기) ----
// API 가 아직 꺼진 새 프로젝트(SERVICE_DISABLED)는 "클러스터 없음". 그 밖의 읽기 실패는 모른다 → 만들지 않는다
const API_OFF_RE = /SERVICE_DISABLED|has not been used in project|is disabled/i;
export async function listGkeClusters(projectId: string, env: NodeJS.ProcessEnv, exec: Exec = spawnExec):
    Promise<{ ok: true; names: string[] } | { ok: false; error: string }> {
  const bin = env.GCLOUD_BIN ?? "gcloud";
  const r = await exec(bin, ["container", "clusters", "list", `--project=${projectId}`, "--format=json"], { cwd: process.cwd(), env, timeoutMs: 60_000 });
  if (r.code !== 0) {
    if (API_OFF_RE.test(r.stderr)) return { ok: true, names: [] };
    return { ok: false, error: redactText(r.stderr.trim().split("\n").slice(-1)[0] ?? `exit ${r.code}`).slice(0, 200) };
  }
  try {
    const j: unknown = JSON.parse(r.stdout || "[]");
    return { ok: true, names: Array.isArray(j) ? j.map((c) => String((c as { name?: unknown }).name ?? "")).filter(Boolean) : [] };
  } catch { return { ok: false, error: "gcloud 응답 JSON 해석 실패" }; }
}

// ---- 계획 ----
/** 계획서 envLayer 칸 + 계획 때 쓸 DB 사실. TF_FACT_* 길·흉내 길은 칸 없음 (예전 지문).
 *  AWS 실자원 사실은 칸 없이 사실만 (계획서 targetFacts 에 실려 사람이 본다). 못 쓰면 계획은 그대로 두고 apply 가 이유를 들고 멈춘다 */
export function planEnvLayer(provider: Provider, row: EnvLayerRow | null, env: NodeJS.ProcessEnv, projectId: string | null, region: string,
    inventory?: InventoryFacts | null): { envLayer?: NonNullable<PlanDoc["envLayer"]>; dbFacts?: Record<string, string> } {
  const src = chooseEnvLayerSource(provider, row, env);
  if (src === "db") return { envLayer: { mode: "existing", moduleDigest: row!.moduleDigest }, dbFacts: factsOfLayer(row!.facts!) };
  if (src === "inventory") return inventory?.ok ? { dbFacts: inventory.facts } : {};
  if (src === "create" && projectId) {
    const vars = envLayerVars({ projectId, region });
    return { envLayer: { mode: "create", moduleDigest: ENV_LAYER_MODULE_DIGEST, varsHash: envLayerVarsHash(vars),
      notice: `도착 프로젝트 ${projectId} 에 GKE 클러스터(${vars.zone}, e2-standard-2 노드 2대)·VPC·Cloud NAT(고정 IP 1개)·Artifact Registry·ESO 를 새로 만듭니다. 약 10~15분, 비용 발생. 이전이 끝나거나 롤백해도 자동으로 지우지 않습니다 (환경 소유)` } };
  }
  return {};
}

// ---- apply 맨 앞 ----
export interface EnsureEnvLayerInput {
  tenantId: string; migrationId: string; envId: string; provider: Provider;
  projectId: string | null;   // 도착 프로젝트 (TARGET_ACCOUNT_SQL = gcp_target_project, 비면 account_id)
  region: string;             // 앱 층과 같은 지역 (regionOf)
  plan: Pick<PlanDoc, "envLayer">;
}
/** B-2: 만드는 동안만 고객 svc-env 를 빌려 fn 을 부른다. 못 빌리면 cred 없이 사유(why). signal = svc-env 재발급 실패 */
export type WithEnvCred = <T>(fn: (b: { cred?: GcpTerraformCred; why?: string; signal?: AbortSignal }) => Promise<T>) => Promise<T>;
const noEnvCred: WithEnvCred = (fn) => fn({});

export interface EnsureEnvLayerDeps {
  env?: NodeJS.ProcessEnv;
  store?: EnvLayerStore;
  /** B-2: 고객 svc-env 빌리기 (borrowEnvCred). 없거나 못 빌리면 만들지 않는다 (워커 자기 자격·svc-operate 로 고객 프로젝트에 GKE 를 만들지 않음) */
  withEnvCred?: WithEnvCred;
  runner?: (o: EnvLayerRunnerOpts) => EnvLayerRunner;
  exec?: Exec;   // gcloud 클러스터 목록 (시험이 가짜로)
  signal?: AbortSignal;
  /** AWS 실자원 사실 읽기 (시험이 가짜로). 기본 = DB readInventoryFacts */
  inventory?: (tenantId: string, envId: string) => Promise<InventoryFacts>;
}
/** layer.varsHash 는 만든 환경 층(DB 줄)에만 있다. AWS 실자원 사실은 사실만 */
export type EnsureEnvLayerOutcome =
  | { ok: true; source: Exclude<EnvLayerSource, "create">; created?: boolean; layer?: { facts: Record<string, string>; varsHash?: string }; detail: Record<string, unknown> }
  | { ok: false; failureCode: string; detail: Record<string, unknown> };

const dbInventoryFacts = (tenantId: string, envId: string) => withTenant(tenantId, (tx) => readInventoryFacts(tx, envId));

export async function ensureEnvLayer(i: EnsureEnvLayerInput, d: EnsureEnvLayerDeps = {}): Promise<EnsureEnvLayerOutcome> {
  const env = d.env ?? process.env;
  const store = d.store ?? dbEnvLayerStore;
  // 0052 전이거나 AUTO 꺼짐 + DB 줄 없음이면 아무 일도 없다. 표는 GCP 만 쓰므로 그 밖은 읽지도 않는다
  const row = i.provider === "gcp" ? await store.get(i.tenantId, i.envId) : null;
  const src = chooseEnvLayerSource(i.provider, row, env);
  const base = { envId: i.envId, provider: i.provider };
  const fail = async (failureCode: string, detail: Record<string, unknown>, action = "env_layer.failed"): Promise<EnsureEnvLayerOutcome> => {
    await store.audit(i.tenantId, i.migrationId, action, "error", { ...base, failureCode, ...detail });
    return { ok: false, failureCode, detail: { ...base, envLayer: { failureCode, ...detail } } };
  };
  if (src === "db") return { ok: true, source: "db", layer: { facts: factsOfLayer(row!.facts!), varsHash: row!.varsHash }, detail: { ...base, source: "db" } };
  if (src === "inventory") {
    const f = await (d.inventory ?? dbInventoryFacts)(i.tenantId, i.envId);
    if (!f.ok) return fail("TARGET_FACTS_UNAVAILABLE", { error: f.reason }, "env_layer.facts_unavailable");
    return { ok: true, source: "inventory", layer: { facts: f.facts }, detail: { ...base, source: "inventory", keys: Object.keys(f.facts).sort() } };
  }
  if (src !== "create") return { ok: true, source: src, detail: { ...base, source: src } };

  // ---- 만들기 ----
  const projectId = i.projectId;
  if (!projectId) return fail("TF_FACTS_MISSING", { error: "도착 프로젝트(gcp_target_project·account_id)가 없다" });
  const vars = envLayerVars({ projectId, region: i.region });
  const varsHash = envLayerVarsHash(vars);
  // 승인 대조: 사람이 본 계획이 "GKE 새로 만들기"였고, 그때와 같은 입력·모듈인가. 아니면 만들지 않는다 (비용 드는 자원을 승인 없이 만들지 않음)
  const p = i.plan.envLayer;
  if (p?.mode !== "create")
    return fail("TF_PLAN_DRIFT", { error: "승인한 계획서에 환경 층 생성이 없다 (승인 뒤 ENV_LAYER_AUTO 를 켬, 또는 환경 층 줄이 사라짐). 다시 계획한다" });
  if (p.varsHash !== varsHash || p.moduleDigest !== ENV_LAYER_MODULE_DIGEST)
    return fail("TF_PLAN_DRIFT", { error: p.varsHash !== varsHash ? "환경 층 입력(프로젝트·지역·이름·노드 SA)이 승인 때와 다르다" : "gcp/env 모듈이 승인 뒤 바뀌었다" });

  // B-2: 여기서부터 끝까지만 고객 svc-env 를 빌린다 (앱 층 apply 는 svc-operate 그대로)
  return (d.withEnvCred ?? noEnvCred)(async ({ cred, why, signal: envSignal }) => {
    if (!cred) return fail("ENV_LAYER_CRED_MISSING", { error: `고객 svc-env 를 빌리지 못했다${why ? ` (${why})` : ""}. 환경 층은 svc-env 로만 만든다 (워커 자기 자격·svc-operate 로는 안 만든다). `
      + "고객이 infra/onboarding/gcp-connect.sh 를 다시 실행해 svc-env·svc-gke-node 를 만든 뒤 다시 계획한다" });
    const runEnv = () => gcpTerraformEnv(cred, env);   // 부를 때마다 그 순간의 토큰
    const signal = envSignal && d.signal ? AbortSignal.any([d.signal, envSignal]) : envSignal ?? d.signal;

    // 고객 GKE 를 덮어쓰지 않게: 우리 줄이 없는데(처음) 도착 프로젝트에 클러스터가 있으면 멈춘다.
    //   failed 줄이 있으면 우리 작업 폴더 state 로 이어 만드는 중이라 이미 생긴 클러스터는 우리 것 → 이 검사를 건너뛴다
    if (!row) {
      const l = await listGkeClusters(projectId, runEnv(), d.exec);
      if (!l.ok) return fail("NEEDS_HUMAN", { error: `도착 프로젝트 클러스터 목록을 못 읽어 만들지 않음: ${l.error}` }, "env_layer.needs_human");
      if (l.names.length)
        return fail("NEEDS_HUMAN", { clusters: l.names.slice(0, 10), error: "도착 프로젝트에 이미 GKE 가 있는데 환경 층 기록이 없다. 그 클러스터를 쓸지(TF_FACT_* 또는 environment_layers 줄) 사람이 정한다" }, "env_layer.needs_human");
    }
    if (!(await store.claim(i.tenantId, i.envId, varsHash, ENV_LAYER_MODULE_DIGEST)))
      return fail("ENV_LAYER_BUSY", { error: "같은 환경의 환경 층을 다른 이전이 만드는 중이다" });
    await store.audit(i.tenantId, i.migrationId, "env_layer.creating", "ok", { ...base, projectId, region: i.region, zone: vars.zone, varsHash, moduleDigest: ENV_LAYER_MODULE_DIGEST, resumed: !!row });

    let r;
    try {
      r = await (d.runner ?? createEnvLayerRunner)({ env: runEnv }).apply(tenantSlug(i.tenantId), i.envId, vars, signal);
    } catch (e) {
      await store.failed(i.tenantId, i.envId);
      return fail("ENV_LAYER_APPLY_FAILED", { error: redactText((e as Error)?.message ?? String(e)).slice(0, 300), autoDestroy: false });
    }
    const run = { workDir: r.workDir, steps: r.steps, elapsedMs: r.elapsedMs, log: r.log.slice(-20) };
    if (!r.ok || !r.facts) {
      await store.failed(i.tenantId, i.envId);
      // 만들다 만 자원은 지우지 않는다 (환경 소유). 다시 계획·apply 하면 같은 작업 폴더 state 로 이어 만든다
      return fail("ENV_LAYER_APPLY_FAILED", { ...run, failedPhase: r.failedPhase, failedStep: r.failedStep, autoDestroy: false,
        cleanup: `사람이 확인 뒤: cd ${r.workDir}/modules/gcp/env && terraform destroy -var-file=../../../terraform.tfvars.json` });
    }
    await store.ready(i.tenantId, i.envId, r.facts, varsHash, ENV_LAYER_MODULE_DIGEST);
    await store.audit(i.tenantId, i.migrationId, "env_layer.ready", "ok", { ...base, ...run, clusterName: r.facts.cluster_name, clusterLocation: r.facts.cluster_location });
    return { ok: true, source: "db", created: true, layer: { facts: factsOfLayer(r.facts), varsHash },
             detail: { ...base, source: "db", created: true, workDir: r.workDir, elapsedMs: r.elapsedMs } };
  });
}

/** B-2: apply 작업이 쓰는 svc-env 빌리기. 환경 층 단계(STEP_ROLES.env_layer)에서만 빌리고 끝나면 회수한다 (svc-plan 과 같은 길, 발급기가 svc-operate → svc-env).
 *  svc-env 가 없거나(예전 연결 스크립트) 거부되면 cred 없이 사유만 넘긴다 → ENV_LAYER_CRED_MISSING. svc-operate 로 넘어가지 않는다 */
export function borrowEnvCred(j: { tenantId: string; migrationId: string }, m: MigrationRow, projectId: string | null): WithEnvCred {
  return async (fn) => {
    let borrowed = false;
    try {
      return await withStepRoles("env_layer", j, m, (roles) => {
        borrowed = true;
        const why = roles.denied.map((x) => x.code).join(",");
        return withGcpCred(roles, projectId, (cred) => fn({ ...(cred ? { cred } : {}), ...(why ? { why } : {}), ...(roles.signal ? { signal: roles.signal } : {}) }));
      });
    } catch (e) {
      if (!borrowed && e instanceof GcpIssueError) return fn({ why: e.reason });
      throw e;
    }
  };
}
