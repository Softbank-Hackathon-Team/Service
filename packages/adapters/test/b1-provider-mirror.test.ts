// #373 B1: worker 이미지에 구운 provider 미러를 쓰기 위한 실행기 쪽 준비 (terraform 은 가짜 exec, 진짜로는 안 부른다)
//   1) 루트 잠금 파일(.terraform.lock.hcl)을 작업 폴더로 복사 (이미 있으면 안 덮음)
//   2) init 전에 끊긴 provider 링크 정리 (미러에서 빠진 판)
//   3) 커밋한 잠금 파일이 모듈 provider 제약과 맞는지 (안 맞으면 이전마다 init 이 실패한다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvLayerRunner, createRealTerraformRunner, DEFAULT_MODULE_ROOT, ENV_LAYER_MODULE, envLayerDirOf, envLayerVars, LOCK_FILE,
  pruneStaleProviderLinks, REAL_MODULE_BASE, ROOT_DIR, type Exec } from "../src/index.js";

const MID = "4a8c0000-0000-4000-8000-0000000000b1";
const TEN = "t-0b1b1b1b";
const tmp = () => mkdtempSync(join(tmpdir(), "b1-"));
const OUTPUTS = JSON.stringify({ db_address: { value: "h", sensitive: false } });
function fakeExec(onInit?: (cwd: string) => void) {
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, args, o) => {
    calls.push(args);
    if (args.includes("init")) onInit?.(o.cwd);
    return { code: 0, stdout: args.includes("output") ? OUTPUTS : "ok", stderr: "", ms: 1 };
  };
  return { exec, calls };
}
const repoLock = (m: string) => readFileSync(join(DEFAULT_MODULE_ROOT, m, LOCK_FILE), "utf8");

test("apply: 루트 잠금 파일을 root/ 로 복사한다 (kinds 에는 없음). 다시 apply 해도 작업 폴더 잠금 파일은 안 덮는다", async () => {
  const work = tmp(); const { exec } = fakeExec();
  const r = createRealTerraformRunner({ exec, workRoot: work, env: {} });
  const res = await r.apply("aws", MID, {}, undefined, TEN);
  assert.equal(res.ok, true, res.log.join("\n"));
  const lock = join(res.workDir, ROOT_DIR, LOCK_FILE);
  assert.equal(readFileSync(lock, "utf8"), repoLock("aws/root"));
  for (const k of readdirSync(join(res.workDir, "kinds"))) assert.equal(existsSync(join(res.workDir, "kinds", k, LOCK_FILE)), false);
  // 진행 중인 이전: 처음 init 이 고른 판(작업 폴더 잠금 파일)을 그대로 둔다
  writeFileSync(lock, "# 앞 init 이 고른 판\n");
  await r.apply("aws", MID, {}, undefined, TEN);
  assert.equal(readFileSync(lock, "utf8"), "# 앞 init 이 고른 판\n");
});

test("init 전에 끊긴 provider 링크만 지운다 (이어진 링크·실제 폴더는 그대로). apply·destroy 둘 다", async () => {
  const mirror = join(tmp(), "registry.terraform.io/hashicorp/time/0.14.2/linux_amd64");
  mkdirSync(mirror, { recursive: true });
  let p = "";   // <작업 폴더>/root/.terraform/providers/registry.terraform.io/hashicorp
  const there = (rel: string) => { try { lstatSync(join(p, rel)); return true; } catch { return false; } };
  const seen: boolean[][] = [];   // init 을 부르는 순간의 [이어진 링크, 끊긴 링크, 실제 폴더]
  const { exec } = fakeExec(() => { if (p) seen.push([there("time/0.14.2/linux_amd64"), there("kubernetes/2.37.0/linux_amd64"), there("random/3.9.1/linux_amd64")]); });
  const r = createRealTerraformRunner({ exec, workRoot: tmp(), env: {} });
  const first = await r.apply("onprem", MID, {}, undefined, TEN);
  p = join(first.workDir, ROOT_DIR, ".terraform/providers/registry.terraform.io/hashicorp");
  for (const d of ["time/0.14.2", "kubernetes/2.37.0", "random/3.9.1/linux_amd64"]) mkdirSync(join(p, d), { recursive: true });
  symlinkSync(mirror, join(p, "time/0.14.2/linux_amd64"));
  const dangle = () => symlinkSync("/nonexistent/old-mirror", join(p, "kubernetes/2.37.0/linux_amd64"));   // 미러에서 빠진 판
  dangle();
  const again = await r.apply("onprem", MID, {}, undefined, TEN);
  assert.deepEqual(seen, [[true, false, true]]);
  assert.ok(again.log.some((l) => l.includes("끊긴 provider 링크 1개")), again.log.join("\n"));
  dangle();
  assert.equal((await r.destroy(MID)).ok, true);
  assert.deepEqual(seen, [[true, false, true], [true, false, true]]);
});

