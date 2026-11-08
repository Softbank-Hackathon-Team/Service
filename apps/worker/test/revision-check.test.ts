import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { descendantUnchanged, revisionMatcher, type GitCode, type RevisionCovers } from "../src/gitops/revision-check.js";
import { GitopsRepo } from "../src/gitops/repo.js";

// #373 D3: 후손 리비전 판정을 진짜 git 으로 본다 (원격 = 로컬 bare 레포, "다른 워커" 작업 복사본이 뒤이어 커밋)
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...a], { encoding: "utf8" }).trim();
const env = { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv;
const T = "t-1a2b3c4d";
const SHOP = `tenants/${T}/apps/shop/aws-eks`;
const SHOP_ONPREM = `tenants/${T}/apps/shop/onprem-k3s`;
const OTHER = "tenants/t-99999999/apps/other/aws-eks";

function put(dir: string, rel: string, text: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}
function commitAll(dir: string, msg: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

// R(뿌리) → A(우리 배포) → B(다른 회사만 바꿈) → C(우리 묶음을 바꿈), 그리고 R 에서 갈라진 X(후손 아님)
// mine = A 까지만 아는 이 워커의 작업 복사본 (B·C 는 "다른 워커"가 올렸다 → fetch 해야 보인다)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "revcheck-"));
  const bare = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const up = join(root, "up");
  execFileSync("git", ["clone", "-q", bare, up], { stdio: "ignore" });
  git(up, "symbolic-ref", "HEAD", "refs/heads/main");
  put(up, "README.md", "root\n");
  const R = commitAll(up, "root");
  put(up, `${SHOP}/values.yaml`, "{\"v\":1}\n");
  put(up, `${SHOP_ONPREM}/values.yaml`, "{\"v\":1}\n");
  put(up, `${OTHER}/values.yaml`, "{\"o\":1}\n");
  const A = commitAll(up, "deploy shop");
  git(up, "push", "-q", "origin", "main");
  const mine = join(root, "mine");
  execFileSync("git", ["clone", "-q", bare, mine], { stdio: "ignore" });
  put(up, `${OTHER}/values.yaml`, "{\"o\":2}\n");
  const B = commitAll(up, "deploy other tenant");
  put(up, `${SHOP}/values.yaml`, "{\"v\":2}\n");
  put(up, `${SHOP_ONPREM}/values.yaml`, "{\"v\":2}\n");
  const Cc = commitAll(up, "redeploy shop");
  git(up, "push", "-q", "origin", "main");
  git(up, "checkout", "-q", "-b", "side", R);
  put(up, "side.txt", "x\n");
  const X = commitAll(up, "side");
  git(up, "push", "-q", "origin", "side");
  return { root, bare, mine, R, A, B, C: Cc, X };
}

test("후손이고 묶음 폴더가 그대로면 받는다 (로컬에 없는 리비전은 origin 에서 받아 본다)", async () => {
  const f = fixture();
  try {
    assert.throws(() => git(f.mine, "cat-file", "-e", `${f.B}^{commit}`), "처음엔 B 를 모른다");
    assert.equal(await descendantUnchanged({ dir: f.mine, env }, f.A, f.B, SHOP), true);
    assert.equal(git(f.mine, "cat-file", "-t", f.B), "commit", "fetch 로 받아 왔다");
    assert.equal(await descendantUnchanged({ dir: f.mine, env }, f.A, f.A, SHOP), true, "같은 커밋");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("거부: 묶음 폴더가 바뀜·후손 아님·거꾸로·모르는 리비전·리비전 모양 아님·작업 복사본 없음", async () => {
  const f = fixture();
  const r = { dir: f.mine, env };
  try {
    assert.equal(await descendantUnchanged(r, f.A, f.C, SHOP), false, "C 가 우리 묶음을 바꿨다");
    assert.equal(await descendantUnchanged(r, f.B, f.C, OTHER), true, "B→C 는 다른 회사 앱 폴더를 안 바꿨다 (경로만 본다)");
    assert.equal(await descendantUnchanged(r, f.A, f.X, SHOP), false, "갈라진 가지 (후손 아님)");
    assert.equal(await descendantUnchanged(r, f.B, f.A, SHOP), false, "조상 쪽 (Argo 가 옛 리비전을 보고)");
    assert.equal(await descendantUnchanged(r, f.A, "0123456789abcdef0123456789abcdef01234567", SHOP), false, "fetch 해도 없는 리비전");
    assert.equal(await descendantUnchanged(r, f.A, "main", SHOP), false, "가지 이름 (Argo 비교 실패 때 보고)");
    assert.equal(await descendantUnchanged(r, f.A, f.B.slice(0, 12), SHOP), false, "짧은 해시");
    assert.equal(await descendantUnchanged(r, f.A, "--upload-pack=x", SHOP), false, "옵션 모양 글자는 git 에 안 넘김");
    assert.equal(await descendantUnchanged({ dir: join(f.root, "nope"), env }, f.A, f.B, SHOP), false, "작업 복사본 없음");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("거부: git 이 실패하면(시간 초과·실행 못 함·오류 코드) 받지 않는다 — 오류에서 받는 일은 없다", async () => {
  const f = fixture();
  try {
    for (const code of [-1, 128, 1]) {
      const calls: string[][] = [];
      const fake: GitCode = async (_d, args) => { calls.push(args); return args[0] === "cat-file" ? 0 : code; };
      assert.equal(await descendantUnchanged({ dir: f.mine, env }, f.A, f.B, SHOP, fake), false, `merge-base 끝 코드 ${code}`);
      assert.deepEqual(calls.map((a) => a[0]), ["cat-file", "cat-file", "merge-base"]);
    }
    const diffFails: GitCode = async (_d, args) => (args[0] === "diff" ? 128 : 0);
    assert.equal(await descendantUnchanged({ dir: f.mine, env }, f.A, f.B, SHOP, diffFails), false, "diff 오류");
    const fetchFails: GitCode = async (_d, args) => (args[0] === "cat-file" ? 1 : args[0] === "fetch" ? -1 : 0);
    assert.equal(await descendantUnchanged({ dir: f.mine, env }, f.A, f.B, SHOP, fetchFails), false, "fetch 실패");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("revisionMatcher: 같은 리비전은 git 없이, 같은 (커밋, 리비전) 은 한 번만 묻는다, 판정기가 없거나 던지면 안 받음", async () => {
  const b = { tenant: T, app: "shop", env: "aws-eks" as const };
  const C1 = "c".repeat(40), D1 = "d".repeat(40), E1 = "e".repeat(40);
  const asked: string[] = [];
  const covers: RevisionCovers = async (_b, commit, rev) => { asked.push(rev); return rev === D1 && commit === C1; };
  const m = revisionMatcher(b, covers);
  assert.equal(await m(C1, C1), true);
  assert.equal(await m(C1, undefined), false);
  assert.equal(await m(C1, "main"), false);
  assert.equal(await m(C1, D1), true);
  assert.equal(await m(C1, D1), true);
  assert.equal(await m(C1, E1), false);
  assert.equal(await m(C1, E1), false);
  assert.deepEqual(asked, [D1, E1], "(커밋, 리비전) 짝마다 한 번");
  assert.equal(await revisionMatcher(b)(C1, D1), false, "판정기 없음 = 정확히 같은 커밋만");
  assert.equal(await revisionMatcher(b, async () => { throw new Error("boom"); })(C1, D1), false);
});

test("GitopsRepo.revisionCovers: 클라우드는 공용 작업 복사본, 온프레+회사 레포면 회사 레포 작업 복사본으로 본다", async () => {
  const f = fixture();
  try {
    const author = { name: "t", email: "t@t.invalid" };
    const base = { branch: "main", push: false, author, maxPushTries: 1 };
    const cloud = { tenant: T, app: "shop", env: "aws-eks" as const };
    const onprem = { tenant: T, app: "shop", env: "onprem-k3s" as const };
    const shared = new GitopsRepo({ ...base, dir: f.mine });
    assert.equal(await shared.revisionCovers(cloud, f.A, f.B), true);
    assert.equal(await shared.revisionCovers(cloud, f.A, f.C), false);
    // 회사 레포 = <tenantRepo.dir>/<회사>. 공용 작업 복사본이 없어도 회사 레포로 본다
    const mirrors = join(f.root, "mirrors");
    execFileSync("git", ["clone", "-q", f.bare, join(mirrors, T)], { stdio: "ignore" });
    const withMirror = new GitopsRepo({ ...base, dir: join(f.root, "no-shared"),
      tenantRepo: { urlTemplate: `file://${f.root}/{tenant}.git`, dir: mirrors, branch: "main", push: false, author, maxPushTries: 1 } });
    assert.equal(await withMirror.revisionCovers(onprem, f.A, f.B), true);
    assert.equal(await withMirror.revisionCovers(onprem, f.A, f.C), false, "회사 레포에서도 묶음 폴더가 바뀌면 안 받음");
    assert.equal(await withMirror.revisionCovers(cloud, f.A, f.B), false, "클라우드는 공용 작업 복사본(없음) → 안 받음");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
