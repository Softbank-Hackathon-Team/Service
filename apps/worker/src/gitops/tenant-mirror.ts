import { execFile } from "node:child_process";
import { access, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { descendantUnchanged } from "./revision-check.js";

const run = promisify(execFile);

// 온프레(agent-pull) 묶음을 회사 전용 gitops 레포로 복사한다.
//   왜: 고객 Argo CD 가 공용 gitops 레포를 읽으면 그 읽기 자격으로 다른 회사 폴더까지 읽힌다 (GitHub 읽기 권한은 레포 단위).
//   회사 전용 레포 + 그 레포에만 걸린 읽기 전용 배포 키(고객 서버가 만든 키, 비밀 반쪽은 고객 클러스터 밖으로 안 나감)면
//   자격이 새도 그 회사 폴더만 보인다.
//   공용 레포는 그대로 원본이다 (렌더·검사·리허설·클라우드 배포는 지금처럼). 고객 Argo CD 가 보는 커밋은 회사 레포 커밋이다.
// 레포 이름 규칙은 API 등록(agent-enroll.ts tenantRepoFor)과 같은 GITOPS_TENANT_REPO_URL 하나로 정한다 ({tenant} = 회사 slug)

export interface TenantMirrorConfig {
  urlTemplate: string;          // 예: https://github.com/<조직>/gitops-{tenant}.git
  token?: string;               // 회사 레포 쓰기 토큰 (GITOPS_TENANT_TOKEN). 명령줄·로그에 안 남게 환경변수로만 git 에 넘긴다
  dir: string;                  // 회사 레포 작업 복사본들의 뿌리 (<dir>/<회사>)
  branch: string;
  push: boolean;
  author: { name: string; email: string };
  maxPushTries: number;
}

export class TenantMirrorError extends Error {
  constructor(readonly code: "GITOPS_TENANT_REPO_FAILED", message: string) { super(message); }
}

const SLUG = /^t-[0-9a-f]{8}$/;
export const tenantRepoUrl = (template: string, tenant: string) => template.split("{tenant}").join(tenant);

export class TenantMirror {
  constructor(readonly cfg: TenantMirrorConfig, private readonly env: () => NodeJS.ProcessEnv) {}

  private gitEnv(): NodeJS.ProcessEnv {
    if (!this.cfg.token) return this.env();
    const basic = Buffer.from(`x-access-token:${this.cfg.token}`).toString("base64");
    return { ...this.env(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
             GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
  }
  private scrub(msg: string): string {
    const t = this.cfg.token;
    return t ? msg.split(t).join("***").split(Buffer.from(`x-access-token:${t}`).toString("base64")).join("***") : msg;
  }
  private async git(dir: string, ...args: string[]): Promise<string> {
    try {
      const { stdout } = await run("git", ["-C", dir, "-c", `user.name=${this.cfg.author.name}`,
        "-c", `user.email=${this.cfg.author.email}`, ...args], { env: this.gitEnv() });
      return stdout.trim();
    } catch (e) {
      throw new TenantMirrorError("GITOPS_TENANT_REPO_FAILED", this.scrub((e as Error).message).split("\n").slice(0, 3).join(" | "));
    }
  }

  /** 공용 작업 복사본(srcRoot)의 tenants/<회사>/ 를 회사 레포에 그대로 옮기고 그 커밋을 돌려준다.
   *  tenants/<회사>/argocd/ (중앙 Argo CD 울타리·GKE 접속 정보)는 옮기지 않는다 — 고객 클러스터가 쓸 일이 없다.
   *  호출하는 쪽(GitopsRepo.commitBundle)이 이미 한 줄로 세운 구역 안에서 부른다 → 여기서 따로 줄 세우지 않는다 */
  async sync(srcRoot: string, tenant: string, message: string): Promise<string> {
    if (!SLUG.test(tenant)) throw new TenantMirrorError("GITOPS_TENANT_REPO_FAILED", `회사 이름 모양이 아니다: ${tenant}`);
    const dir = join(this.cfg.dir, tenant);
    const url = tenantRepoUrl(this.cfg.urlTemplate, tenant);
    if (!(await access(join(dir, ".git")).then(() => true, () => false))) {
      await mkdir(dirname(dir), { recursive: true });
      // 회사 레포는 API 가 등록 때 만든다. 빈 레포(가지 없음)여도 clone 은 된다
      try { await run("git", ["clone", "-q", url, dir], { env: this.gitEnv() }); }
      catch (e) { throw new TenantMirrorError("GITOPS_TENANT_REPO_FAILED", `회사 레포를 못 받았다 (${tenant}): ${this.scrub((e as Error).message).split("\n")[0]}`); }
    }
    for (let i = 1; ; i++) {
      await this.resetToRemote(dir);
      const dst = join(dir, "tenants", tenant);
      await rm(dst, { recursive: true, force: true });
      await mkdir(dst, { recursive: true });
      await cp(join(srcRoot, "tenants", tenant), dst, { recursive: true,
        filter: (p) => p !== join(srcRoot, "tenants", tenant, "argocd") });
      await this.git(dir, "add", "-A", "--", "tenants");
      let changed = true;
      try { await this.git(dir, "diff", "--cached", "--quiet"); changed = false; } catch { /* 바뀐 게 있다 */ }
      if (changed) await this.git(dir, "commit", "-q", "-m", message);
      if (!changed || !this.cfg.push) return this.git(dir, "rev-parse", "HEAD");
      try { await this.git(dir, "push", "-q", "origin", `HEAD:${this.cfg.branch}`); return this.git(dir, "rev-parse", "HEAD"); }
      catch (e) {
        // 앞섬(다른 워커가 같은 회사 레포에 먼저 올림): 원격으로 되돌리고 다시 옮긴다. 회사 레포는 워커만 쓴다
        if (i >= this.cfg.maxPushTries) throw e;
      }
    }
  }

  /** D3 (#373): Agent 가 보고한 회사 레포 리비전이 우리 커밋의 후손이고 묶음 폴더가 그대로인가 (revision-check.ts). 오류면 false.
   *  호출하는 쪽(GitopsRepo.revisionCovers)이 한 줄로 세운 구역 안에서 부른다 (fetch 가 sync 의 git 과 겹치지 않게) */
  covers(tenant: string, commit: string, rev: string, path: string): Promise<boolean> {
    if (!SLUG.test(tenant)) return Promise.resolve(false);
    return descendantUnchanged({ dir: join(this.cfg.dir, tenant), env: this.gitEnv() }, commit, rev, path);
  }

  // 원격에 가지가 있으면 그 상태로 맞춘다. 빈 레포(첫 push 전)면 그대로 둔다
  private async resetToRemote(dir: string) {
    if (!this.cfg.push) return;
    await this.git(dir, "fetch", "-q", "origin");
    const remote = await this.git(dir, "rev-parse", "--verify", "-q", `origin/${this.cfg.branch}`).catch(() => "");
    if (remote) {
      await this.git(dir, "checkout", "-q", "-B", this.cfg.branch, `origin/${this.cfg.branch}`);
      await this.git(dir, "reset", "-q", "--hard", `origin/${this.cfg.branch}`);
    } else {
      await this.git(dir, "checkout", "-q", "--orphan", this.cfg.branch).catch(() => undefined);
    }
  }
}

/** GITOPS_TENANT_REPO_URL 이 있을 때만 켠다 (없으면 예전처럼 공용 레포만). {tenant} 자리가 없으면 모든 회사가 한 레포를 쓰게 되므로 거부 */
export function tenantMirrorFromEnv(env: NodeJS.ProcessEnv, base: { dir: string; branch: string; push: boolean;
  author: { name: string; email: string } }): TenantMirrorConfig | null {
  const t = env.GITOPS_TENANT_REPO_URL?.trim();
  if (!t) return null;
  if (!t.includes("{tenant}")) throw new Error("GITOPS_TENANT_REPO_URL 에 {tenant} 자리가 없다 (회사마다 다른 레포여야 한다)");
  return { urlTemplate: t, token: env.GITOPS_TENANT_TOKEN, dir: `${base.dir}-tenants`, branch: base.branch,
           push: base.push, author: base.author, maxPushTries: 3 };
}
