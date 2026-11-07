import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider, TfOutputs, TfVars } from "@svc/contracts";
import { envNumber, tfBudget } from "@svc/contracts";

// Z70 DRAFT(ai): aws/gcp/onprem 의 "진짜 terraform 실행기".
// Z89: 기본이 진짜다. 흉내(예전 STUB)는 시험 전용 스위치 MOCK_IAC=1 하나로만 켠다 (test:db·e2e·prod-e2e 가 붙인다).
//   예전(Z70)은 USE_TERRAFORM=1 + TF_REAL_APPLY=1 둘 다 있어야 진짜였다 → 아무것도 안 붙이면 조용히 흉내로 끝나 "다 된 것처럼" 보였다.
//   대안 "스위치 둘 유지 + 기본만 1": 버림. 이름 둘이 남으면 어느 셸에서 하나만 0 이 되어 다시 흉내로 빠진다. 지금은 두 이름 다 무시한다
// 하는 일 (이전 하나 = 작업 폴더 하나 = state 하나, Z89: 회사(tenant)마다 폴더를 나눈다):
//   1) infra/modules/<환경>/app 의 *.tf 를 TF_WORK_DIR/<회사 slug>/<이전 id>/ 로 복사 (tests/·.terraform 제외, 루트 잠금 파일은 처음 한 번만 #373 B1)
//   2) 어댑터 toTerraform 결과(자리표시를 채운 것)를 terraform.tfvars.json 으로 쓴다
//   3) terraform init → plan -out=tfplan → apply tfplan → output -json
//   4) 출력 중 sensitive 아닌 문자열만 TfOutputs 로 돌려준다 + outputs.json 저장 (복제 끝점 {tf:키} 가 읽는다)
//   5) (aws, 관리자 ≠ 앱) 앱 DB 비밀번호를 만들어 비밀 그릇을 만든다 (ensureAwsAppSecret, destroy 뒤 지운다)
//   6) (선택) DB 비밀번호를 비밀 저장소에서 꺼내 db-secret.json(0600) 에 둔다. DB·감사 기록·로그에는 절대 안 남긴다
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

// ---- #373 B1: 이미지에 구운 provider 미러 ----
// worker 이미지는 provider 를 /opt/terraform/providers 에 미리 받아 두고 TF_CLI_CONFIG_FILE 로 그 미러를 먼저 보게 한다 (deploy/docker/terraform/).
// 루트 모듈 잠금 파일(.terraform.lock.hcl)을 같이 복사해야 terraform 이 미러에 있는 판을 고른다 (없으면 레지스트리 최신 판을 골라 다시 받는다)
export const LOCK_FILE = ".terraform.lock.hcl";
/** 잠금 파일을 작업 폴더로. DRAFT(ai): 이미 있으면 덮지 않는다 — 진행 중인 이전(재시도·컷오버 다시 apply·destroy)은 처음 고른 판 그대로 간다
 *  (덮으면 state 를 쓴 provider 판이 바뀐다). 그 판이 미러에 없으면 terraform 이 레지스트리에서 받는다 (예전과 같음) */
export function seedLockFile(srcDir: string, dstDir: string): void {
  const src = join(srcDir, LOCK_FILE);
  const dst = join(dstDir, LOCK_FILE);
  if (existsSync(src) && !existsSync(dst)) cpSync(src, dst);
}
/** 미러에서 깐 provider 는 작업 폴더 .terraform/providers 에 미러로 가는 심볼릭 링크로 남는다 (복사 0).
 *  이미지가 바뀌어 미러에서 그 판이 빠지면 링크가 끊기고, terraform 은 끊긴 링크 자리에 새로 받지 못해 init 이 멈춘다
 *  ("cannot install package into target directory ... because it is a symlink", 로컬 실측). init 전에 끊긴 링크만 지운다.
 *  이어진 링크·실제 폴더는 그대로. 지운 개수를 돌려준다 */
