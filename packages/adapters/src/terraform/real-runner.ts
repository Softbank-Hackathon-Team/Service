import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider, TfOutputs, TfVars } from "@svc/contracts";
import { envNumber } from "@svc/contracts";

// Z70 DRAFT(ai): aws/gcp/onprem 의 "진짜 terraform 실행기".
// Z89: 기본이 진짜다. 흉내(예전 STUB)는 시험 전용 스위치 MOCK_IAC=1 하나로만 켠다 (test:db·e2e·prod-e2e 가 붙인다).
//   예전(Z70)은 USE_TERRAFORM=1 + TF_REAL_APPLY=1 둘 다 있어야 진짜였다 → 아무것도 안 붙이면 조용히 흉내로 끝나 "다 된 것처럼" 보였다.
//   대안 "스위치 둘 유지 + 기본만 1": 버림. 이름 둘이 남으면 어느 셸에서 하나만 0 이 되어 다시 흉내로 빠진다. 지금은 두 이름 다 무시한다
// 하는 일 (이전 하나 = 작업 폴더 하나 = state 하나, Z89: 회사(tenant)마다 폴더를 나눈다):
//   1) infra/modules/<환경>/app 의 *.tf 를 TF_WORK_DIR/<회사 slug>/<이전 id>/ 로 복사 (tests/·.terraform 제외)
//   2) 어댑터 toTerraform 결과(자리표시를 채운 것)를 terraform.tfvars.json 으로 쓴다
//   3) terraform init → plan -out=tfplan → apply tfplan → output -json
//   4) 출력 중 sensitive 아닌 문자열만 TfOutputs 로 돌려준다 + outputs.json 저장 (복제 끝점 {tf:키} 가 읽는다)
//   5) (선택) DB 비밀번호를 비밀 저장소에서 꺼내 db-secret.json(0600) 에 둔다. DB·감사 기록·로그에는 절대 안 남긴다
// state 는 로컬 파일(작업 폴더 안). 결선 전 TF backend 로컬 유지 결정(Z67)과 같다. 파기는 같은 폴더에서 destroy
// 클라우드 VM 스레드에서는 이 길을 켜지 않는다 (시험은 가짜 exec 로만)

export interface ExecResult { code: number; stdout: string; stderr: string; ms: number }
export interface ExecOpts { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }
export type Exec = (cmd: string, args: string[], o: ExecOpts) => Promise<ExecResult>;

/** Z89: 흉내 스위치. 시험(test:db·e2e·prod-e2e)만 1 을 붙인다. 그 밖에는 항상 진짜 terraform */
export function iacMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MOCK_IAC === "1";
}
/** 예전 이름 유지 (apply.ts·tools 가 부른다). Z89: = MOCK_IAC 가 아니면 진짜 */
export function realTerraformEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !iacMockEnabled(env);
}

// 이 파일 → 레포 뿌리 (packages/adapters/src/terraform → ../../../..)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const DEFAULT_MODULE_ROOT = join(REPO_ROOT, "infra/modules");

// Azure 는 Mock 실행기만 (진짜 apply 안 함, 결정 그대로)
// DRAFT(ai): 고정 루트 + 종류 모듈 (설계 27번 3.2). infra/modules/<환경>/{root,kinds/*} 를 작업 폴더 안 root/·kinds/ 로 복사하고 -chdir=root 로 돈다.
//   state·tfvars·outputs.json·db-secret.json 은 작업 폴더 바로 아래 (루트의 backend "local" path = "../terraform.tfstate").
//   루트는 kinds 폴더를 항상 참조하므로(없으면 init 실패) 있는 kinds 폴더는 전부 복사한다. 켜짐 여부는 종류 목록 변수가 비었는지로 표현.
export const REAL_MODULE_BASE: Partial<Record<Provider, string>> = { aws: "aws", gcp: "gcp", onprem: "onprem" };
export const ROOT_DIR = "root";
/** "root" = 지금 모양(root/main.tf). "flat" = 예전 통짜 app 모듈로 만든 작업 폴더 (만들지는 않고, 남은 것을 지울 때만 알아본다) */
export type TfLayout = "root" | "flat";
/** 작업 폴더 모양 (root/main.tf 가 있으면 root). destroy 가 예전 폴더도 같은 방법으로 지우게 */
export const layoutOf = (dir: string): TfLayout => (existsSync(join(dir, ROOT_DIR, "main.tf")) ? "root" : "flat");
// terraform 전역 옵션 (root 만 -chdir). 경로 인자는 root/ 기준이라 한 칸 위(../)로 쓴다
const chdirArgs = (layout: TfLayout) => (layout === "root" ? [`-chdir=${ROOT_DIR}`] : []);
const up = (layout: TfLayout, f: string) => (layout === "root" ? `../${f}` : f);

