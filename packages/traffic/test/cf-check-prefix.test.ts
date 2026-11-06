// CF_CHECK_PREFIX: 둘째 터널·pool 짝을 첫 짝(cf-check-src·tgt·monitor, LB cf-check.<zone>)을 안 건드리고 만들고 지운다. 비우면 예전 이름 그대로.
// 가짜 Cloudflare(scripts/cf-fake-server.mjs) 에 cf-check 를 실제 프로세스로 돌린다. 토큰·클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { cfCheckPrefix, CF_CHECK_DEFAULT_PREFIX } from "../../../scripts/cf-probe.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const ACC = "fedcba9876543210fedcba9876543210";
const ZONE = "0123456789abcdef0123456789abcdef";

async function fake(): Promise<{ port: number; stop: () => void; get: (p: string) => Promise<any[]> }> {
  const ch: ChildProcess = spawn(process.execPath, ["scripts/cf-fake-server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((res, rej) => { ch.stdout!.on("data", (d) => { const m = /fake cf up (\d+)/.exec(String(d)); if (m) res(Number(m[1])); }); ch.on("exit", () => rej(new Error("fake 종료"))); });
  const base = `http://127.0.0.1:${port}/client/v4`;
  return { port, stop: () => ch.kill("SIGKILL"),
    get: async (p) => ((await (await fetch(base + p, { headers: { authorization: "Bearer fake-token" } })).json()) as { result: any[] }).result };
}
// .env 를 안 읽게 직접 node 로. 실제 값이 섞이지 않게 CF 관련 변수는 비운다
function cfCheck(port: number, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/cf-check.ts", ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", CLOUDFLARE_API_TOKEN: "fake-token", CLOUDFLARE_ZONE_NAME: "example.test",
      CF_CHECK_API_BASE: `http://127.0.0.1:${port}/client/v4`, ...env },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, stdout: r.stdout };
}
const ORIG = (s: string, t: string) => ({ CF_CHECK_SOURCE_ORIGIN: s, CF_CHECK_TARGET_ORIGIN: t });
const KEEP = ["--apply", "--keep", "--hold-sec=0", "--repeat=1"];
const P2 = { CF_CHECK_PREFIX: "cf-check2", CF_CHECK_ORIGIN_LIMIT: "4" };
const poolsOf = async (f: Awaited<ReturnType<typeof fake>>) =>
  Object.fromEntries((await f.get(`/accounts/${ACC}/load_balancers/pools`)).map((p) => [p.name, p.origins.map((o: any) => o.address).join(",")]));
const lbNames = async (f: Awaited<ReturnType<typeof fake>>) => (await f.get(`/zones/${ZONE}/load_balancers`)).map((l) => l.name).sort();

test("cfCheckPrefix: 비우면 예전 cf-check, cf-check 뒤 소문자·숫자만 받는다", () => {
  assert.equal(CF_CHECK_DEFAULT_PREFIX, "cf-check");
  for (const v of [undefined, "", "  ", "cf-check"]) assert.deepEqual(cfCheckPrefix({ CF_CHECK_PREFIX: v }), { prefix: "cf-check" }, String(v));
  assert.deepEqual(cfCheckPrefix({}), { prefix: "cf-check" });
  assert.deepEqual(cfCheckPrefix({ CF_CHECK_PREFIX: "cf-check2" }), { prefix: "cf-check2" });
  assert.deepEqual(cfCheckPrefix({ CF_CHECK_PREFIX: " cf-checkdemo " }), { prefix: "cf-checkdemo" });
  // 거부: cf-check 로 안 시작(남의 자원), "-" 로 이음(기본 정리가 자기 것으로 셈), 대문자·밑줄(호스트 이름), 너무 김
  for (const v of ["prod", "app-src", "cf-check-b", "cf-check-", "cf-checkB", "cf-check_b", "cf-check12345678901234567"])
    assert.ok("error" in cfCheckPrefix({ CF_CHECK_PREFIX: v }), v);
});

test("기본(CF_CHECK_PREFIX 없음·빈 값·cf-check) dry-run 출력은 서로 같고 앞머리 줄이 없다", async () => {
  const f = await fake();
  try {
    const a = cfCheck(f.port, ["--hold-sec=0"], ORIG("s.example", "t.example"));
    assert.equal(a.code, 0, a.out);
    assert.doesNotMatch(a.out, /앞머리/);
    assert.match(a.out, /"name":"cf-check-src"/);
    for (const v of ["", "cf-check"]) assert.equal(cfCheck(f.port, ["--hold-sec=0"], { ...ORIG("s.example", "t.example"), CF_CHECK_PREFIX: v }).stdout, a.stdout, v);
  } finally { f.stop(); }
});

