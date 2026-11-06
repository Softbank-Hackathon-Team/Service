import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TfOutputs } from "@svc/contracts";
import { envNumber, tfBudget } from "@svc/contracts";
import { MODULE_DIGEST } from "../module-digests.js";
import { childEnv, DEFAULT_MODULE_ROOT, parseOutputs, spawnExec, TENANT_DIR_RE, workRootOf, type Exec, type RealStep } from "./real-runner.js";
import { envStateKey, stateBackend } from "./state-backend.js";

// 아키텍처 이전 9단계의 "4 기반 생성(VPC·클러스터·DB)" 중 환경 층 (도착 GCP 프로젝트에 VPC·GKE·Artifact Registry + ESO).
// 앱 층(gcp/root, 이전마다)과 달리 환경 하나에 한 번 만들고, 이전이 끝나도 지우지 않는다 (환경 소유).
//   작업 폴더: TF_WORK_DIR/<회사 slug>/env-<환경 id>/ (#265 의 디스크 위, 이전 폴더와 같은 회사 폴더 아래)
//     modules/gcp/env/*.tf  ← infra/modules/gcp/env (모듈이 ${path.module}/../../../charts 를 보므로 같은 깊이를 지킨다)
//     charts/cluster-secret-store/** ← infra/charts/cluster-secret-store
//     terraform.tfvars.json, terraform.tfstate, outputs.json
//   1차 apply: create_eso=false → 클러스터만. 2차 apply: create_eso=true → ESO·ClusterSecretStore.
//     모듈 주석(variable create_eso)대로 둘로 나눈다: 클러스터를 만드는 apply 에 helm 접속이 섞이면 provider 설정이 빈 주소로 읽혀 깨질 수 있다
//   실행 env 는 단계마다 새로 받는다 (빌린 토큰이 재발급되면 다음 단계가 새 토큰으로 시작)

/** gcp/root 의 자리표시 중 환경 층이 만드는 값 (계획 때는 아직 없음 → create 계획은 이 키를 비교에서 뺀다) */
export const ENV_LAYER_KEYS = ["networkId", "clusterName", "clusterLocation"] as const;
export const ENV_LAYER_MODULE = "gcp/env";
/** 계획서 envLayer.moduleDigest (모듈을 고치면 gen:digests → 승인 뒤 바뀌면 create 계획이 drift) */
export const ENV_LAYER_MODULE_DIGEST: string = MODULE_DIGEST[ENV_LAYER_MODULE];

/** 환경 층 사실 (비밀 아닌 값만. DB environment_layers.facts 와 같은 이름) */
export interface EnvLayerFacts {
  network_id: string;
  cluster_name: string;
  cluster_location: string;
  nat_egress_ips: string[];
  registry_host?: string;
  secret_store_name?: string;
}

/** DB 사실 → 자리표시 키(camelCase). factsFromEnv 결과와 같은 이름이라 mergeFacts 로 합친다 */
export function factsOfLayer(f: EnvLayerFacts): Record<string, string> {
  return {
    networkId: f.network_id, clusterName: f.cluster_name, clusterLocation: f.cluster_location,
    natEgressIpsJson: JSON.stringify(f.nat_egress_ips ?? []),
    ...(f.registry_host ? { registryHost: f.registry_host } : {}),
  };
}

/** 사실 고르는 순서 1) DB env 층(ready) 2) TF_FACT_* (factsFromEnv). DB 값이 이긴다. 둘 다 없으면 envFacts 그대로 */
export function mergeFacts(dbFacts: Record<string, string> | undefined | null, envFacts: Record<string, string>): Record<string, string> {
  return dbFacts ? { ...envFacts, ...dbFacts } : envFacts;
}

/** terraform output → 사실. 클러스터 이름이 비면(GKE 안 만든 모양) null */
export function envLayerFactsOf(out: TfOutputs): EnvLayerFacts | null {
  if (!out.cluster_name || !out.network_id || !out.cluster_location) return null;
  let ips: string[] = [];
  try { const j: unknown = JSON.parse(out.nat_egress_ips ?? "[]"); if (Array.isArray(j)) ips = j.filter((x): x is string => typeof x === "string"); } catch { /* 빈 목록 */ }
  return { network_id: out.network_id, cluster_name: out.cluster_name, cluster_location: out.cluster_location, nat_egress_ips: ips,
    ...(out.registry_host ? { registry_host: out.registry_host } : {}),
    ...(out.secret_store_name ? { secret_store_name: out.secret_store_name } : {}) };
}