// ---- 자리표시 채우기 ----
// "<env:vpcId>" → TF_FACT_VPC_ID. 환경 표(environments)에 칸이 없는 env 모듈 출력·계정 사실을 환경변수로 받는다.
// DRAFT(ai): 대안 "environments 표에 칸 추가(새 마이그레이션)" 는 버림: 0013~0015 번호를 다른 작업이 쓰고 있어 충돌한다
export const factEnvName = (k: string) => `TF_FACT_${k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;

// Z77: env 모듈 create_eks=false 면 cluster_name 출력이 "" → export TF_FACT_CLUSTER_NAME="" 그대로 받는다 (aws 만, apply-real 이 검사)
export const ALLOW_EMPTY_FACTS = new Set(["TF_FACT_CLUSTER_NAME"]);

export function factsFromEnv(env: NodeJS.ProcessEnv, known: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(known)) if (v) out[k] = v;
  for (const [name, v] of Object.entries(env)) {
    // Z77: 빈 값은 "없음"으로 본다. 단 ALLOW_EMPTY_FACTS(클러스터 이름)는 빈 값 = "클러스터 없이" 라는 뜻으로 받는다
    if (!name.startsWith("TF_FACT_") || v === undefined || (v === "" && !ALLOW_EMPTY_FACTS.has(name))) continue;
    const camel = name.slice(8).toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    out[camel] ??= v;
  }
  return out;
}

export function fillTfVars(vars: TfVars, facts: Record<string, string>): { vars: TfVars; missing: string[] } {
  const missing = new Set<string>();
  const sub = (s: string) => s.replace(/<env:([A-Za-z0-9]+)>/g, (m, k: string) => {
    const v = facts[k];
    if (v === undefined) { missing.add(k); return m; }
    return v;
  });
  // TA11: v2 종류 목록(postgres_json 등)은 JSON 문자열 안에 자리표시가 들어 있다 → 풀어서 글자 칸만 채우고 다시 묶는다
  //   (그냥 바꾸면 값 안의 따옴표가 JSON 을 깨뜨림). JSON 이 아닌 값(v1 db_subnet_ids_json="<env:…>" 통째)은 예전 그대로
  const walk = (x: unknown): unknown => typeof x === "string" ? sub(x) : Array.isArray(x) ? x.map(walk)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([a, b]) => [a, walk(b)])) : x;
  const subJson = (v: string) => {
    if (!/^\s*[[{]/.test(v) || !v.includes("<env:")) return sub(v);
    try { return JSON.stringify(walk(JSON.parse(v))); } catch { return sub(v); }
  };
  const out: TfVars = {};
  for (const [k, v] of Object.entries(vars)) out[k] = typeof v === "string" ? subJson(v) : v;
  return { vars: out, missing: [...missing].sort() };
}

// ---- 자식 프로세스 환경 ----
// DRAFT(ai): gitops repo.ts PASS_ENV 와 같은 생각. terraform 에는 클라우드 자격·프록시·경로만 넘긴다.
// REPL_*_URL(DB 비밀번호)·ANTHROPIC_API_KEY·CLOUDFLARE_API_TOKEN·GITOPS_WRITE_TOKEN 은 넘기지 않는다
const PASS_ENV = /^(PATH|HOME|USER|LANG|LC_[A-Z]+|TMPDIR|TZ|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|AWS_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|CLOUDSDK_[A-Z0-9_]+|USE_GKE_GCLOUD_AUTH_PLUGIN|KUBECONFIG|TF_LOG|TF_LOG_PATH|TF_PLUGIN_CACHE_DIR|TF_CLI_CONFIG_FILE)$/;
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { TF_IN_AUTOMATION: "1", TF_INPUT: "0" };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && PASS_ENV.test(k)) out[k] = v;
  return out;
}

// 기본 exec: spawn. 잠금을 잃으면(signal abort) SIGINT → terraform 이 state 를 정리하며 멈춘다. 10초 뒤에도 살아 있으면 SIGKILL
export const spawnExec: Exec = (cmd, args, o) => new Promise((res) => {
  const t0 = performance.now();
  const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
  p.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
  const stop = () => { p.kill("SIGINT"); setTimeout(() => p.kill("SIGKILL"), 10_000).unref(); };
  const timer = setTimeout(() => { stderr += `\n[z70] timeout ${o.timeoutMs}ms → SIGINT`; stop(); }, o.timeoutMs);
  o.signal?.addEventListener("abort", stop, { once: true });
  p.on("error", (e) => { clearTimeout(timer); res({ code: 127, stdout, stderr: `${stderr}\n${e.message}`, ms: performance.now() - t0 }); });
  p.on("close", (code) => { clearTimeout(timer); o.signal?.removeEventListener("abort", stop); res({ code: code ?? 1, stdout, stderr, ms: performance.now() - t0 }); });
});

// ---- 실행기 ----
export interface RealRunnerOpts {
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  moduleRoot?: string;   // 기본 infra/modules
  workRoot?: string;     // 기본 TF_WORK_DIR 또는 ~/.svc-tf
  terraformBin?: string; // 기본 TF_BIN 또는 terraform
}
export interface RealStep { step: "init" | "plan" | "apply" | "output" | "destroy" | "secret" | "version"; code: number; ms: number }
export interface RealApplyResult {
  ok: boolean;
  tfOutputs: TfOutputs;
  workDir: string;
  steps: RealStep[];
  elapsedMs: number;
  log: string[];          // 마지막 줄 몇 개 (비밀 없음: terraform 은 sensitive 값을 (sensitive value) 로 가린다)
  failedStep?: RealStep["step"];
  secretFetched?: boolean;
  /** Z89: apply 단계가 실패해 만들다 만 자원을 바로 destroy 했는지 (TF_DESTROY_ON_FAIL, 기본 1) */
  destroyedAfterFail?: { ok: boolean; ms: number };
}

const tail = (s: string, n = 15) => s.split("\n").map((x) => x.trimEnd()).filter(Boolean).slice(-n);
const round = (x: number) => Math.round(x);

/** plan 전용 작업 폴더 이름. workDirOf 검사(hex·하이픈만)를 통과해야 한다 */
export const PLAN_ONLY_ID = "00000000-0000-4000-8000-000000000000";
// Z38 REVIEW-6 R6-1: 프로바이더마다 다른 폴더. 한 폴더를 같이 쓰면 prepare 가 *.tf 를 덮어쓰기만 하고 지우지 않아
//   `tf:real plan aws` 뒤 `plan gcp` 가 aws 파일(main.tf 이름이 같으면 덮이지만 다른 이름 파일은 남음)·.terraform 잠금 파일과 섞인다.
//   onprem 은 예전 번호 그대로 (맥 RC 메모·시험이 그 경로를 본다)
export const planOnlyId = (p: Provider) =>
  p === "onprem" ? PLAN_ONLY_ID : `00000000-0000-4000-8000-${({ aws: "0000000000a1", gcp: "0000000000b1" } as Partial<Record<Provider, string>>)[p] ?? "0000000000f1"}`;

export function workRootOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.TF_WORK_DIR || join(env.HOME ?? "/tmp", ".svc-tf");
}
// Z89: 회사 slug(gitops tenantSlug 와 같은 "t-" + 16진 8자). 폴더 이름에 들어가므로 모양을 엄격히 본다
export const TENANT_DIR_RE = /^t-[0-9a-f]{8}$/;
/** 작업 폴더. tenant 를 주면 <뿌리>/<회사>/<이전> (Z89 기본), 안 주면 예전 <뿌리>/<이전> (plan 전용·옛 폴더) */
export const workDirOf = (root: string, migrationId: string, tenant?: string) => {
  if (!/^[0-9a-f-]{8,}$/i.test(migrationId)) throw new Error(`bad migration id for work dir: ${migrationId}`);
  if (tenant === undefined) return join(root, migrationId);
  if (!TENANT_DIR_RE.test(tenant)) throw new Error(`bad tenant for work dir: ${tenant}`);
  return join(root, tenant, migrationId);
};
/** 이전 id 로 작업 폴더 찾기: <뿌리>/t-xxxxxxxx/<이전> 먼저, 없으면 예전 <뿌리>/<이전>. 둘 다 없으면 null.
 *  같은 이전 id 가 두 회사 폴더에 있으면(있을 수 없음: uuid) 에러로 멈춘다 — 엉뚱한 회사 state 를 destroy 하지 않게 */
export function findWorkDir(root: string, migrationId: string): string | null {
  workDirOf(root, migrationId);   // id 모양 검사
  const hits: string[] = [];
  if (existsSync(root)) for (const d of readdirSync(root)) {
    if (TENANT_DIR_RE.test(d) && existsSync(join(root, d, migrationId, "terraform.tfvars.json"))) hits.push(join(root, d, migrationId));
  }
  if (hits.length > 1) throw new Error(`migration ${migrationId} found under ${hits.length} tenants`);
  if (hits[0]) return hits[0];
  const legacy = join(root, migrationId);
  return existsSync(join(legacy, "terraform.tfvars.json")) ? legacy : null;
}

/** terraform output -json → 평평한 문자열 표. sensitive·문자열 아닌 값은 뺀다 (목록은 JSON 문자열로) */
export function parseOutputs(json: string): TfOutputs {
  const raw = JSON.parse(json || "{}") as Record<string, { value: unknown; sensitive?: boolean }>;
  const out: TfOutputs = {};
  for (const [k, o] of Object.entries(raw)) {
    if (!o || o.sensitive) continue;
    if (typeof o.value === "string") out[k] = o.value;
    else if (typeof o.value === "number" || typeof o.value === "boolean") out[k] = String(o.value);
    else if (o.value != null) out[k] = JSON.stringify(o.value);
  }
  return out;
}

export function createRealTerraformRunner(o: RealRunnerOpts = {}) {
  const env = o.env ?? process.env;
  const exec = o.exec ?? spawnExec;
  const moduleRoot = o.moduleRoot ?? DEFAULT_MODULE_ROOT;
  const workRoot = o.workRoot ?? workRootOf(env);
  const tf = o.terraformBin ?? env.TF_BIN ?? "terraform";
  // M8: apply 큐 expireInSeconds 3600 보다 짧게. 실측 전 기본 45분 (RDS 생성 10분대 + 여유)
  const timeoutMs = envNumber(env.TF_APPLY_TIMEOUT_SEC, 2700) * 1000;
  const cenv = childEnv(env);

  // *.tf 만 복사 (tests/ 는 terraform test 용, .terraform 은 각자 init). state·tfplan 은 작업 폴더에 남는다
  const copyTf = (src: string, dst: string) => {
    mkdirSync(dst, { recursive: true });
    for (const f of readdirSync(src)) if (f.endsWith(".tf")) cpSync(join(src, f), join(dst, f));
  };

  function prepare(provider: Provider, migrationId: string, tenant?: string): string {
    const dir = workDirOf(workRoot, migrationId, tenant);
    mkdirSync(dir, { recursive: true });
    const base = REAL_MODULE_BASE[provider];
    if (!base) throw new Error(`no real terraform module for ${provider}`);
    const src = join(moduleRoot, base);
    if (!existsSync(join(src, ROOT_DIR, "main.tf"))) throw new Error(`no root module for ${provider}: ${join(base, ROOT_DIR)}`);
    copyTf(join(src, ROOT_DIR), join(dir, ROOT_DIR));
    const kindsSrc = join(src, "kinds");
    if (existsSync(kindsSrc)) for (const k of readdirSync(kindsSrc, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      copyTf(join(kindsSrc, k.name), join(dir, "kinds", k.name));
    writeFileSync(join(dir, "provider.txt"), provider);
    if (tenant) writeFileSync(join(dir, "tenant.txt"), tenant);
    return dir;
  }

  // quiet: 성공 출력 본문을 log 에 안 넣는다 (output -json 값은 tfOutputs 로만)
  async function run(step: RealStep["step"], args: string[], cwd: string, steps: RealStep[], log: string[], signal?: AbortSignal, quiet = false) {
    const r = await exec(tf, args, { cwd, env: cenv, signal, timeoutMs });
    steps.push({ step, code: r.code, ms: round(r.ms) });
    log.push(`$ terraform ${args.join(" ")} → exit ${r.code} (${round(r.ms)}ms)`);
    if (r.code !== 0) log.push(...tail(`${r.stdout}\n${r.stderr}`, 15));
    else if (!quiet) log.push(...tail(r.stdout, 3));
    return r;
  }

  // DB 비밀번호 꺼내기 (TF_FETCH_DB_SECRET=1, 기본 1). 복제 끝점 {tf:db_password} 가 읽는다
  async function fetchSecret(provider: Provider, out: TfOutputs, dir: string, steps: RealStep[], log: string[], signal?: AbortSignal) {
    let cmd: string | null = null; let args: string[] = [];
    if (provider === "aws" && out.db_master_secret_arn) {
      cmd = env.AWS_BIN ?? "aws";
      args = ["secretsmanager", "get-secret-value", "--secret-id", out.db_master_secret_arn, "--query", "SecretString", "--output", "text"];
    } else if (provider === "gcp" && out.db_password_secret_id) {
      cmd = env.GCLOUD_BIN ?? "gcloud";
      args = ["secrets", "versions", "access", "latest", `--secret=${out.db_password_secret_id}`, ...(env.TF_FACT_PROJECT_ID ? [`--project=${env.TF_FACT_PROJECT_ID}`] : [])];
    }
    if (!cmd) return false;
    const r = await exec(cmd, args, { cwd: dir, env: cenv, signal, timeoutMs: 60_000 });
    steps.push({ step: "secret", code: r.code, ms: round(r.ms) });
    // 비밀값이 로그에 들어가지 않게: stdout 은 절대 log 에 안 넣는다
    log.push(`$ ${cmd} ${args[0]} … → exit ${r.code}`);
    if (r.code !== 0) { log.push(...tail(r.stderr, 3)); return false; }
    const s = r.stdout.trim();
    let user = "postgres", password = s;
    try { const j = JSON.parse(s) as { username?: string; password?: string }; if (j.password) { password = j.password; user = j.username ?? user; } } catch { /* gcp: 비밀번호 그대로 */ }
    const f = join(dir, "db-secret.json");
    writeFileSync(f, JSON.stringify({ db_username: user, db_password: password }), { mode: 0o600 });
    chmodSync(f, 0o600);
    return true;
  }

  // Z89: state 잠금을 기다리는 시간 (같은 폴더에서 사람이 tf:real destroy 를 돌리는 중일 때). 기본 60초
  const lockTimeout = `-lock-timeout=${envNumber(env.TF_LOCK_TIMEOUT_SEC, 60)}s`;
  const destroyOnFail = (env.TF_DESTROY_ON_FAIL ?? "1") !== "0";

  return {
    workRoot,
    /** Z89: terraform 이 실행되는지 (워커 기동 점검·tf:real check). 자원은 안 만든다 */
    async version(): Promise<{ ok: boolean; version?: string; error?: string }> {
      const r = await exec(tf, ["version", "-json"], { cwd: tmpdirSafe(), env: cenv, timeoutMs: 15_000 });
      if (r.code !== 0) return { ok: false, error: r.code === 127 ? `terraform 실행 파일 없음 (${tf})` : tail(r.stderr, 2).join(" ") };
      try { return { ok: true, version: (JSON.parse(r.stdout) as { terraform_version?: string }).terraform_version }; }
      catch { return { ok: true, version: r.stdout.split("\n")[0]?.trim() }; }
    },
    async apply(provider: Provider, migrationId: string, vars: TfVars, signal?: AbortSignal, tenant?: string): Promise<RealApplyResult> {
      const t0 = performance.now();
      const steps: RealStep[] = []; const log: string[] = [];
      const dir = prepare(provider, migrationId, tenant);
      const layout: TfLayout = "root";
      const G = chdirArgs(layout); const vf = `-var-file=${up(layout, "terraform.tfvars.json")}`; const planFile = up(layout, "tfplan");
      writeFileSync(join(dir, "terraform.tfvars.json"), JSON.stringify(vars, null, 2));
      const fail = (s: RealStep["step"]): RealApplyResult =>
        ({ ok: false, tfOutputs: {}, workDir: dir, steps, elapsedMs: round(performance.now() - t0), log, failedStep: s });
      if ((await run("init", [...G, "init", "-input=false", "-no-color"], dir, steps, log, signal)).code !== 0) return fail("init");
      if ((await run("plan", [...G, "plan", "-input=false", "-no-color", lockTimeout, vf, `-out=${planFile}`], dir, steps, log, signal)).code !== 0) return fail("plan");
      if ((await run("apply", [...G, "apply", "-input=false", "-no-color", lockTimeout, "-auto-approve", planFile], dir, steps, log, signal)).code !== 0) {
        // Z89: apply 가 중간에 실패하면 일부 자원(VPC 보안 그룹·시크릿 그릇 등)이 이미 생겼을 수 있다 → 같은 state 로 바로 destroy.
        //   잠금을 잃어 멈춘 경우(signal abort)는 다른 워커가 이어받을 수 있으니 지우지 않는다.
        //   대안 "사람이 tf:real destroy": 버림(Z70 방식). 데모 중 잊으면 RDS 가 밤새 남는다(작업 뒤 자원 0 규칙)
        const r = fail("apply");
        if (destroyOnFail && !signal?.aborted) {
          const d = await run("destroy", [...G, "destroy", "-input=false", "-no-color", lockTimeout, "-auto-approve", vf], dir, steps, log);
          r.destroyedAfterFail = { ok: d.code === 0, ms: round(d.ms) };
          r.elapsedMs = round(performance.now() - t0);
        }
        return r;
      }
      const or = await run("output", [...G, "output", "-json", "-no-color"], dir, steps, log, signal, true);
      if (or.code !== 0) return fail("output");
      const tfOutputs = parseOutputs(or.stdout);
      // Z77: Cloud SQL 서버 CA(공개 정보)는 파일로 빼고 경로만 남긴다 → REPL_TARGET_CA_FILE={tf:db_ca_file}
      if (tfOutputs.db_server_ca_cert) {
        writeFileSync(join(dir, "db-ca.pem"), tfOutputs.db_server_ca_cert.endsWith("\n") ? tfOutputs.db_server_ca_cert : `${tfOutputs.db_server_ca_cert}\n`);
        delete tfOutputs.db_server_ca_cert;
        tfOutputs.db_ca_file = join(dir, "db-ca.pem");
      }
      writeFileSync(join(dir, "outputs.json"), JSON.stringify(tfOutputs, null, 2));
      const secretFetched = (env.TF_FETCH_DB_SECRET ?? "1") === "1" ? await fetchSecret(provider, tfOutputs, dir, steps, log, signal) : false;
      return { ok: true, tfOutputs, workDir: dir, steps, elapsedMs: round(performance.now() - t0), log, secretFetched };
    },
    /** init + plan 만 (자원 안 만듦). tools/tf-real.ts plan 이 쓴다. 작업 폴더 이름은 planOnlyId(provider) */
    async planOnly(provider: Provider, vars: TfVars, signal?: AbortSignal) {
      const steps: RealStep[] = []; const log: string[] = [];
      const dir = prepare(provider, planOnlyId(provider), undefined);
      const layout: TfLayout = "root";
      const G = chdirArgs(layout);
      writeFileSync(join(dir, "terraform.tfvars.json"), JSON.stringify(vars, null, 2));
      if ((await run("init", [...G, "init", "-input=false", "-no-color"], dir, steps, log, signal)).code !== 0) return { ok: false, steps, log, workDir: dir };
      const r = await run("plan", [...G, "plan", "-input=false", "-no-color", `-var-file=${up(layout, "terraform.tfvars.json")}`], dir, steps, log, signal);
      const summary = r.stdout.match(/Plan: .*$/m)?.[0];
      return { ok: r.code === 0, steps, log, workDir: dir, summary };
    },
    async destroy(migrationId: string, signal?: AbortSignal) {
      const t0 = performance.now();
      const steps: RealStep[] = []; const log: string[] = [];
      // Z89: 회사 폴더 아래(<뿌리>/t-xxxxxxxx/<이전>) 먼저, 없으면 예전 폴더
      const found = findWorkDir(workRoot, migrationId);
      if (!found) return { ok: true, skipped: "no_work_dir", workDir: workDirOf(workRoot, migrationId), steps, log, elapsedMs: 0 };
      const dir = found;
      const layout = layoutOf(dir);   // 작업 폴더 모양대로 (예전 통짜 모듈로 만든 폴더가 남아 있어도 그 모양으로 지움)
      const G = chdirArgs(layout);
      if ((await run("init", [...G, "init", "-input=false", "-no-color"], dir, steps, log, signal)).code !== 0)
        return { ok: false, workDir: dir, steps, log, elapsedMs: round(performance.now() - t0) };
      const r = await run("destroy", [...G, "destroy", "-input=false", "-no-color", lockTimeout, "-auto-approve", `-var-file=${up(layout, "terraform.tfvars.json")}`], dir, steps, log, signal);
      return { ok: r.code === 0, workDir: dir, steps, log, elapsedMs: round(performance.now() - t0) };
    },
    /** 작업 폴더 목록 (state 가 남은 것 = 클라우드 자원이 남았을 수 있는 것) */
    list() {
      if (!existsSync(workRoot)) return [];
      // Z89: 예전 폴더(<뿌리>/<이전>) + 회사 폴더(<뿌리>/t-xxxxxxxx/<이전>) 둘 다
      const dirs: { d: string; tenant: string | null }[] = [];
      for (const d of readdirSync(workRoot)) {
        if (existsSync(join(workRoot, d, "terraform.tfvars.json"))) dirs.push({ d, tenant: null });
        else if (TENANT_DIR_RE.test(d)) for (const m of readdirSync(join(workRoot, d)))
          if (existsSync(join(workRoot, d, m, "terraform.tfvars.json"))) dirs.push({ d: join(d, m), tenant: d });
      }
      return dirs.map(({ d, tenant }) => {
        const dir = join(workRoot, d);
        const st = existsSync(join(dir, "terraform.tfstate")) ? readFileSync(join(dir, "terraform.tfstate"), "utf8") : "";
        let resources = 0;
        try { resources = (JSON.parse(st || "{}").resources ?? []).length; } catch { resources = -1; }
        const provider = existsSync(join(dir, "provider.txt")) ? readFileSync(join(dir, "provider.txt"), "utf8").trim() : "?";
        return { migrationId: tenant ? d.slice(tenant.length + 1) : d, tenant, provider, resources, workDir: dir };
      });
    },
  };
}
export type RealTerraformRunner = ReturnType<typeof createRealTerraformRunner>;

// ---- Z89 (코디네이터 결정 Z62 주제 57): 이미 있는 자원은 만들지 않는다 ----
// 가져오기(Z88 import / Z86 inventory)가 도착 자원을 찾으면 작업 폴더에 imported.json 을 둔다:
//   TF_WORK_DIR/<회사 slug>/<이전 id>/imported.json = { "source": "import", "tfOutputs": { "db_address": "...", ... }, "resources": ["aws_db_instance.db", ...] }
// 있으면 apply 는 terraform 을 부르지 않고 그 출력으로 provisioning → deploying ("이미 있음"). 없으면 평소대로 init/plan/apply.
// 대안 "terraform import 로 state 에 넣고 plan 0 변경 확인": 결선 뒤 (자원 주소 매핑이 모듈마다 달라 오늘 밤 범위 밖)
export interface ImportedInfra { source: string; tfOutputs: TfOutputs; resources: string[]; file: string }
export function readImported(root: string, migrationId: string, tenant: string): ImportedInfra | null {
  const f = join(workDirOf(root, migrationId, tenant), "imported.json");
  if (!existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, "utf8")) as { source?: unknown; tfOutputs?: unknown; resources?: unknown };
  const outs: TfOutputs = {};
  if (j.tfOutputs && typeof j.tfOutputs === "object")
    for (const [k, v] of Object.entries(j.tfOutputs as Record<string, unknown>)) if (typeof v === "string") outs[k] = v;
  return { source: typeof j.source === "string" ? j.source : "import", tfOutputs: outs,
           resources: Array.isArray(j.resources) ? j.resources.filter((x): x is string => typeof x === "string") : [], file: f };
}

function tmpdirSafe(): string { return process.env.TMPDIR || "/tmp"; }

// 복제 끝점의 {tf:키} 는 packages/replication/src/tf-facts.ts 가 같은 폴더(TF_WORK_DIR/<이전>/outputs.json, db-secret.json)를 읽는다
