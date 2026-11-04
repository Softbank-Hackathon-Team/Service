// FM-ORC-22: tools/proc-leftovers.sh — npm 만 꺼지고 남은 node 워커(고아)를 찾고 트리째 끈다. pkill -f 안 씀.
//   가짜 "node"(sleep 하는 셸)를 임시 apps/worker·apps/api 폴더에서 띄워 진짜 ps·cwd 로 본다. 포트 쪽은 PL_LSOF 로 바꾼다
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const d = mkdtempSync(join(tmpdir(), "orc22-"));
const bin = join(d, "bin"); mkdirSync(bin);
writeFileSync(join(bin, "node"), "#!/bin/sh\nexec sleep 300\n"); chmodSync(join(bin, "node"), 0o755);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function fake(sub: string): ChildProcess {
  const cwd = join(d, "repo", sub); mkdirSync(cwd, { recursive: true });
  // exec -a 로 명령줄 이름을 ".../node … src/main.ts" 로 (진짜 tsx 워커 모양). 부모 npm 이 이미 죽은 고아와 같은 상태
  return spawn("bash", ["-c", `exec -a "${join(bin, "node")} --env-file=../../.env src/main.ts" sleep 300`], { cwd, stdio: "ignore", detached: true });
}
const sh = (body: string, env: Record<string, string> = {}) =>
  spawnSync("bash", ["-c", `. tools/proc-leftovers.sh; ${body}`], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("ORC-22 apps/worker 에서 도는 node 를 찾고(apps/api 는 아님) 트리째 끈다", async () => {
  const w = fake("apps/worker"); const a = fake("apps/api");
  await pause(300);
  try {
    const found = sh("pl_workers").stdout.trim().split("\n");
    assert.ok(found.includes(String(w.pid)), `워커를 못 찾음: ${found}`);
    assert.ok(!found.includes(String(a.pid)), "API 를 워커로 잘못 봄");
    sh(`pl_kill ${w.pid}`);
    await pause(200);
    assert.equal(alive(w.pid!), false, "워커가 아직 삶");
    assert.equal(alive(a.pid!), true, "API 까지 꺼짐");
  } finally { try { process.kill(a.pid!, "SIGKILL"); } catch {} try { process.kill(w.pid!, "SIGKILL"); } catch {} }
});

test("ORC-22 지표 포트 9465 를 쥔 node 는 폴더가 달라도 남은 워커, node 가 아닌 프로세스는 아님", async () => {
  const o = fake("other"); await pause(300);
  try {
    const lsof = join(d, "lsof.sh");
    writeFileSync(lsof, `#!/bin/sh\n[ "$1" = 9465 ] && echo ${o.pid}\n[ "$1" = 9466 ] && echo ${process.pid}000\nexit 0\n`); chmodSync(lsof, 0o755);
    const found = sh("pl_workers", { PL_LSOF: lsof }).stdout.trim().split("\n");
    assert.ok(found.includes(String(o.pid)));
    assert.equal(found.length, found.filter((x) => x !== `${process.pid}000`).length);
  } finally { try { process.kill(o.pid!, "SIGKILL"); } catch {} }
});

test("ORC-22 up-preflight 줄: 남으면 FAIL stale:worker-procs, 없으면 OK", () => {
  const ps0 = join(d, "ps0.sh"); writeFileSync(ps0, "#!/bin/sh\necho '1 /sbin/launchd'\n"); chmodSync(ps0, 0o755);
  const none = join(d, "none.sh"); writeFileSync(none, "#!/bin/sh\nexit 0\n"); chmodSync(none, 0o755);
  const pre = spawnSync("bash", ["-c", "sed -n '/^# FM-ORC-22/,/^else ok stale:worker-procs/p' tools/up-preflight.sh"], { cwd: ROOT, encoding: "utf8" }).stdout;
  assert.match(pre, /fail stale:worker-procs/);
  const body = `ok() { echo "OK $1"; }; fail() { echo "FAIL $1 $2"; }; ${pre} fi`;
  assert.match(sh(body, { PL_PS: ps0, PL_LSOF: none }).stdout, /^OK stale:worker-procs/m);
  const ps1 = join(d, "ps1.sh"); writeFileSync(ps1, "#!/bin/sh\necho '4242 node /x/tsx/dist/cli.mjs src/main.ts'\n"); chmodSync(ps1, 0o755);
  const cwd = join(d, "cwd.sh"); writeFileSync(cwd, "#!/bin/sh\necho /Users/j/Service/apps/worker\n"); chmodSync(cwd, 0o755);
  assert.match(sh(body, { PL_PS: ps1, PL_LSOF: none, PL_CWD: cwd }).stdout, /^FAIL stale:worker-procs 남은 워커 pid 4242/m);
});
