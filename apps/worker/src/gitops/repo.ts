import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { HelmValues } from "@svc/contracts";
import { APP_NS_PREFIX, GKE_SECRET_FILE, bundlePath, commitMessage, fenceDoc, gkeClusterSecret, resourceId, type BundleRef, type GkeAccess, type PlanFile } from "./bundle.js";

const run = promisify(execFile);

export class GitopsError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface GitopsConfig {
  dir: string;                 // gitops 레포 작업 복사본
  url?: string;                // 있으면 dir에 없을 때 clone 한다 (GITOPS_REPO_URL)
  token?: string;              // 쓰기 토큰 (GITOPS_WRITE_TOKEN). 명령줄·로그·감사에 안 남게 환경변수로만 git에 넘긴다
  branch: string;
  push: boolean;               // origin이 있고 push를 켰을 때만
  author: { name: string; email: string };
  maxPushTries: number;
}

// .env 이름 (계정 세팅에서 정함): GITOPS_REPO_URL, GITOPS_WRITE_TOKEN(워커), GITOPS_READ_TOKEN(Argo CD 몫, 워커는 안 씀).
// GITOPS_REPO_DIR = 로컬 시험용 작업 복사본. URL과 같이 주면 그 자리에 clone 한다.
// 둘 다 없으면 null → deploy 작업은 예전 STUB 길로 간다 (smoke 유지)
export function configFromEnv(env = process.env): GitopsConfig | null {
  // GITOPS_DISABLE=1 이면 설정이 있어도 STUB (test:db 가 이걸로 gitops 길을 끈다)
  if (env.GITOPS_DISABLE === "1" || (!env.GITOPS_REPO_DIR && !env.GITOPS_REPO_URL)) return null;
  return {
    dir: env.GITOPS_REPO_DIR ?? join(tmpdir(), "platform-gitops"),
    url: env.GITOPS_REPO_URL,
    token: env.GITOPS_WRITE_TOKEN,
    branch: env.GITOPS_BRANCH ?? "main",
    // DECISION(통합, 10/31): push 기본 꺼짐. 1일 때만 원격에 올린다 (.env 그대로 smoke·시험을 돌려도 실제 레포가 안 바뀌게)
    push: env.GITOPS_PUSH === "1",
    author: { name: env.GITOPS_AUTHOR_NAME ?? "platform-worker", email: env.GITOPS_AUTHOR_EMAIL ?? "worker@platform.invalid" },
    maxPushTries: 3,
  };
}

// Z38 REVIEW-6 R6-2: 워커 이미지를 WITH_GIT=0 (git 없음, 검증 VM 전용)으로 굽고 GitOps 를 켜면
//   deploy·shift·rollback 이 처음 git 을 부를 때마다 ENOENT 로 실패한다 (롤백까지 막힘). 뜰 때 한 번 보고 알린다.
//   GitOps 가 꺼져 있으면(설정 없음·GITOPS_DISABLE=1) 아무것도 안 본다 → VM prod compose(설정 없음)는 그대로 뜬다
export async function gitopsPreflight(env: NodeJS.ProcessEnv = process.env,
  exec: (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv }) => Promise<unknown> = run): Promise<string | null> {
  if (!configFromEnv(env)) return null;
  try { await exec("git", ["--version"], { env: childEnv(env) }); return null; }
  catch (e) {
    return `GitOps 가 켜져 있는데 git 을 실행할 수 없다 (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). ` +
      "WITH_GIT=0 으로 만든 워커 이미지면 WITH_GIT=1 로 다시 빌드하거나, GitOps 를 끈다 (GITOPS_DISABLE=1)";
  }
}

export interface CommitResult { commit: string; bundleSha256: string; resources: string[]; changed: boolean }
// 렌더만 한 묶음 (커밋 없음). manifests = 커밋할 manifests/*.yaml 의 글자 그대로 (path 는 묶음 폴더 기준)
export interface RenderedBundle { bundleSha256: string; manifests: Array<{ path: string; yaml: string }> }
export interface CommitOpts {
  // 리허설한 지문. 렌더 결과가 다르면 커밋하지 않고 작업 복사본을 되돌린 뒤 REHEARSAL_BUNDLE_MISMATCH
  expectBundleSha?: string;
  // 있으면 허브의 고객 GKE 접속 정보도 같이 커밋한다 (묶음 지문에는 안 들어간다)
  gke?: GkeAccess;
}

