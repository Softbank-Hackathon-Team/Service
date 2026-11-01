import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { WorkingCopy } from "@svc/agent";

// 작업 Z90b: 장애 점검(remediate)이 읽고 고치는 작업 복사본 = 진짜 GitOps 레포의 deploy/ 아래.
//   GITOPS_REPO_DIR(로컬 작업 복사본) 또는 GITOPS_REPO_URL 을 얕게(--depth 1) 임시 폴더로 받아 deploy/ 의 YAML 만 올린다.
//   설정이 없거나 GITOPS_DISABLE=1 이면 실행이 GITOPS_NOT_CONFIGURED 로 실패한다 (데모 고정 파일로 대신하지 않는다).
//   FAKE_LLM=1(시험)일 때만 demoRepo() 고정 파일.
// 게이트를 통과한 수정안은 같은 임시 복사본에서 새 브랜치 agent/remediate-<run 8자>에 커밋한다.
//   로컬 레포(GITOPS_REPO_DIR)는 그 브랜치를 원본에 바로 올린다(새 브랜치라 main 은 안 바뀜).
//   원격 URL 은 GITOPS_PUSH=1 일 때만 push (GITOPS_WRITE_TOKEN). GitHub PR 생성은 아직 안 함 → pr: null (사람이 브랜치로 PR)
// 토큰은 GIT_CONFIG_* 환경변수로만 git 에 넘긴다 (argv·로그에 안 남게). 자식 프로세스에는 필요한 환경변수만 (worker gitops/repo.ts 와 같은 규칙)
const run = promisify(execFile);
// Z90b-2 (Z38b 권고): GIT_* 통째 허용을 뺐다 (GIT_DIR·GIT_WORK_TREE 등이 넘어오면 임시 복사본 밖을 건드린다). 인증서·ssh 명령만
const PASS_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z]+|TZ|SSH_AUTH_SOCK|https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|GIT_SSH_COMMAND|GIT_SSL_CAINFO|SystemRoot|APPDATA)$/;
const MAX_FILES = 100, MAX_BYTES = 256 * 1024;

export class WorkcopyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = "WorkcopyError"; }
}
// push: local = 이 기계의 GITOPS_REPO_DIR 레포에 브랜치만 올림(원격 아님) / remote = GITOPS_PUSH=1 이라 원격에 push
//       off = 원격 레포인데 GITOPS_PUSH 가 꺼져 있어 push 안 함 (기본. 프로젝트 규칙: 원격 GitHub push 는 사람 승인 뒤 GITOPS_PUSH=1 로만)
export type PushState = "local" | "remote" | "off";
export interface Proposal { patch?: string;
   branch: string; commit: string; pushed: boolean; push: PushState; reason: string; files: string[]; pr: null }
export interface OpenWorkcopy {
  repo: WorkingCopy;
  // 게이트 통과한 수정안을 브랜치에 커밋. 바뀐 파일이 없으면 null
  propose(changed: WorkingCopy, title: string): Promise<Proposal | null>;
  dispose(): Promise<void>;
}
export type WorkcopyFactory = (ctx: { runId: string }) => Promise<OpenWorkcopy>;

type Env = Record<string, string | undefined>;
const childEnv = (src: Env) => Object.fromEntries(Object.entries(src).filter(([k, v]) => v !== undefined && PASS_ENV.test(k))) as NodeJS.ProcessEnv;
function authEnv(src: Env, token: string | undefined): NodeJS.ProcessEnv {
  const base = { ...childEnv(src), GIT_TERMINAL_PROMPT: "0" };
  if (!token) return base;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}
const scrub = (msg: string, token?: string) => (token ? msg.split(token).join("***") : msg).split("\n").slice(0, 2).join(" | ");

async function deployFiles(root: string): Promise<WorkingCopy> {
  const out: WorkingCopy = new Map();
  const base = join(root, "deploy");
  const exists = await access(base).then(() => true, () => false);
  if (!exists) throw new WorkcopyError("GITOPS_NO_DEPLOY_DIR", "GitOps 레포에 deploy/ 폴더가 없다");
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;            // Z90b-2: 심볼릭 링크는 따라가지 않는다 (레포 밖 파일 읽기 방지)
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.isFile() || !/\.ya?ml$/.test(e.name)) continue;
      if ((await stat(p)).size > MAX_BYTES) continue;
      if (out.size >= MAX_FILES) throw new WorkcopyError("GITOPS_DEPLOY_TOO_BIG", `deploy/ YAML 이 ${MAX_FILES}개를 넘는다`);
      out.set(relative(root, p).split("\\").join("/"), await readFile(p, "utf8"));
    }
  };
  await walk(base);
  if (out.size === 0) throw new WorkcopyError("GITOPS_NO_DEPLOY_DIR", "deploy/ 아래 YAML 이 없다");
  return out;
}

