// 맥 운영 허점 (RV-14·RV-18·FM-OPS-01·03·FM-ENV-02): 화면·로그 가리기, 창이 멈추거나 닫혀도 회차 계속, kubectl 버전 차이. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactText } from "@svc/contracts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const sh = (cmd: string, env: Record<string, string> = {}) =>
  spawnSync("bash", ["-c", cmd], { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });

test("RV-14: tf:real 은 terraform 로그·오류를 redactText 로만 찍는다", () => {
  const src = readFileSync(join(ROOT, "tools/tf-real.ts"), "utf8");
  const raw = src.split("\n").filter((l) => /console\.(log|error)\(\s*(l|\(e as Error\)\.message)\s*\)/.test(l));
  assert.deepEqual(raw, [], "가리지 않고 찍는 줄");
  assert.equal((src.match(/redactText\(/g) ?? []).length >= 3, true);
  assert.doesNotMatch(redactText("Error: arn:aws:iam::123456789012:role/x AKIAABCDEFGHIJKLMNOP 10.1.2.3"), /123456789012|AKIAABCDEFGHIJKLMNOP|10\.1\.2\.3/);
});

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "share-"));
  const src = join(d, "src"); mkdirSync(join(src, "auto-down"), { recursive: true });
  writeFileSync(join(src, "u_aws.log"), "arn:aws:rds:ap-northeast-2:123456789012:db:x\nkey AKIAABCDEFGHIJKLMNOP\nok line sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n");
  writeFileSync(join(src, "auto-down", "gke.log"), "user dev@example.com token=abcd1234secret\n");
  return { d, src };
}

test("RV-18 share-logs: 하위 폴더까지 가린 사본, 원본 그대로, 해시는 남김", () => {
  const { d, src } = fixture();
  const before = readFileSync(join(src, "u_aws.log"), "utf8");
  const r = sh(`sh tools/real/share-logs.sh "${src}" "${join(d, "out")}"`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /가린 사본 2개/);
  const a = readFileSync(join(d, "out", "u_aws.log"), "utf8"), b = readFileSync(join(d, "out", "auto-down", "gke.log"), "utf8");
  assert.doesNotMatch(a + b, /123456789012|AKIAABCDEFGHIJKLMNOP|dev@example\.com|abcd1234secret/);
  assert.match(a, /9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08/);
  assert.equal(readFileSync(join(src, "u_aws.log"), "utf8"), before);
});

test("RV-18 share-logs 거부: 원본 안의 새 폴더·비어 있지 않은 새 폴더·인자 틀림 = 2, 아무것도 안 씀", () => {
  const { d, src } = fixture();
  let r = sh(`sh tools/real/share-logs.sh "${src}" "${join(src, "masked")}"`);
  assert.equal(r.status, 2); assert.match(r.stderr, /원본 폴더 안/); assert.equal(existsSync(join(src, "masked")), false);
  mkdirSync(join(d, "busy")); writeFileSync(join(d, "busy", "x"), "1");
  r = sh(`sh tools/real/share-logs.sh "${src}" "${join(d, "busy")}"`);
  assert.equal(r.status, 2); assert.deepEqual(readdirSync(join(d, "busy")), ["x"]);
  assert.equal(sh(`sh tools/real/share-logs.sh "${src}"`).status, 2);
});

test("RV-18 demo-day: 로그 폴더는 주인만(700), 원문이라는 안내 파일", () => {
  const h = mkdtempSync(join(tmpdir(), "ddlog-")); const L = join(h, "log");
  const r = spawnSync("bash", ["tools/demo-day.sh", "down", "--dry-run", "--fg"], { cwd: ROOT, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, HOME: h, DEMO_DAY_STATE: join(h, "s"), DEMO_DAY_LOG_DIR: L } });
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-600));
  assert.equal(statSync(L).mode & 0o777, 0o700);
  assert.match(readFileSync(join(L, "README.txt"), "utf8"), /share-logs\.sh/);
});