// Z38-6: 자식 프로세스(git·npm·gitops 레포의 render/validate 스크립트)에는 워커 환경변수를 통째로 넘기지 않는다.
//   예전엔 process.env 그대로 → ANTHROPIC_API_KEY·CLOUDFLARE_API_TOKEN·GITOPS_WRITE_TOKEN·REPL_*_URL(DB 비밀번호)이
//   gitops 레포 코드와 npm install 의 설치 스크립트(의존성 패키지 코드)에 다 보였다
// DRAFT(ai): 실행에 필요한 것만 (경로·로캘·프록시·인증서·ssh 에이전트·GIT_ 접두어)
// Z57 고침: GIT_CONFIG_KEY_0·GIT_CONFIG_VALUE_0 처럼 숫자가 붙은 이름도 넘긴다. 예전 GIT_[A-Z_]+ 는 GIT_CONFIG_COUNT 만 넘기고
//   KEY_0/VALUE_0 을 빼서 git 이 "missing config key GIT_CONFIG_KEY_0" 으로 모든 명령에 실패했다 (그런 환경변수가 있는 호스트·CI)
const PASS_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z]+|TZ|SSH_AUTH_SOCK|https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|GIT_[A-Z0-9_]+|HELM_[A-Z_]+|NODE_OPTIONS|SystemRoot|APPDATA)$/;
export function childEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(src).filter(([k, v]) => v !== undefined && PASS_ENV.test(k)));
}
// Z47-08 와 같은 수정이 겹쳐 하나로 합침(Z57): 허용 목록(Z38) + helm·node 변수(Z47) + 설치 스크립트 끄기 해제 스위치(Z47)
export const toolEnv = childEnv;

// 한 프로세스 안에서는 레포 작업을 한 줄로 세운다 (git index는 동시에 못 쓴다)
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> {
  const next = chain.then(f, f);
  chain = next.catch(() => undefined);
  return next;
}

export class GitopsRepo {
  constructor(readonly cfg: GitopsConfig) {}

