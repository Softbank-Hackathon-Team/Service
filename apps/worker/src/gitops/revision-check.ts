import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { BundleRef } from "./bundle.js";

// D3 (#373): Argo·Agent 가 보고한 리비전이 우리가 민 커밋과 다를 때 받아 줄지.
//   같은 가지에 다른 이전(다른 회사·다른 앱)이 뒤이어 커밋하면 Argo 는 가지 끝 리비전(우리 커밋의 후손)을 보고한다
//   → 정확히 같은 커밋만 보면 앱이 이미 떠 있어도 기다림 시간(600초)을 다 쓰고 ARGO_TIMEOUT 으로 멈춘다.
//   받는 조건: rev 가 commit 의 후손(git merge-base --is-ancestor) + 두 커밋 사이에 이 앱 묶음 폴더가 그대로(git diff --quiet -- <묶음 폴더>)
//   리비전 모양이 아님·작업 복사본 없음·git 오류·시간 초과 → 받지 않는다 (정확히 같은 커밋만). 틀려도 "안 받음" 쪽으로만 틀린다

// 전체 길이 SHA-1·SHA-256 만. 짧은 해시·가지 이름(Argo 가 비교 실패 때 "main" 을 보고한다)·옵션 모양 글자는 git 에 넘기지 않는다
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** git 한 번 실행 → 끝 코드. 실행 못 함·시간 초과는 -1 */
export type GitCode = (dir: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<number>;

const gitCode: GitCode = (dir, args, env, timeoutMs) => new Promise((res) => {
  execFile("git", ["-C", dir, ...args], { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err) => {
    if (!err) return res(0);
    const code = (err as { code?: unknown }).code;
    res(typeof code === "number" ? code : -1);
  });
});

// DRAFT(ai): fetch 30초, 로컬 명령 10초. 판정은 (커밋, 리비전) 짝마다 한 번이라 넉넉히 둔다
const FETCH_MS = 30_000;
const LOCAL_MS = 10_000;

/** rev 가 commit 의 후손이고 그 사이 path 가 그대로면 true. 로컬에 없는 리비전이면 origin 에서 한 번 받아 본다.
 *  dir 은 그 커밋을 만든 작업 복사본(공용 gitops 레포 또는 회사 레포). 어떤 오류든 false (던지지 않는다) */
export async function descendantUnchanged(repo: { dir: string; env: NodeJS.ProcessEnv }, commit: string, rev: string, path: string,
    git: GitCode = gitCode): Promise<boolean> {
  if (!SHA.test(commit) || !SHA.test(rev) || !path) return false;
  if (commit === rev) return true;
  try {
    // .git 이 없으면 git -C 가 위쪽 폴더의 다른 레포를 집을 수 있다 → 먼저 본다
    if (!(await access(join(repo.dir, ".git")).then(() => true, () => false))) return false;
    const run = (args: string[], ms = LOCAL_MS) => git(repo.dir, args, repo.env, ms);
    const known = async () => (await run(["cat-file", "-e", `${commit}^{commit}`])) === 0 && (await run(["cat-file", "-e", `${rev}^{commit}`])) === 0;
    if (!(await known())) {
      // 다른 워커가 올린 커밋일 수 있다. origin 이 없거나 받기가 실패하면 안 받음
      if ((await run(["fetch", "-q", "origin"], FETCH_MS)) !== 0 || !(await known())) return false;
    }
    if ((await run(["merge-base", "--is-ancestor", commit, rev])) !== 0) return false;   // 1 = 후손 아님, 그 밖 = 오류
    return (await run(["diff", "--quiet", commit, rev, "--", path])) === 0;              // 1 = 묶음 폴더가 바뀜, 그 밖 = 오류
  } catch {
    return false;
  }
}

/** (묶음, 우리 커밋, 보고 리비전) → 받아 줄지. GitopsRepo.revisionCovers 가 이 모양이다 */
export type RevisionCovers = (b: BundleRef, commit: string, rev: string) => Promise<boolean>;

/** 한 번의 기다림 안에서 쓰는 판정기. 같은 리비전이면 git 없이 true, 같은 (commit, rev) 는 한 번만 묻고 결과를 기억한다.
 *  covers 가 없으면(작업 복사본 없음·시험) 정확히 같은 커밋만 */
export function revisionMatcher(b: BundleRef, covers?: RevisionCovers): (commit: string, rev: string | undefined) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (commit, rev) => {
    if (!rev) return Promise.resolve(false);
    if (rev === commit) return Promise.resolve(true);
    if (!covers || !SHA.test(rev)) return Promise.resolve(false);
    const key = `${commit}..${rev}`;
    let p = cache.get(key);
    if (!p) {
      p = covers(b, commit, rev).then((x) => x === true, () => false);
      cache.set(key, p);
    }
    return p;
  };
}