test("FM-OPS-01·03 real-session REAL_BG=1: 바로 돌아오고, 뒤 회차는 창과 떨어져 같은 결과 이름으로 돈다", () => {
  const h = mkdtempSync(join(tmpdir(), "rbg-")); const res = join(h, "res");
  const t0 = Date.now();
  // 시작 단계 이름을 틀리게 줘서 뒤 회차가 곧바로 끝나게 한다 (클라우드·DB 안 건드림)
  const r = spawnSync("bash", ["tools/real/real-session.sh", ROOT, "no-such-step"], { cwd: ROOT, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: h, RESULTS_DIR: res, REAL_BG: "1", REAL_TS: "20991231T000000Z", REAL_NO_AWAKE: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 10_000);
  assert.match(r.stdout, /뒤에서 시작: pid \d+ .*real-20991231T000000Z\.out .*real-20991231T000000Z\.md/);
  const out = join(res, "real-20991231T000000Z.out");
  for (let i = 0; i < 100 && !(existsSync(out) && /모르는 시작 단계/.test(readFileSync(out, "utf8"))); i++) spawnSync("sleep", ["0.1"]);
  assert.match(readFileSync(out, "utf8"), /모르는 시작 단계: no-such-step/);
  const src = readFileSync(join(ROOT, "tools/real/real-session.sh"), "utf8");
  assert.match(src, /export CLOUDSDK_CORE_DISABLE_PROMPTS=1 AWS_PAGER="" PAGER=cat/);
  assert.match(src, /nohup bash "\$0" "\$@" < \/dev\/null/);
});

test("FM-ENV-02 kubectl 버전: EKS 기준 ±1 안 OK, 더 낮으면 WARN, 못 읽으면 WARN", () => {
  const run = (v: string) => sh(`. tools/env-checks.sh; ok(){ echo "OK $*"; }; warn(){ echo "WARN $*"; }; fail(){ echo "FAIL $*"; }
kubectl(){ ${v ? `echo '{"clientVersion": {"gitVersion": "v${v}"}}'` : "return 1"}; }; ec_kubectl infra/modules/aws/env/main.tf`).stdout;
  const want = readFileSync(join(ROOT, "infra/modules/aws/env/main.tf"), "utf8").match(/variable "k8s_version"[\s\S]*?default\s*=\s*"1\.(\d+)"/)![1];
  assert.match(run(`1.${want}.0`), /^OK kubectl-version/m);
  assert.match(run(`1.${Number(want) - 1}.3`), /^OK kubectl-version/m);
  assert.match(run(`1.${Number(want) - 3}.0`), /^WARN kubectl-version .*1 넘게/m);
  assert.match(run(""), /^WARN kubectl-version kubectl 버전을 못 읽음/m);
});

// FM-OPS-02 감시 창 단독: 켜기 전 신호는 치우기만, 켠 뒤 auto-fail·up 실패 줄이면 down 한 번, rc=3 은 건너뜀, TERM 이면 끝 줄
const until = async (f: () => boolean, ms = 20_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 100)); } return true; };

test("FM-OPS-02 jeong-watch: 지난 신호 무시, 새 실패 신호마다 down 한 번, rc=3 건너뜀, TERM 으로 깨끗이 끝남", async () => {
  const h = mkdtempSync(join(tmpdir(), "jw-")); const st = join(h, "state"); mkdirSync(st, { recursive: true });
  const prog = join(st, "jeong-progress.log"), calls = join(h, "calls");
  writeFileSync(join(st, "auto-fail"), "old real-session run rc=1\n");   // 켜기 전 = 지난 회차
  const fake = join(h, "down.sh");
  writeFileSync(fake, `echo x >> "${calls}"; echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) JEONG down end rc=0" >> "${prog}"\n`);
  const w = spawn("sh", ["tools/jeong-watch.sh"], { cwd: ROOT, env: { ...process.env, HOME: h, DEMO_DAY_STATE: st, JEONG_ALLOW_NOTTY: "1", JEONG_NO_AWAKE: "1",
    JEONG_WATCH_POLL_SEC: "1", JEONG_WATCH_GRACE_SEC: "1", JEONG_WATCH_RETRY_SEC: "1", JEONG_DOWN_CMD: `sh ${fake}` } });
  let out = ""; w.stdout.on("data", (b) => (out += b)); w.stderr.on("data", (b) => (out += b));
  const n = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);
  try {
    assert.ok(await until(() => /감시 시작/.test(out)), out);
    assert.ok(readdirSync(st).some((f) => f.startsWith("auto-fail.stale-")));
    await new Promise((r) => setTimeout(r, 2500)); assert.equal(n(), 0, "지난 신호로 down 을 침");
    writeFileSync(join(st, "auto-fail"), "2026-11-04T00:00:00Z real-session run rc=1\n");
    assert.ok(await until(() => n() === 1), out);
    writeFileSync(prog, readFileSync(prog, "utf8") + "2026-11-04T00:00:01Z JEONG up end rc=3\n");
    await new Promise((r) => setTimeout(r, 3000)); assert.equal(n(), 1, "rc=3 에 down 을 침");
    writeFileSync(prog, readFileSync(prog, "utf8") + "2026-11-04T00:00:02Z JEONG up end rc=1 log=/nope\n");
    assert.ok(await until(() => n() === 2), out);
  } finally { w.kill("SIGTERM"); }
  await until(() => w.exitCode !== null);
  assert.match(readFileSync(prog, "utf8"), /JEONG watch end/);
  assert.equal(existsSync(join(st, "watch.lock")), false);
});

test("FM-OPS-04 real-session: caffeinate -i -m -s -w <회차 pid> 로 회차 전체를 감싼다 (REAL_NO_AWAKE=1 이면 안 띄움)", () => {
  const h = mkdtempSync(join(tmpdir(), "rcaf-")); const bin = join(h, "bin"); mkdirSync(bin); const rec = join(h, "caf");
  writeFileSync(join(bin, "caffeinate"), `#!/bin/sh\necho "$*" >> "${rec}"\n`, { mode: 0o755 });
  const go = (extra: Record<string, string>) => spawnSync("bash", ["tools/real/real-session.sh", ROOT, "no-such-step"], { cwd: ROOT, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: h, RESULTS_DIR: join(h, "res"), PATH: `${bin}:${process.env.PATH}`, ...extra } });
  go({}); spawnSync("sleep", ["0.5"]);
  assert.match(readFileSync(rec, "utf8"), /^-i -m -s -w \d+$/m);
  writeFileSync(rec, ""); go({ REAL_NO_AWAKE: "1" }); spawnSync("sleep", ["0.5"]);
  assert.equal(readFileSync(rec, "utf8"), "");
});