  // 토큰은 GIT_CONFIG_* 환경변수로만 넘긴다 (argv에 넣으면 실패 메시지에 그대로 찍힌다)
  private gitEnv(): NodeJS.ProcessEnv {
    if (!this.cfg.token) return childEnv();
    const basic = Buffer.from(`x-access-token:${this.cfg.token}`).toString("base64");
    return { ...childEnv(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
             GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
  }
  private scrub(msg: string): string {
    const t = this.cfg.token;
    return t ? msg.split(t).join("***").split(Buffer.from(`x-access-token:${t}`).toString("base64")).join("***") : msg;
  }
  private async git(...args: string[]) {
    try {
      const { stdout } = await run("git", ["-C", this.cfg.dir,
        "-c", `user.name=${this.cfg.author.name}`, "-c", `user.email=${this.cfg.author.email}`, ...args], { env: this.gitEnv() });
      return stdout.trim();
    } catch (e) {
      throw new GitopsError("GITOPS_GIT_FAILED", this.scrub((e as Error).message).split("\n").slice(0, 3).join(" | "));
    }
  }

  // URL 모드: 작업 복사본이 없으면 clone, 검증 도구 의존성이 없으면 설치
  private async ensureCheckout() {
    const exists = (p: string) => access(p).then(() => true, () => false);
    if (!(await exists(join(this.cfg.dir, ".git")))) {
      if (!this.cfg.url) throw new GitopsError("GITOPS_NO_CHECKOUT", `작업 복사본이 없다: ${this.cfg.dir}`);
      await mkdir(dirname(this.cfg.dir), { recursive: true });
      try {
        await run("git", ["clone", "-q", "--branch", this.cfg.branch, this.cfg.url, this.cfg.dir], { env: this.gitEnv() });
      } catch (e) {
        throw new GitopsError("GITOPS_GIT_FAILED", this.scrub((e as Error).message).split("\n")[0]!);
      }
    }
    if (!(await exists(join(this.cfg.dir, "tools", "node_modules")))) {
      // Z38-6: 의존성 설치 스크립트는 돌리지 않는다(--ignore-scripts). 검증 도구는 순수 JS 라 필요 없다 【추정】
      //   필요하면 GITOPS_NPM_SCRIPTS=1 (Z47-08)
      const scripts = process.env.GITOPS_NPM_SCRIPTS === "1" ? [] : ["--ignore-scripts"];
      await run("npm", ["install", "--prefix", "tools", "--no-audit", "--no-fund", ...scripts],
        { cwd: this.cfg.dir, env: childEnv() });
    }
  }
  private async hasRemote() {
    try { await this.git("remote", "get-url", "origin"); return this.cfg.push; } catch { return false; }
  }
  private async tool(script: string, ...args: string[]) {
    try {
      const { stdout } = await run("node", [join("tools", script), ...args], { cwd: this.cfg.dir, maxBuffer: 8 << 20, env: childEnv() });
      return stdout;
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string; message: string };
      const lines = `${x.stdout ?? ""}\n${x.stderr ?? ""}`.split("\n").filter((l) => /FAIL|Error|error/.test(l)).slice(0, 5);
      throw new GitopsError(script === "validate.mjs" ? "GITOPS_VALIDATE_FAILED" : "GITOPS_RENDER_FAILED",
        lines.join(" | ") || x.message);
    }
  }

  async chartVersion(): Promise<string> {
    await serial(() => this.ensureCheckout());
    const y = await readFile(join(this.cfg.dir, "charts", "app", "Chart.yaml"), "utf8");
    return y.match(/^version: (\S+)$/m)?.[1] ?? "0.0.0";
  }

  async readValues(b: BundleRef): Promise<HelmValues> {
    return JSON.parse(await readFile(join(this.cfg.dir, bundlePath(b), "values.yaml"), "utf8")) as HelmValues;
  }
  async readPlan(b: BundleRef): Promise<PlanFile> {
    return JSON.parse(await readFile(join(this.cfg.dir, bundlePath(b), "plan.json"), "utf8")) as PlanFile;
  }

  // 계약 3절 1~7번. values.yaml은 JSON으로 쓴다 (JSON은 그대로 YAML이라 helm·검증 도구가 읽는다)
  commitBundle(kind: "deploy" | "traffic", b: BundleRef, values: HelmValues, plan: PlanFile, title: string, opts: CommitOpts = {}): Promise<CommitResult> {
    return serial(async () => {
      // 렌더·검사가 실패하면 쓴 파일을 되돌린다. 안 그러면 커밋 안 된 묶음이 작업 복사본에 남고,
      //   validate 는 디스크의 모든 회사를 보므로 같은 워커의 다음 배포(다른 회사 포함)가 전부 같은 이유로 실패한다 (2026-11-04 재현)
      const { remote, rel, written } = await this.writeAndRender(b, values, plan, opts.gke).catch(async (e: unknown) => {
        await this.revert(b).catch(() => undefined);
        throw e;
      });
      if (opts.expectBundleSha !== undefined && written.bundleSha256 !== opts.expectBundleSha) {
        await this.revert(b);
        throw new GitopsError("REHEARSAL_BUNDLE_MISMATCH",
          `커밋 직전 렌더 지문 ${written.bundleSha256.slice(0, 12)} 이 리허설한 지문 ${opts.expectBundleSha.slice(0, 12)} 과 다르다`);
      }
      await this.git("add", "-A", "--", rel, `tenants/${b.tenant}/argocd`);
      let changed = true;
      try { await this.git("diff", "--cached", "--quiet"); changed = false; } catch { /* 바뀐 게 있다 */ }
      if (changed) await this.git("commit", "-q", "-m", commitMessage(kind, b, written, title));
      // push 가 끝내 실패하면 로컬 커밋을 걷어 원격과 같게 돌린다. 남기면 다음 회사 배포의 push 에 실려 멈춘 묶음이 몰래 올라가고,
      //   그 사이 원격이 앞서면 pull --ff-only 가 깨져 이 워커의 모든 배포가 막힌다 (2026-11-04 재현). 재개하면 다시 렌더·커밋한다
      if (remote) await this.pushWithRetry().catch(async (e: unknown) => {
        await this.git("reset", "-q", "--hard", `origin/${this.cfg.branch}`).catch(() => undefined);
        await this.revert(b).catch(() => undefined);
        throw e;
      });
      const commit = await this.git("rev-parse", "HEAD");
      return { commit, bundleSha256: written.bundleSha256, resources: await this.resources(b), changed };
    });
  }

  // 리허설용: commitBundle 과 같은 순서로 쓰고 렌더하고 검사한 뒤, 커밋하지 않고 같은 임계 구역 안에서 되돌린다.
  //   다른 이전의 커밋은 되돌린 뒤에야 작업 복사본을 본다. 렌더가 실패해도 되돌린다
  renderBundle(b: BundleRef, values: HelmValues, plan: PlanFile): Promise<RenderedBundle> {
    return serial(async () => {
      try {
        const { abs, written } = await this.writeAndRender(b, values, plan);
        const md = join(abs, "manifests");
        const names = (await readdir(md)).filter((n) => n.endsWith(".yaml")).sort();
        const manifests = await Promise.all(names.map(async (n) => ({ path: `manifests/${n}`, yaml: await readFile(join(md, n), "utf8") })));
        return { bundleSha256: written.bundleSha256, manifests };
      } finally {
        await this.revert(b);
      }
    });
  }

  private async writeAndRender(b: BundleRef, values: HelmValues, plan: PlanFile, gke?: GkeAccess) {
    await this.ensureCheckout();
    const remote = await this.hasRemote();
    if (remote) await this.git("pull", "--ff-only", "origin", this.cfg.branch);
    const rel = bundlePath(b);
    const abs = join(this.cfg.dir, rel);
    await mkdir(abs, { recursive: true });
    await writeFile(join(abs, "values.yaml"), JSON.stringify(values, null, 2) + "\n");
    await writeFile(join(abs, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
    // 온프레(agent-pull)는 목적지 클러스터가 없지만(null) gitops validate 는 묶음이 있는 회사마다 울타리 파일을 요구한다
    //   → 없을 때만 목적지 없는 울타리를 만든다 (안 그러면 온프레만 쓰는 회사의 첫 배포가 GITOPS_VALIDATE_FAILED)
    await this.ensureFence(b.tenant, plan.target.cluster);
    if (gke) await this.writeGkeSecret(b.tenant, gke, plan.target.namespace);
    await this.tool("render.mjs", rel);
    await this.tool("validate.mjs");
    return { remote, rel, abs, written: await this.readPlan(b) };
  }

  // 묶음 폴더와 회사 울타리를 HEAD 그대로 돌린다. HEAD 에 없던 경로(첫 배포)는 checkout 이 실패하므로 clean 으로 지운다
  private async revert(b: BundleRef) {
    const paths = [bundlePath(b), `tenants/${b.tenant}/argocd`];
    for (const p of paths) {
      if (await this.git("ls-tree", "-r", "--name-only", "HEAD", "--", p).catch(() => "")) await this.git("checkout", "-q", "HEAD", "--", p);
    }
    await this.git("clean", "-fdq", "--", ...paths);
    // git 은 빈 폴더를 안 지운다. 첫 배포가 남긴 tenants/<회사>/apps/<앱>/ 빈 폴더가 있으면 validate 가 그 회사를 세고
    //   "울타리 없다"로 같은 워커의 다음 배포를 막는다 → 묶음 위쪽 빈 폴더를 회사 폴더까지 지운다 (비어 있지 않으면 rmdir 이 실패하고 그대로 둔다)
    for (let d = dirname(bundlePath(b)); d.startsWith(`tenants/${b.tenant}`); d = dirname(d)) {
      await rmdir(join(this.cfg.dir, d)).catch(() => undefined);
    }
  }

  // 울타리가 없으면 만들고, 이 클러스터가 목적지에 없으면 더한다. 사람이 YAML로 쓴 울타리는 건드리지 않는다
  //   cluster = null (온프레 agent-pull): 울타리가 있으면 그대로, 없으면 목적지 없이 만든다
  private async ensureFence(tenant: string, cluster: string | null) {
    const p = join(this.cfg.dir, "tenants", tenant, "argocd", "appproject.yaml");
    const text = await readFile(p, "utf8").catch(() => null);
    const root = await readFile(join(this.cfg.dir, "platform", "project-platform-root.yaml"), "utf8");
    const repoUrl = root.match(/sourceRepos:\s*\n\s*- (\S+)/)?.[1] ?? this.cfg.url ?? "";
    let clusters: string[] = [];
    if (text !== null && cluster === null) return;
    if (text !== null) {
      let doc: { spec?: { destinations?: Array<{ name: string; namespace?: string }> } };
      try { doc = JSON.parse(text); } catch {
        if (new RegExp(`name: ${cluster}$`, "m").test(text)) return;
        throw new GitopsError("GITOPS_FENCE_MANUAL", `${tenant} 울타리가 사람이 쓴 YAML이라 목적지 ${cluster}를 더하지 못한다`);
      }
      clusters = (doc.spec?.destinations ?? []).map((d) => d.name);
      // Z66: 옛 구역 규칙(<회사>-*)으로 만든 울타리는 클러스터가 이미 있어도 app-* 로 다시 쓴다 (안 그러면 validate 가 막는다)
      const current = (doc.spec?.destinations ?? []).every((d) => d.namespace === `${APP_NS_PREFIX}*`);
      if (cluster !== null && clusters.includes(cluster) && current) return;
    }
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(fenceDoc(tenant, repoUrl, cluster === null ? clusters : [...clusters, cluster]), null, 2) + "\n");
  }

  // 같은 회사의 다른 앱 구역은 지우지 않고 더한다
  // ponytail: 앱을 정리해도 구역은 안 뺀다. 앱 정리 코드가 생기면 거기서 뺀다 (RoleBinding 이 사라진 구역이 남으면 Argo 가 그 클러스터를 못 읽는다)
  private async writeGkeSecret(tenant: string, gke: GkeAccess, namespace: string) {
    const p = join(this.cfg.dir, "tenants", tenant, "argocd", GKE_SECRET_FILE);
    const text = await readFile(p, "utf8").catch(() => null);
    const seen = text === null ? [] : (JSON.parse(text) as { stringData: { namespaces: string } }).stringData.namespaces.split(",");
    await writeFile(p, JSON.stringify(gkeClusterSecret(tenant, gke, [...seen, namespace]), null, 2) + "\n");
  }

  private async pushWithRetry() {
    for (let i = 1; ; i++) {
      try { await this.git("push", "-q", "origin", `HEAD:${this.cfg.branch}`); return; } catch (e) {
        if (i >= this.cfg.maxPushTries) throw new GitopsError("GITOPS_PUSH_FAILED", (e as Error).message);
        // 앞섬 충돌: 묶음 폴더는 env lock으로 한 이전만 쓰니, 남의 커밋 위로 다시 올리면 된다
        // Z59: 단, 회사 울타리(tenants/<t>/argocd/appproject.yaml)는 같은 회사의 다른 환경 이전과 같이 고친다 → 되감기 충돌이 날 수 있다.
        // 충돌이면 되감기를 취소하고 원격 상태로 되돌린 뒤 실패로 알린다 (작업 복사본이 rebase 중으로 남으면 다음 커밋이 전부 막힌다).
        // deploy 는 paused 로 멈추고, 재개하면 최신 울타리 위에서 다시 렌더한다
        try { await this.git("pull", "-q", "--rebase", "origin", this.cfg.branch); }
        catch (re) {
          await this.git("rebase", "--abort").catch(() => undefined);
          await this.git("reset", "-q", "--hard", `origin/${this.cfg.branch}`).catch(() => undefined);
          throw new GitopsError("GITOPS_PUSH_CONFLICT", (re as Error).message);
        }
      }
    }
  }

  private async resources(b: BundleRef): Promise<string[]> {
    const md = join(this.cfg.dir, bundlePath(b), "manifests");
    const names = (await readdir(md)).filter((n) => n.endsWith(".yaml")).sort();
    const ids = await Promise.all(names.map(async (n) => resourceId(await readFile(join(md, n), "utf8"))));
    return ids.filter((x): x is string => !!x);
  }
}