export function gitopsWorkcopyFromEnv(env: Env = process.env): WorkcopyFactory {
  const dir = env.GITOPS_REPO_DIR?.trim(), url = env.GITOPS_REPO_URL?.trim();
  const branch = env.GITOPS_BRANCH?.trim() || "main";
  const author = { name: env.GITOPS_AUTHOR_NAME ?? "platform-agent", email: env.GITOPS_AUTHOR_EMAIL ?? "agent@platform.invalid" };
  return async ({ runId }) => {
    if (env.GITOPS_DISABLE === "1" || (!dir && !url))
      throw new WorkcopyError("GITOPS_NOT_CONFIGURED", "GITOPS_REPO_DIR 나 GITOPS_REPO_URL 이 없다 (GITOPS_DISABLE=1 포함)");
    const local = Boolean(dir && (await access(join(dir, ".git")).then(() => true, () => false)));
    if (!local && !url) throw new WorkcopyError("GITOPS_NOT_CONFIGURED", "GITOPS_REPO_DIR 에 .git 이 없고 GITOPS_REPO_URL 도 없다");
    const src = local ? `file://${dir}` : url!;
    const readToken = local ? undefined : env.GITOPS_READ_TOKEN || env.GITOPS_WRITE_TOKEN;
    const tmp = await mkdtemp(join(tmpdir(), "agent-wc-"));
    const git = async (token: string | undefined, ...args: string[]) => {
      try {
        return (await run("git", ["-C", tmp, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, ...args],
          { env: authEnv(env, token) })).stdout.trim();
      } catch (e) { throw new WorkcopyError("GITOPS_GIT_FAILED", scrub((e as Error).message, token)); }
    };
    try {
      await run("git", ["clone", "-q", "--depth", "1", "--branch", branch, src, tmp], { env: authEnv(env, readToken) })
        .catch((e) => { throw new WorkcopyError("GITOPS_GIT_FAILED", scrub((e as Error).message, readToken)); });
      const repo = await deployFiles(tmp);
      return {
        repo,
        async propose(changed, title) {
          const files = [...changed.keys()].filter((k) => k.startsWith("deploy/"));
          if (!files.length) return null;
          // Z90b-2 (Z38b §24-17): 경로 탈출 막기. ".." 세그먼트 없고, 풀어 쓴 경로가 임시 복사본 deploy/ 안이어야 쓴다
          const deployRoot = resolve(tmp, "deploy") + sep;
          for (const f of files)
            if (f.split("/").some((seg) => seg === "" || seg === "." || seg === "..") || !resolve(tmp, f).startsWith(deployRoot))
              throw new WorkcopyError("GITOPS_BAD_PATH", `deploy/ 밖 경로: ${f.slice(0, 120)}`);
          const b = `agent/remediate-${runId.slice(0, 8)}`;
          await git(undefined, "checkout", "-q", "-b", b);
          for (const f of files) { await mkdir(dirname(join(tmp, f)), { recursive: true }); await writeFile(join(tmp, f), changed.get(f)!); }
          await git(undefined, "add", "--", ...files);
          await git(undefined, "commit", "-q", "-m", `agent: ${title.slice(0, 72)}\n\nagent_run ${runId} (AI 장애 점검 수정안, 게이트 통과, 사람 검토 전)`);
          const commit = await git(undefined, "rev-parse", "HEAD");
          // Z90b-2: 원격 push 는 GITOPS_PUSH=1 명시 때만. 로컬 레포(file://)는 그 레포의 원격(GitHub 등)으로는 절대 안 나간다
          //   (임시 복사본의 origin = 로컬 폴더라 push 대상이 그 폴더뿐)
          if (local) {
            await git(undefined, "push", "-q", "origin", `HEAD:refs/heads/${b}`);
            return { branch: b, commit, pushed: true, push: "local", reason: "GITOPS_REPO_DIR 로컬 레포에 브랜치만 (원격 push 아님)", files, pr: null };
          }
          if (env.GITOPS_PUSH === "1") {
            await git(env.GITOPS_WRITE_TOKEN, "push", "-q", "origin", `HEAD:refs/heads/${b}`);
            return { branch: b, commit, pushed: true, push: "remote", reason: "GITOPS_PUSH=1", files, pr: null };
          }
          // 원격 레포 + push 꺼짐: 커밋은 임시 복사본에만 있다가 지워진다 → 수정 내용을 패치로 남긴다 (사람이 적용)
          const patch = await git(undefined, "format-patch", "-1", "--stdout", "HEAD");
          return { branch: b, commit, pushed: false, push: "off", reason: "PUSH_DISABLED: GITOPS_PUSH 꺼짐 (원격 push 는 사람 승인 뒤 GITOPS_PUSH=1)",
            files, pr: null, patch: patch.slice(0, 64 * 1024) } as Proposal;
        },
        dispose: () => rm(tmp, { recursive: true, force: true }),
      };
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  };
}
