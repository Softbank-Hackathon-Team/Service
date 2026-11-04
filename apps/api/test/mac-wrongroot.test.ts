// WRONGROOT (FM-OPS-05 맥): up 을 친 레포 폴더와 다른 폴더에서 down 을 치면 시작 전에 멈춘다(끝 코드 2).
// DEMO_DAY_ROOT_CHECK_ONLY=1 로 대조만 돌린다 — up·down 단계는 하나도 안 돈다. 혹시 몰라 terraform·aws·gcloud·kubectl 도 가짜(바로 실패)로 가린다
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ROOTP = realpathSync(ROOT).replace(/\/$/, "");

function run(cmd: "up" | "down", upRoot: string | null, extra: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), "wrongroot-"));
  const state = join(d, "state"); mkdirSync(state);
  const bin = join(d, "bin"); mkdirSync(bin);
  for (const t of ["terraform", "aws", "gcloud", "kubectl"]) { writeFileSync(join(bin, t), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, t), 0o755); }
  if (upRoot !== null) writeFileSync(join(state, "up-root"), `${upRoot}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEMO_DAY_STATE: state, DEMO_DAY_LOG_DIR: join(d, "log"), DEMO_DAY_ROOT_CHECK_ONLY: "1" };
  delete env.DEMO_DAY_ANY_ROOT; delete env.DEMO_DAY_CHILD;
  Object.assign(env, extra);
  const r = spawnSync("bash", ["tools/demo-day.sh", cmd, "--fg"], { cwd: ROOT, encoding: "utf8", env, timeout: 30_000 });
  const prog = existsSync(join(d, "log", "progress.log")) ? readFileSync(join(d, "log", "progress.log"), "utf8") : "";
  return { status: r.status, prog, state, d };
}
const otherRepo = () => { const o = mkdtempSync(join(tmpdir(), "other-repo-")); mkdirSync(join(o, "infra")); return realpathSync(o); };

test("WRONGROOT 거부: up 은 다른 레포 폴더(infra 있음)에서 했으면 down 은 시작 전에 멈춤(2), 그 폴더를 알려 줌", () => {
  const o = otherRepo();
  const r = run("down", o);
  assert.equal(r.status, 2, r.prog);
  assert.match(r.prog, new RegExp(`멈춤: 이 down 은 .* up 은 ${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 에서 했다`));
  assert.match(r.prog, /sh .*\/tools\/jeong-down\.sh/);
});

test("WRONGROOT 정상: 같은 폴더·표 없음·그 폴더가 지워짐·DEMO_DAY_ANY_ROOT=1 이면 막지 않음, up 은 실제 경로를 남김", () => {
  assert.equal(run("down", ROOTP).status, 0);
  assert.equal(run("down", null).status, 0);
  assert.equal(run("down", "/nonexistent/old-repo").status, 0);
  assert.equal(run("down", otherRepo(), { DEMO_DAY_ANY_ROOT: "1" }).status, 0);
  const u = run("up", null);
  assert.equal(u.status, 0, u.prog);
  assert.equal(readFileSync(join(u.state, "up-root"), "utf8").trim(), ROOTP);
});