export function pruneStaleProviderLinks(tfDir: string): number {
  let n = 0;
  // providers/<호스트>/<이름공간>/<종류>/<판>/<os_arch> → 깊이 4 까지만
  const walk = (d: string, depth: number) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) { if (!existsSync(p)) { unlinkSync(p); n++; } }
      else if (e.isDirectory() && depth < 4) walk(p, depth + 1);
    }
  };
  walk(join(tfDir, ".terraform", "providers"), 0);
  return n;
}

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
const PASS_ENV = /^(PATH|HOME|USER|LANG|LC_[A-Z]+|TMPDIR|TZ|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|AWS_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|CLOUDSDK_[A-Z0-9_]+|GCE_METADATA_HOST|USE_GKE_GCLOUD_AUTH_PLUGIN|KUBECONFIG|TF_LOG|TF_LOG_PATH|TF_PLUGIN_CACHE_DIR|TF_CLI_CONFIG_FILE)$/;
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { TF_IN_AUTOMATION: "1", TF_INPUT: "0" };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && PASS_ENV.test(k)) out[k] = v;
  return out;
}

// 기본 exec: spawn. 잠금을 잃으면(signal abort) SIGINT → terraform 이 state 를 정리하며 멈춘다. 유예 뒤에도 살아 있으면 SIGKILL
// PF FM-ORC-14: 예전 유예 10초는 terraform 이 진행 중 생성(GKE 5~10분·RDS 10분+)을 기다리며 state 를 쓰기 전에 죽여 state 밖 고아 자원을 남겼다.
//   SIGINT 를 받은 terraform 은 새 자원을 시작하지 않고 진행 중인 것만 끝낸 뒤 state 를 쓴다 → 그만큼 기다린다.
//   DRAFT(ai): 기본 20분(TF_STOP_GRACE_SEC). apply 큐 만료 1시간·실행기 상한 45분 안
export const stopGraceMs = (env: NodeJS.ProcessEnv = process.env) => envNumber(env.TF_STOP_GRACE_SEC, 1200) * 1000;
export const spawnExec: Exec = (cmd, args, o) => new Promise((res) => {
  const t0 = performance.now();
  const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
  p.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
  // 유예는 워커 env 에서 (childEnv 는 TF_STOP_GRACE_SEC 를 안 넘김)
  const stop = () => { p.kill("SIGINT"); setTimeout(() => p.kill("SIGKILL"), stopGraceMs()).unref(); };
  const timer = setTimeout(() => { stderr += `\n[z70] timeout ${o.timeoutMs}ms → SIGINT`; stop(); }, o.timeoutMs);
  o.signal?.addEventListener("abort", stop, { once: true });
  p.on("error", (e) => { clearTimeout(timer); res({ code: 127, stdout, stderr: `${stderr}\n${e.message}`, ms: performance.now() - t0 }); });
  p.on("close", (code) => { clearTimeout(timer); o.signal?.removeEventListener("abort", stop); res({ code: code ?? 1, stdout, stderr, ms: performance.now() - t0 }); });
});

// ---- 실행기 ----
export interface RealRunnerOpts {
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  moduleRoot?: string;   // 기본 TF_MODULE_ROOT 또는 레포의 infra/modules (묶음 이미지는 레포 뿌리를 못 찾아 env 로 준다)
  workRoot?: string;     // 기본 TF_WORK_DIR 또는 ~/.svc-tf
  terraformBin?: string; // 기본 TF_BIN 또는 terraform
  secretEnv?: () => NodeJS.ProcessEnv;   // apply 뒤 gcloud 로 DB 비밀을 꺼낼 때의 환경. 긴 apply 동안 토큰이 바뀌니 그때 다시 만든다
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
  /** Z89: apply 단계가 실패해 만들다 만 자원을 바로 destroy 했는지 (TF_DESTROY_ON_FAIL=1 일 때만, 기본 0: Jeong 11/4 01:53Z) */
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

type DbSecretKey = "db_password" | "db_admin_password";
/** 작업 폴더 db-secret.json (0600). 없거나 깨졌으면 빈 표 */
function readDbSecret(f: string): Partial<Record<DbSecretKey, string>> {
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === "string" && v)) as Partial<Record<DbSecretKey, string>>;
  } catch { return {}; }
}
function writeDbSecret(f: string, v: Partial<Record<DbSecretKey, string>>) {
  writeFileSync(f, JSON.stringify(v), { mode: 0o600 });
  chmodSync(f, 0o600);
}
/** aws/root 가 관리자(마스터)와 앱 계정을 나눈 출력인가 (kinds/postgres admin_user). 옛 모듈로 만든 작업 폴더는 아니다 (앱 = 마스터) */
const awsAdminSplit = (out: TfOutputs): boolean => !!out.db_admin_username && !!out.db_password_secret_name;