export interface EnvLayerVars { project_id: string; region: string; zone: string; name: string; create_gke: true }
// DRAFT(ai): 이름은 모듈 기본값(platform-target)과 같게, zone 은 "<region>-a". 도착 프로젝트 하나 = 환경 층 하나라 이름이 겹칠 일이 없다
export const ENV_LAYER_NAME = "platform-target";
export function envLayerVars(i: { projectId: string; region: string }): EnvLayerVars {
  return { project_id: i.projectId, region: i.region, zone: `${i.region}-a`, name: ENV_LAYER_NAME, create_gke: true };
}
/** 계획서·DB 에 남기는 입력 지문. create_eso(1차·2차에서만 다름)는 빼고 본다 */
export function envLayerVarsHash(v: EnvLayerVars): string {
  const keys = Object.keys(v).sort() as (keyof EnvLayerVars)[];
  return createHash("sha256").update(JSON.stringify(keys.map((k) => [k, v[k]]))).digest("hex");
}

/** state 를 어디에 둘지 한 곳. 앱 층과 같은 state-backend.ts 를 쓴다.
 *  TF_STATE_BACKEND 없음 → 작업 폴더 로컬 파일 (file = 그 경로). s3 → 고객 state 전용 버킷 tenants/<회사>/envs/<환경 id>/terraform.tfstate
 *  (워커 자기 자격으로 tf-state 역할을 빌림. 환경 층은 이전보다 오래 살아서 worker 디스크(#265 EBS)를 잃어도 state 가 남아야 한다)
 *  file 은 local 일 때만 있다 (s3 는 로컬 state 파일이 없다) */
export function envLayerBackend(dir: string, tenant: string, envId: string, env: NodeJS.ProcessEnv = process.env):
  { kind: "local"; file: string; hcl: string } | { kind: "s3"; key: string; hcl: string } {
  const b = stateBackend(env, { key: envStateKey(tenant, envId), localPath: "../../../terraform.tfstate", dir });
  return b.kind === "local" ? { ...b, file: join(dir, "terraform.tfstate") } : b;
}

export const envLayerDirOf = (root: string, tenant: string, envId: string) => {
  if (!TENANT_DIR_RE.test(tenant)) throw new Error(`bad tenant for env layer dir: ${tenant}`);
  if (!/^[0-9a-f-]{8,}$/i.test(envId)) throw new Error(`bad env id for env layer dir: ${envId}`);
  return join(root, tenant, `env-${envId}`);
};

/** DRAFT(ai): env 층 두 번의 apply 가 나눠 쓰는 예산. GKE 영역 클러스터 생성 실측 5~10분 + 노드 풀 3~5분 + ESO 2~3분 + init → 30분 */
//   값과 큐 기한(applyExpireSec 에 더함)은 contracts tfBudget 한 곳
export const envLayerBudgetSec = (env: NodeJS.ProcessEnv = process.env) => tfBudget(env).envLayerSec;

export interface EnvLayerRunnerOpts {
  exec?: Exec;
  /** 단계(1차·2차)마다 부른다 → 그 순간의 빌린 토큰으로 자식 환경을 만든다 */
  env: () => NodeJS.ProcessEnv;
  moduleRoot?: string;
  workRoot?: string;
  terraformBin?: string;
}
export type EnvLayerPhase = "cluster" | "eso";
export interface EnvLayerResult {
  ok: boolean; workDir: string; steps: (RealStep & { phase: EnvLayerPhase })[]; log: string[]; elapsedMs: number;
  facts?: EnvLayerFacts; failedPhase?: EnvLayerPhase; failedStep?: RealStep["step"];
}

const tail = (s: string, n = 15) => s.split("\n").map((x) => x.trimEnd()).filter(Boolean).slice(-n);

