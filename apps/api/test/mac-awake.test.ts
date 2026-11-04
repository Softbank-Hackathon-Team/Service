// MACAWAKE (FM-OPS-04): jeong 줄이 도는 동안만 caffeinate 로 맥 잠자기를 막는다. 진짜 caffeinate·jeong-up 은 띄우지 않는다(가짜 caffeinate 로 인자만 본다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// 가짜 caffeinate: 받은 인자를 적고, -w <pid> 가 끝나면 "gone" 을 적고 끝난다 (진짜와 같은 수명)
function setup() {
  const d = mkdtempSync(join(tmpdir(), "mac-awake-"));
  mkdirSync(join(d, "state"), { recursive: true });
  const log = join(d, "caf.log");
  const caf = join(d, "fake-caffeinate");
  writeFileSync(caf, `#!/bin/sh\necho "args $*" >> "${log}"\nw=""; while [ $# -gt 0 ]; do [ "$1" = -w ] && w=$2; shift; done\nwhile kill -0 "$w" 2>/dev/null; do sleep 0.1; done\necho gone >> "${log}"\n`);
  chmodSync(caf, 0o755);
  writeFileSync(join(d, "jeong-lib.sh"), readFileSync(join(ROOT, "tools/jeong-lib.sh")));
  writeFileSync(join(d, "line.sh"), `cd ${d}; . ./jeong-lib.sh; j_begin up; echo $$ > ${join(d, "pid")}; sleep 0.3; j_end up 0\n`);
  return { d, log, caf };
}
const runLine = (d: string, extra: Record<string, string>) => {
  const env: NodeJS.ProcessEnv = { ...process.env, DEMO_DAY_STATE: join(d, "state") };
  delete env.JEONG_NO_AWAKE; delete env.JEONG_CHILD;
  Object.assign(env, extra);
  return spawnSync("sh", [join(d, "line.sh")], { encoding: "utf8", env });
};
const waitFor = async (f: () => boolean) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); return f(); };

test("MACAWAKE: j_begin 이 caffeinate -i -m -s -w <그 줄 pid> 를 띄우고, 줄이 끝나면 caffeinate 도 끝난다", async () => {
  const { d, log, caf } = setup();
  const r = runLine(d, { JEONG_CAFFEINATE: caf });
  assert.equal(r.status, 0, r.stderr);
  const pid = readFileSync(join(d, "pid"), "utf8").trim();
  assert.ok(await waitFor(() => existsSync(log) && readFileSync(log, "utf8").includes("gone")), "줄이 끝났는데 caffeinate 가 안 끝남");
  assert.match(readFileSync(log, "utf8"), new RegExp(`^args -i -m -s -w ${pid}$`, "m"));
  assert.match(readFileSync(join(d, "state", "jeong-progress.log"), "utf8"), /JEONG up end rc=0/);
});

test("MACAWAKE 거부: caffeinate 가 없는 곳(리눅스)·JEONG_NO_AWAKE=1 이면 안 띄우고 줄은 그대로 돈다", async () => {
  const cases: Record<string, string>[] = [{ JEONG_CAFFEINATE: "/nonexistent/caffeinate" }, { JEONG_NO_AWAKE: "1" }];
  for (const extra of cases) {
    const { d, log, caf } = setup();
    const r = runLine(d, { JEONG_CAFFEINATE: caf, ...extra });
    assert.equal(r.status, 0, r.stderr);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(existsSync(log), false, JSON.stringify(extra));
    assert.match(readFileSync(join(d, "state", "jeong-progress.log"), "utf8"), /JEONG up end rc=0/);
  }
});

// demo-day 를 jeong 줄 없이 바로 쳐도 감싼다 (FM-ORC-14). DEMO_DAY_ROOT_CHECK_ONLY=1 로 단계는 안 돈다, 클라우드 CLI 는 가짜(바로 실패)
const ddRun = (extra: Record<string, string>) => {
  const { d, log, caf } = setup();
  for (const t of ["terraform", "aws", "gcloud", "kubectl"]) { writeFileSync(join(d, t), "#!/bin/sh\nexit 1\n"); chmodSync(join(d, t), 0o755); }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${d}:${process.env.PATH}`, DEMO_DAY_STATE: join(d, "state"), DEMO_DAY_LOG_DIR: join(d, "log"),
    DEMO_DAY_ROOT_CHECK_ONLY: "1", DEMO_DAY_CAFFEINATE: caf };
  delete env.DEMO_DAY_NO_AWAKE; delete env.DEMO_DAY_CHILD; delete env.DEMO_DAY_ACTIVE;
  Object.assign(env, extra);
  const r = spawnSync("bash", ["tools/demo-day.sh", "down", "--fg", ...(extra.DRY_FLAG ? ["--dry-run"] : [])], { cwd: ROOT, encoding: "utf8", env, timeout: 30_000 });
  return { r, log };
};
test("MACAWAKE demo-day: 바로 쳐도 caffeinate -w <demo-day pid>, 끝나면 같이 끝남 / dry-run·DEMO_DAY_NO_AWAKE=1 은 안 띄움", async () => {
  const a = ddRun({});
  assert.equal(a.r.status, 0, a.r.stdout + a.r.stderr);
  assert.ok(await waitFor(() => existsSync(a.log) && readFileSync(a.log, "utf8").includes("gone")));
  assert.match(readFileSync(a.log, "utf8"), /^args -i -m -s -w \d+$/m);
  for (const extra of [{ DEMO_DAY_NO_AWAKE: "1" }, { DRY_FLAG: "1" }] as Record<string, string>[]) {
    const b = ddRun(extra);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(existsSync(b.log), false, JSON.stringify(extra));
  }
});