export function createRealTerraformRunner(o: RealRunnerOpts = {}) {
  const env = o.env ?? process.env;
  const exec = o.exec ?? spawnExec;
  const moduleRoot = o.moduleRoot ?? (env.TF_MODULE_ROOT || DEFAULT_MODULE_ROOT);
  const workRoot = o.workRoot ?? workRootOf(env);
  const tf = o.terraformBin ?? env.TF_BIN ?? "terraform";
  // M8: apply 큐 expireInSeconds 3600 보다 짧게. 실측 전 기본 45분 (RDS 생성 10분대 + 여유)
  const budget = tfBudget(env);
  const timeoutMs = budget.stepSec * 1000;
  // PF RV-09: 작업 전체 예산. 단계 상한은 남은 예산을 넘지 않는다 (apply 길 = jobSec, 지우기 = destroySec 따로)
  let deadline = Number.POSITIVE_INFINITY;
  const startBudget = (sec: number) => { deadline = Date.now() + sec * 1000; };
  const cenv = childEnv(env);

  // *.tf 만 복사 (tests/ 는 terraform test 용, .terraform 은 각자 init). state·tfplan 은 작업 폴더에 남는다
  const copyTf = (src: string, dst: string) => {
    mkdirSync(dst, { recursive: true });
    for (const f of readdirSync(src)) if (f.endsWith(".tf")) cpSync(join(src, f), join(dst, f));
  };

  function prepare(provider: Provider, migrationId: string, tenant?: string): string {
    const dir = workDirOf(workRoot, migrationId, tenant);
    // RV-15: 작업 폴더에 terraform.tfstate(GCP random_password 원문)·outputs.json 이 생긴다 → 다른 로컬 사용자가 못 읽게 0700
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* 이미 있는 폴더·권한 없는 파일 시스템이면 그대로 */ }
    const base = REAL_MODULE_BASE[provider];
    if (!base) throw new Error(`no real terraform module for ${provider}`);
    const src = join(moduleRoot, base);
    if (!existsSync(join(src, ROOT_DIR, "main.tf"))) throw new Error(`no root module for ${provider}: ${join(base, ROOT_DIR)}`);
    copyTf(join(src, ROOT_DIR), join(dir, ROOT_DIR));
    seedLockFile(join(src, ROOT_DIR), join(dir, ROOT_DIR));   // #373 B1: 종류 모듈(kinds)은 잠금 파일이 없다 (루트 것 하나로 고른다)
    const kindsSrc = join(src, "kinds");
    if (existsSync(kindsSrc)) for (const k of readdirSync(kindsSrc, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      copyTf(join(kindsSrc, k.name), join(dir, "kinds", k.name));
    writeFileSync(join(dir, "provider.txt"), provider);
    if (tenant) writeFileSync(join(dir, "tenant.txt"), tenant);
    return dir;
  }

  // quiet: 성공 출력 본문을 log 에 안 넣는다 (output -json 값은 tfOutputs 로만)
  async function run(step: RealStep["step"], args: string[], cwd: string, steps: RealStep[], log: string[], signal?: AbortSignal, quiet = false) {
    const left = deadline - Date.now();
    if (left <= 0) {
      steps.push({ step, code: 124, ms: 0 });
      log.push(`$ terraform ${args.join(" ")} → 안 돌림 (작업 시간 예산 다 씀, TF_JOB_BUDGET_SEC·TF_DESTROY_BUDGET_SEC)`);
      return { code: 124, stdout: "", stderr: "terraform job budget exhausted", ms: 0 };
    }
    const r = await exec(tf, args, { cwd, env: cenv, signal, timeoutMs: Math.min(timeoutMs, left) });
    steps.push({ step, code: r.code, ms: round(r.ms) });
    log.push(`$ terraform ${args.join(" ")} → exit ${r.code} (${round(r.ms)}ms)`);
    if (r.code !== 0) log.push(...tail(`${r.stdout}\n${r.stderr}`, 15));
    else if (!quiet) log.push(...tail(r.stdout, 3));
    return r;
  }
  // init 앞에 끊긴 provider 링크 정리 (#373 B1). terraform 폴더 = root 모양이면 <작업 폴더>/root, 예전 통짜면 작업 폴더
  function init(layout: TfLayout, dir: string, steps: RealStep[], log: string[], signal?: AbortSignal) {
    const pruned = pruneStaleProviderLinks(layout === "root" ? join(dir, ROOT_DIR) : dir);
    if (pruned) log.push(`끊긴 provider 링크 ${pruned}개 정리 (이미지 미러에서 빠진 판, 이번 init 이 다시 받는다)`);
    return run("init", [...chdirArgs(layout), "init", "-input=false", "-no-color"], dir, steps, log, signal);
  }

  // AWS 도착 앱 DB 비밀번호 (관리자 ≠ 앱일 때: aws/root 출력 db_admin_username·db_password_secret_name).
  //   RDS 관리 비밀(rds!db-…)은 마스터 = 플랫폼 관리자 몫이다. 앱 계정 비밀번호는 여기서 만들어, 비밀 그릇을 "만들면서" 값을 넣는다 (CreateSecret 한 번).
  //   DRAFT(ai): Terraform 으로 못 넣는 이유 = 값 넣기(PutSecretValue)·refresh 의 값 읽기(GetSecretValue)가 실행 역할 천장 밖이다
  //   (permissions-lint: PutSecretValue 금지, GetSecretValue 는 rds!db-* 만). 만들기(CreateSecret)·태그는 천장 안, 지우기(DeleteSecret)는 managed-by=platform 태그일 때만.
  //   값은 db-secret.json(0600)에 먼저 적고 그릇을 만든다 → 재시도는 같은 값을 쓰고 "이미 있음"을 받아들인다.
  //   이 폴더에 값이 없는데 그릇이 이미 있으면 값을 모르므로 멈춘다 (지어내지 않는다). 앱 LOGIN 역할은 워커가 같은 값으로 만든다 (relay ensureTargetAppLogin)
  async function ensureAwsAppSecret(out: TfOutputs, vars: TfVars, dir: string, steps: RealStep[], log: string[], signal?: AbortSignal): Promise<boolean> {
    if (!awsAdminSplit(out)) return true;
    const f = join(dir, "db-secret.json");
    const saved = readDbSecret(f);
    const password = saved.db_password ?? randomBytes(24).toString("base64url");
    if (!saved.db_password) writeDbSecret(f, { ...saved, db_password: password });
    // 값은 명령줄에 안 싣는다 (ps 로 보임) → 0600 임시 파일을 file:// 로 넘기고 바로 지운다
    const body = join(dir, "app-db-secret.tmp.json");
    writeFileSync(body, JSON.stringify({ username: out.db_username ?? "", password }), { mode: 0o600 });
    const tags = [{ Key: "managed-by", Value: "platform" }, ...(["tenant_id", "app_name"] as const)
      .filter((k) => typeof vars[k] === "string" && vars[k]).map((k) => ({ Key: k === "tenant_id" ? "tenant" : "app", Value: String(vars[k]) }))];
    const region = typeof vars.region === "string" && vars.region ? ["--region", vars.region] : [];
    // 실행 역할(빌린 apply 세션) 명령: 천장 AppCreate(CreateSecret)·AppTag(TagResource). 관찰 역할 명령표(observe-permissions)와 무관
    const create = { cmd: env.AWS_BIN ?? "aws",
      args: ["secretsmanager", "create-secret", "--name", out.db_password_secret_name!, "--secret-string", `file://${body}`,
        "--description", "platform app DB login (worker-created, deleted with the migration's terraform destroy)", "--tags", JSON.stringify(tags), ...region] };
    try {
      const r = await exec(create.cmd, create.args, { cwd: dir, env: cenv, signal, timeoutMs: 60_000 });
      steps.push({ step: "secret", code: r.code, ms: round(r.ms) });
      log.push(`$ aws secretsmanager create-secret … (db_password 그릇) → exit ${r.code}`);
      if (r.code === 0) return true;
      if (/ResourceExistsException/.test(r.stderr) && saved.db_password) { log.push("  이미 있음: 앞 시도에서 같은 값으로 만든 그릇을 그대로 쓴다"); return true; }
      log.push(...tail(r.stderr, 3));
      if (/ResourceExistsException/.test(r.stderr))
        log.push(`  그릇 ${out.db_password_secret_name} 이 이미 있는데 이 작업 폴더에 값이 없다 → 값을 모르니 멈춘다 (그 그릇이 이 이전 것인지 확인하고 지운 뒤 다시 apply)`);
      // 이번에 지은 값은 버린다 (다음 시도가 남의 그릇을 "앞 시도 것"으로 믿지 않게)
      if (!saved.db_password) writeDbSecret(f, saved);
      return false;
    } finally { rmSync(body, { force: true }); }
  }

  // aws destroy 뒤: 실행기가 만든 앱 DB 비밀번호 그릇을 지운다 (Terraform state 밖이라 destroy 가 안 지운다). 없으면 그대로 성공
  async function deleteAwsAppSecret(dir: string, steps: RealStep[], log: string[], signal?: AbortSignal): Promise<boolean> {
    const at = (n: string) => { try { return JSON.parse(readFileSync(join(dir, n), "utf8")) as Record<string, unknown>; } catch { return {}; } };
    const provider = existsSync(join(dir, "provider.txt")) ? readFileSync(join(dir, "provider.txt"), "utf8").trim() : "";
    const out = at("outputs.json") as TfOutputs;
    if (provider !== "aws" || !awsAdminSplit(out)) return true;
    const vars = at("terraform.tfvars.json");
    const region = typeof vars.region === "string" && vars.region ? ["--region", vars.region] : [];
    // 실행 역할(빌린 destroy 세션) 명령: 천장 AppOwned(DeleteSecret, managed-by=platform 태그 = ensureAwsAppSecret 이 붙임)
    const del = { cmd: env.AWS_BIN ?? "aws",
      args: ["secretsmanager", "delete-secret", "--secret-id", out.db_password_secret_name!, "--force-delete-without-recovery", ...region] };
    const r = await exec(del.cmd, del.args, { cwd: dir, env: cenv, signal, timeoutMs: 60_000 });
    steps.push({ step: "secret", code: r.code, ms: round(r.ms) });
    log.push(`$ aws secretsmanager delete-secret … (db_password 그릇) → exit ${r.code}`);
    if (r.code === 0 || /ResourceNotFoundException/.test(r.stderr)) return true;
    log.push(...tail(r.stderr, 3));
    return false;
  }

  // DB 비밀번호 꺼내기 (TF_FETCH_DB_SECRET=1, 기본 1). 복제 끝점 {tf:db_password}·password_ref tf:db_admin_password 가 읽는다
  // db-secret.json 에는 비밀번호만 둔다. 계정 이름은 outputs.json(db_username = 앱, db_admin_username = 관리자)이 진실이다.
  //   예전엔 GCP(비밀 = 비밀번호 글자뿐)에서 db_username:"postgres" 를 써서 outputs 의 앱 계정 이름을 덮었다 → {tf:db_username} 이 남의 계정으로 붙었다
  // aws: 관리자를 나눈 출력이면 RDS 관리 비밀(마스터) = db_admin_password, 앱 비밀번호(db_password)는 ensureAwsAppSecret 이 이미 적었다.
  //   옛 출력(앱 = 마스터)이면 예전처럼 마스터 = db_password
  async function fetchSecret(provider: Provider, out: TfOutputs, dir: string, steps: RealStep[], log: string[], signal?: AbortSignal) {
    // 도착 프로젝트 = 빌린 토큰 env 의 CLOUDSDK_CORE_PROJECT (gcpTerraformEnv 가 gcp_target_project 로 채움). 없을 때만 예전 TF_FACT_PROJECT_ID
    //   (예전엔 TF_FACT_PROJECT_ID 가 먼저라 워커 env 에 남은 데모 프로젝트로 다른 회사의 비밀을 찾을 수 있었다)
    const project = env.CLOUDSDK_CORE_PROJECT || env.TF_FACT_PROJECT_ID;
    const gcpAccess = (secret: string) => ["secrets", "versions", "access", "latest", `--secret=${secret}`, ...(project ? [`--project=${project}`] : [])];
    const want: { key: "db_password" | "db_admin_password"; cmd: string; args: string[] }[] = [];
    const split = provider === "aws" && awsAdminSplit(out);
    if (provider === "aws" && out.db_master_secret_arn)
      want.push({ key: split ? "db_admin_password" : "db_password", cmd: env.AWS_BIN ?? "aws",
        args: ["secretsmanager", "get-secret-value", "--secret-id", out.db_master_secret_arn, "--query", "SecretString", "--output", "text"] });
    if (provider === "gcp" && out.db_password_secret_id) want.push({ key: "db_password", cmd: env.GCLOUD_BIN ?? "gcloud", args: gcpAccess(out.db_password_secret_id) });
    if (provider === "gcp" && out.db_admin_password_secret_id) want.push({ key: "db_admin_password", cmd: env.GCLOUD_BIN ?? "gcloud", args: gcpAccess(out.db_admin_password_secret_id) });
    if (!want.length) return false;
    const got: Partial<Record<(typeof want)[number]["key"], string>> = {};
    for (const w of want) {
      const r = await exec(w.cmd, w.args, { cwd: dir, env: o.secretEnv ? childEnv(o.secretEnv()) : cenv, signal, timeoutMs: 60_000 });
      steps.push({ step: "secret", code: r.code, ms: round(r.ms) });
      // 비밀값이 로그에 들어가지 않게: stdout 은 절대 log 에 안 넣는다
      log.push(`$ ${w.cmd} ${w.args[0]} … (${w.key}) → exit ${r.code}`);
      if (r.code !== 0) { log.push(...tail(r.stderr, 3)); continue; }
      const s = r.stdout.trim();
      let password = s;
      try { const j = JSON.parse(s) as { password?: string }; if (j.password) password = j.password; } catch { /* gcp: 비밀번호 그대로 */ }
      got[w.key] = password;
    }
    const f = join(dir, "db-secret.json");
    // aws 나눈 판: ensureAwsAppSecret 이 적은 앱 비밀번호는 남긴다
    const app = split ? readDbSecret(f).db_password : undefined;
    if (!Object.keys(got).length) return false;
    writeDbSecret(f, { ...(app ? { db_password: app } : {}), ...got });
    return Object.keys(got).length === want.length && (!split || !!app);
  }

  // Z89: state 잠금을 기다리는 시간 (같은 폴더에서 사람이 tf:real destroy 를 돌리는 중일 때). 기본 60초
  const lockTimeout = `-lock-timeout=${envNumber(env.TF_LOCK_TIMEOUT_SEC, 60)}s`;
  // DECISION(team) Jeong 11/4 01:53Z: 실패하면 사람에게 "재시도할까?"를 먼저 묻고, 지우기는 거절 → 롤백(rolled_back → target-destroy) 길에서만.
  //   그래서 apply 실패 즉시 destroy 는 기본 꺼짐(재시도는 같은 state 에서 이어 만든다). TF_DESTROY_ON_FAIL=1 이면 예전처럼 바로 지움
  const destroyOnFail = (env.TF_DESTROY_ON_FAIL ?? "0") === "1";

  return {
    workRoot,
    /** Z89: terraform 이 실행되는지 (워커 기동 점검·tf:real check). 자원은 안 만든다 */
    async version(): Promise<{ ok: boolean; version?: string; error?: string }> {
      const r = await exec(tf, ["version", "-json"], { cwd: tmpdirSafe(), env: cenv, timeoutMs: 15_000 });
      if (r.code !== 0) return { ok: false, error: r.code === 127 ? `terraform 실행 파일 없음 (${tf})` : tail(r.stderr, 2).join(" ") };
      try { return { ok: true, version: (JSON.parse(r.stdout) as { terraform_version?: string }).terraform_version }; }
      catch { return { ok: true, version: r.stdout.split("\n")[0]?.trim() }; }
    },
    // APP-22 (가): keepOnFail = 이미 서비스 중인 자원을 다시 apply 할 때(컷오버·롤백의 앱 DB 주소 바꾸기). 실패해도 destroy 하지 않는다 (도착 DB·앱이 지워짐)
    async apply(provider: Provider, migrationId: string, vars: TfVars, signal?: AbortSignal, tenant?: string, o: { keepOnFail?: boolean } = {}): Promise<RealApplyResult> {
      const t0 = performance.now();
      startBudget(budget.jobSec);
      const steps: RealStep[] = []; const log: string[] = [];
      const dir = prepare(provider, migrationId, tenant);
      const layout: TfLayout = "root";
      const G = chdirArgs(layout); const vf = `-var-file=${up(layout, "terraform.tfvars.json")}`; const planFile = up(layout, "tfplan");
      writeFileSync(join(dir, "terraform.tfvars.json"), JSON.stringify(vars, null, 2));
      const fail = (s: RealStep["step"]): RealApplyResult =>
        ({ ok: false, tfOutputs: {}, workDir: dir, steps, elapsedMs: round(performance.now() - t0), log, failedStep: s });
      if ((await init(layout, dir, steps, log, signal)).code !== 0) return fail("init");
      if ((await run("plan", [...G, "plan", "-input=false", "-no-color", lockTimeout, vf, `-out=${planFile}`], dir, steps, log, signal)).code !== 0) return fail("plan");
      if ((await run("apply", [...G, "apply", "-input=false", "-no-color", lockTimeout, "-auto-approve", planFile], dir, steps, log, signal)).code !== 0) {
        // Z89: apply 가 중간에 실패하면 일부 자원(VPC 보안 그룹·시크릿 그릇 등)이 이미 생겼을 수 있다 → 같은 state 로 바로 destroy.
        //   잠금을 잃어 멈춘 경우(signal abort)는 다른 워커가 이어받을 수 있으니 지우지 않는다.
        //   대안 "사람이 tf:real destroy": 버림(Z70 방식). 데모 중 잊으면 RDS 가 밤새 남는다(작업 뒤 자원 0 규칙)
        const r = fail("apply");
        if (destroyOnFail && !o.keepOnFail && !signal?.aborted) {
          startBudget(budget.destroySec);   // PF RV-09: 지우기는 apply 가 다 쓴 예산과 따로 (고아가 안 남게)
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
      writeFileSync(join(dir, "outputs.json"), JSON.stringify(tfOutputs, null, 2), { mode: 0o600 });
      // 앱 DB 비밀번호 그릇은 앱 배포(ExternalSecret)가 읽으니 TF_FETCH_DB_SECRET 과 상관없이 만든다. 못 만들면 apply 실패 (재시도는 같은 state·같은 값)
      if (provider === "aws" && !(await ensureAwsAppSecret(tfOutputs, vars, dir, steps, log, signal))) return fail("secret");
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
      if ((await init(layout, dir, steps, log, signal)).code !== 0) return { ok: false, steps, log, workDir: dir };
      const r = await run("plan", [...G, "plan", "-input=false", "-no-color", `-var-file=${up(layout, "terraform.tfvars.json")}`], dir, steps, log, signal);
      const summary = r.stdout.match(/Plan: .*$/m)?.[0];
      return { ok: r.code === 0, steps, log, workDir: dir, summary };
    },
    async destroy(migrationId: string, signal?: AbortSignal) {
      const t0 = performance.now();
      startBudget(budget.destroySec);
      const steps: RealStep[] = []; const log: string[] = [];
      // Z89: 회사 폴더 아래(<뿌리>/t-xxxxxxxx/<이전>) 먼저, 없으면 예전 폴더
      const found = findWorkDir(workRoot, migrationId);
      if (!found) return { ok: true, skipped: "no_work_dir", workDir: workDirOf(workRoot, migrationId), steps, log, elapsedMs: 0 };
      const dir = found;
      const layout = layoutOf(dir);   // 작업 폴더 모양대로 (예전 통짜 모듈로 만든 폴더가 남아 있어도 그 모양으로 지움)
      const G = chdirArgs(layout);
      if ((await init(layout, dir, steps, log, signal)).code !== 0)
        return { ok: false, workDir: dir, steps, log, elapsedMs: round(performance.now() - t0) };
      const r = await run("destroy", [...G, "destroy", "-input=false", "-no-color", lockTimeout, "-auto-approve", `-var-file=${up(layout, "terraform.tfvars.json")}`], dir, steps, log, signal);
      // aws: 실행기가 만든 앱 DB 비밀번호 그릇도 지운다 (state 밖). 못 지우면 실패로 돌려 다시 지우게 한다 (다시 불러도 안전: 없으면 성공)
      const secretGone = r.code === 0 ? await deleteAwsAppSecret(dir, steps, log, signal) : true;
      return { ok: r.code === 0 && secretGone, workDir: dir, steps, log, elapsedMs: round(performance.now() - t0) };
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