export function createEnvLayerRunner(o: EnvLayerRunnerOpts) {
  const base = o.env();
  const exec = o.exec ?? spawnExec;
  const moduleRoot = o.moduleRoot ?? (base.TF_MODULE_ROOT || DEFAULT_MODULE_ROOT);
  const workRoot = o.workRoot ?? workRootOf(base);
  const tf = o.terraformBin ?? base.TF_BIN ?? "terraform";
  const stepMs = tfBudget(base).stepSec * 1000;
  const lockTimeout = `-lock-timeout=${envNumber(base.TF_LOCK_TIMEOUT_SEC, 60)}s`;

  function prepare(tenant: string, envId: string): string {
    const dir = envLayerDirOf(workRoot, tenant, envId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* 권한 못 바꾸는 파일 시스템 */ }
    const mod = join(dir, "modules", ENV_LAYER_MODULE);
    mkdirSync(mod, { recursive: true });
    const src = join(moduleRoot, ENV_LAYER_MODULE);
    if (!existsSync(join(src, "main.tf"))) throw new Error(`no env layer module: ${ENV_LAYER_MODULE}`);
    for (const f of readdirSync(src)) if (f.endsWith(".tf")) cpSync(join(src, f), join(mod, f));
    const chart = join(moduleRoot, "..", "charts", "cluster-secret-store");
    if (!existsSync(chart)) throw new Error("no chart infra/charts/cluster-secret-store (worker image must copy infra/charts)");
    cpSync(chart, join(dir, "charts", "cluster-secret-store"), { recursive: true });
    writeFileSync(join(mod, "zz_backend.tf"), envLayerBackend(dir, tenant, envId, base).hcl);
    writeFileSync(join(dir, "provider.txt"), "gcp");
    writeFileSync(join(dir, "tenant.txt"), tenant);
    return dir;
  }

  return {
    workRoot,
    async apply(tenant: string, envId: string, vars: EnvLayerVars, signal?: AbortSignal): Promise<EnvLayerResult> {
      const t0 = performance.now();
      const deadline = Date.now() + envLayerBudgetSec(base) * 1000;
      const steps: EnvLayerResult["steps"] = []; const log: string[] = [];
      const dir = prepare(tenant, envId);
      const G = [`-chdir=modules/${ENV_LAYER_MODULE}`];
      const vf = "-var-file=../../../terraform.tfvars.json";
      const done = (r: Partial<EnvLayerResult>): EnvLayerResult => ({ ok: false, workDir: dir, steps, log, elapsedMs: Math.round(performance.now() - t0), ...r });
      const run = async (phase: EnvLayerPhase, step: RealStep["step"], args: string[], cenv: NodeJS.ProcessEnv, quiet = false) => {
        const left = deadline - Date.now();
        if (left <= 0) {
          steps.push({ phase, step, code: 124, ms: 0 });
          log.push(`[${phase}] $ terraform ${args.join(" ")} → 안 돌림 (env 층 예산 다 씀, TF_ENV_LAYER_BUDGET_SEC)`);
          return { code: 124, stdout: "" };
        }
        const r = await exec(tf, args, { cwd: dir, env: cenv, signal, timeoutMs: Math.min(stepMs, left) });
        steps.push({ phase, step, code: r.code, ms: Math.round(r.ms) });
        log.push(`[${phase}] $ terraform ${args.join(" ")} → exit ${r.code} (${Math.round(r.ms)}ms)`);
        if (r.code !== 0) log.push(...tail(`${r.stdout}\n${r.stderr}`));
        else if (!quiet) log.push(...tail(r.stdout, 3));
        return r;
      };
      let out: TfOutputs = {};
      for (const phase of ["cluster", "eso"] as const) {
        // 단계 시작마다 새 env (빌린 토큰 최신값). 워커 자기 자격은 부르는 쪽(gcpTerraformEnv)이 이미 지웠다
        const cenv = childEnv(o.env());
        writeFileSync(join(dir, "terraform.tfvars.json"), JSON.stringify({ ...vars, create_eso: phase === "eso" }, null, 2));
        if ((await run(phase, "init", [...G, "init", "-input=false", "-no-color"], cenv)).code !== 0) return done({ failedPhase: phase, failedStep: "init" });
        if ((await run(phase, "plan", [...G, "plan", "-input=false", "-no-color", lockTimeout, vf, "-out=../../../tfplan"], cenv)).code !== 0) return done({ failedPhase: phase, failedStep: "plan" });
        // 실패해도 지우지 않는다 (환경 소유, 사람이 보고 다시 apply 하거나 정리)
        if ((await run(phase, "apply", [...G, "apply", "-input=false", "-no-color", lockTimeout, "-auto-approve", "../../../tfplan"], cenv)).code !== 0) return done({ failedPhase: phase, failedStep: "apply" });
        if (phase === "eso") {
          const or = await run(phase, "output", [...G, "output", "-json", "-no-color"], cenv, true);
          if (or.code !== 0) return done({ failedPhase: phase, failedStep: "output" });
          out = parseOutputs(or.stdout);
        }
      }
      writeFileSync(join(dir, "outputs.json"), JSON.stringify(out, null, 2), { mode: 0o600 });
      const facts = envLayerFactsOf(out);
      if (!facts) { log.push("output 에 cluster_name·network_id·cluster_location 이 없다"); return done({ failedPhase: "eso", failedStep: "output" }); }
      return { ok: true, workDir: dir, steps, log, elapsedMs: Math.round(performance.now() - t0), facts };
    },
  };
}
export type EnvLayerRunner = Pick<ReturnType<typeof createEnvLayerRunner>, "apply">;