test("둘째 짝: CF_CHECK_PREFIX=cf-check2 는 첫 짝을 안 바꾸고 따로 만들고, --list·정리도 자기 짝만", async () => {
  const f = await fake();
  try {
    assert.equal(cfCheck(f.port, KEEP, ORIG("a-src.example", "a-tgt.example")).code, 0);
    const b = cfCheck(f.port, KEEP, { ...ORIG("b-src.example", "b-tgt.example"), ...P2 });
    assert.equal(b.code, 0, b.out);
    assert.match(b.out, /자원 이름 앞머리: cf-check2/);
    assert.equal((b.out.match(/만듦/g) ?? []).length, 4, b.out);   // 모니터·pool 2·LB 를 새로 (첫 짝을 다시 쓰지 않음)
    assert.doesNotMatch(b.out, /오리진 바꿈/);                      // 첫 짝 pool 을 PATCH 하지 않음
    assert.deepEqual(await poolsOf(f), { "cf-check-src": "a-src.example", "cf-check-tgt": "a-tgt.example",
      "cf-check2-src": "b-src.example", "cf-check2-tgt": "b-tgt.example" });
    assert.deepEqual(await lbNames(f), ["cf-check.example.test", "cf-check2.example.test"]);
    assert.deepEqual(cfCheck(f.port, ["--list"], P2).stdout.trim().split("\n").sort(), ["lb cf-check2.example.test", "monitor cf-check2-monitor", "pool cf-check2-src", "pool cf-check2-tgt"]);
    assert.deepEqual(cfCheck(f.port, ["--list"]).stdout.trim().split("\n").sort(), ["lb cf-check.example.test", "monitor cf-check-monitor", "pool cf-check-src", "pool cf-check-tgt"]);
    // 둘째 짝만 정리 → 첫 짝은 그대로
    const c = cfCheck(f.port, ["--cleanup", "--apply"], P2);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /정리 확인: cf-check2 모니터·pool·LB 0/);
    assert.deepEqual(await poolsOf(f), { "cf-check-src": "a-src.example", "cf-check-tgt": "a-tgt.example" });
    assert.deepEqual(await lbNames(f), ["cf-check.example.test"]);
    assert.equal((await f.get(`/accounts/${ACC}/load_balancers/monitors`)).length, 1);
    // 기본 정리는 예전 그대로 첫 짝만 지우고 0 확인
    const d = cfCheck(f.port, ["--cleanup", "--apply"]);
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /정리 확인: cf-check 모니터·pool·LB 0/);
  } finally { f.stop(); }
});

test("둘째 짝 거부: 잘못된 앞머리는 API 를 부르기 전에 rc 1, 오리진 한도(기본 2)면 첫 짝을 남의 pool 로 세어 아무것도 안 만든다", async () => {
  const f = await fake();
  try {
    for (const v of ["cf-check-b", "prod"]) {
      const r = cfCheck(f.port, KEEP, { ...ORIG("s.example", "t.example"), CF_CHECK_PREFIX: v });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /CF_CHECK_PREFIX=.* 는 쓸 수 없다/);
      assert.equal(cfCheck(f.port, ["--list"], { CF_CHECK_PREFIX: v }).code, 1);
    }
    assert.equal((await f.get(`/accounts/${ACC}/load_balancers/monitors`)).length, 0, "아무것도 안 만듦");
    assert.equal(cfCheck(f.port, KEEP, ORIG("a-src.example", "a-tgt.example")).code, 0);
    const over = cfCheck(f.port, KEEP, { ...ORIG("b-src.example", "b-tgt.example"), CF_CHECK_PREFIX: "cf-check2" });
    assert.equal(over.code, 1, over.out);
    assert.match(over.out, /오리진 한도 2 를 넘는다: 다른 pool cf-check-src\(1\), cf-check-tgt\(1\)/);
    assert.deepEqual(Object.keys(await poolsOf(f)).sort(), ["cf-check-src", "cf-check-tgt"]);
    assert.equal((await f.get(`/accounts/${ACC}/load_balancers/monitors`)).length, 1);
  } finally { f.stop(); }
});