test("pruneStaleProviderLinks: .terraform 이 없으면 0 (처음 init)", () => {
  assert.equal(pruneStaleProviderLinks(tmp()), 0);
});

test("환경 층: gcp/env 잠금 파일을 modules/gcp/env/ 로 복사한다", async () => {
  const work = tmp(); const { exec } = fakeExec();
  const OUT = JSON.stringify({ network_id: { value: "n" }, cluster_name: { value: "c" }, cluster_location: { value: "l" } });
  const exec2: Exec = async (cmd, args, o) => (args.includes("output") ? { code: 0, stdout: OUT, stderr: "", ms: 1 } : exec(cmd, args, o));
  const r = await createEnvLayerRunner({ exec: exec2, workRoot: work, env: () => ({}) }).apply(TEN, "33333333-3333-4333-8333-3333333333b1", envLayerVars({ projectId: "p", region: "asia-northeast3" }));
  assert.equal(r.ok, true, r.log.join("\n"));
  const dir = envLayerDirOf(work, TEN, "33333333-3333-4333-8333-3333333333b1");
  assert.equal(readFileSync(join(dir, "modules", ENV_LAYER_MODULE, LOCK_FILE), "utf8"), repoLock(ENV_LAYER_MODULE));
});

// 실행기가 돌리는 루트 모듈 = REAL_MODULE_BASE 의 <환경>/root (+ 같은 환경 kinds 전부) + 환경 층 gcp/env
const ROOTS: { lock: string; dirs: string[] }[] = [
  ...Object.values(REAL_MODULE_BASE).map((b) => ({ lock: `${b}/${ROOT_DIR}`,
    dirs: [`${b}/${ROOT_DIR}`, ...(existsSync(join(DEFAULT_MODULE_ROOT, b, "kinds")) ? readdirSync(join(DEFAULT_MODULE_ROOT, b, "kinds")).map((k) => `${b}/kinds/${k}`) : [])] })),
  { lock: ENV_LAYER_MODULE, dirs: [ENV_LAYER_MODULE] },
];
/** 잠금 파일 → { "hashicorp/aws": { constraints, h1 개수 } } */
function parseLock(text: string) {
  const out: Record<string, { constraints: string; h1: number }> = {};
  for (const b of text.split(/^provider /m).slice(1)) {
    const src = /^"registry\.terraform\.io\/([^"]+)"/.exec(b)?.[1];
    if (src) out[src] = { constraints: /constraints\s*=\s*"([^"]*)"/.exec(b)?.[1] ?? "", h1: (b.match(/"h1:/g) ?? []).length };
  }
  return out;
}

test("커밋한 잠금 파일: 루트 모듈(+kinds)이 적은 provider 전부, 같은 제약, 해시는 linux_amd64·linux_arm64·darwin_arm64 몫", () => {
  for (const r of ROOTS) {
    const lock = parseLock(repoLock(r.lock));
    for (const d of r.dirs) for (const f of readdirSync(join(DEFAULT_MODULE_ROOT, d)).filter((x) => x.endsWith(".tf"))) {
      const tf = readFileSync(join(DEFAULT_MODULE_ROOT, d, f), "utf8");
      for (const m of tf.matchAll(/source\s*=\s*"(hashicorp\/[a-z0-9-]+)"\s*,\s*version\s*=\s*"([^"]+)"/g)) {
        const [, src, ver] = m as unknown as [string, string, string];
        const l = lock[src];
        const fix = `infra/modules/${r.lock}: terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64 (실행기 모양으로 펼친 폴더에서)`;
        assert.ok(l, `${d}/${f}: ${src} 가 잠금 파일에 없다 → ${fix}`);
        assert.ok(l.constraints.split(/\s*,\s*/).includes(ver), `${d}/${f}: ${src} 제약 "${ver}" 가 잠금 파일 제약 "${l.constraints}" 에 없다 → ${fix}`);
        assert.ok(l.h1 >= 3, `${r.lock}: ${src} h1 해시가 ${l.h1}개 (플랫폼 3개 몫이 있어야 이미지 미러 검사가 통과) → ${fix}`);
      }
    }
  }
});
