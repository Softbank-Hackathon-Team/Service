// pf-d (실검증 사전 점검 1회차, FM-TRF-02·07·08·09·10·11): Cloudflare LB 를 "처음 만드는 길" 부터 정리·집계까지
// 가짜 Cloudflare(scripts/cf-fake-server.mjs) 에 cf-check·cloud-zero 를 실제 프로세스로 돌린다. 토큰·클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { runShift, stubMetrics, type TrafficSwitcher, type Weights } from "@svc/traffic";

const ROOT = resolve(import.meta.dirname, "../../..");
const ACC = "fedcba9876543210fedcba9876543210";

async function fake(env: Record<string, string> = {}): Promise<{ port: number; stop: () => void; get: (p: string) => Promise<any[]>; post: (p: string, b: unknown) => Promise<void> }> {
  // PORT=0: 임의 번호를 고르면 다른 프로세스가 쓰는 포트와 부딪힌다 (EADDRINUSE)
  const ch: ChildProcess = spawn(process.execPath, ["scripts/cf-fake-server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: "0", ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((res, rej) => { ch.stdout!.on("data", (d) => { const m = /fake cf up (\d+)/.exec(String(d)); if (m) res(Number(m[1])); }); ch.on("exit", () => rej(new Error("fake 종료"))); });
  const base = `http://127.0.0.1:${port}/client/v4`;
  const h = { authorization: "Bearer fake-token", "content-type": "application/json" };
  return {
    port, stop: () => ch.kill("SIGKILL"),
    get: async (p) => ((await (await fetch(base + p, { headers: h })).json()) as { result: any[] }).result,
    post: async (p, b) => { await fetch(base + p, { method: "POST", headers: h, body: JSON.stringify(b) }); },
  };
}
// .env 를 안 읽게 직접 node 로 (npm run cf:check 는 --env-file=.env). 실제 값이 섞이지 않게 CF 관련 변수는 비운다
function cfCheck(port: number, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/cf-check.ts", ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", CLOUDFLARE_API_TOKEN: "fake-token", CLOUDFLARE_ZONE_NAME: "example.test",
      CF_CHECK_API_BASE: `http://127.0.0.1:${port}/client/v4`, ...env },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const ORIG = (s: string, t: string) => ({ CF_CHECK_SOURCE_ORIGIN: s, CF_CHECK_TARGET_ORIGIN: t });
const KEEP = ["--apply", "--keep", "--hold-sec=0", "--repeat=1"];
const poolsOf = async (f: Awaited<ReturnType<typeof fake>>) =>
  Object.fromEntries((await f.get(`/accounts/${ACC}/load_balancers/pools`)).map((p) => [p.name, p.origins.map((o: any) => o.address).join(",")]));

test("FM-TRF-01·07·11: 빈 계정에서 모니터→pool 2→LB 를 만들고, 다시 돌리면 이름으로 재사용하되 바뀐 오리진은 PATCH", async () => {
  const f = await fake();
  try {
    const a = cfCheck(f.port, KEEP, ORIG("old-src.example", "old-tgt.example"));
    assert.equal(a.code, 0, a.out);
    assert.equal((a.out.match(/만듦/g) ?? []).length, 4, a.out);
    assert.match(a.out, /오리진 2\/2/);
    assert.match(a.out, /^ {2}CLOUDFLARE_SOURCE_POOL_ID=[0-9a-f]{32}$/m);   // 11: 워커·demo-preflight 가 같이 읽는 이름
    assert.doesNotMatch(a.out, /^ {2}CF_SOURCE_POOL_ID=/m);
    const b = cfCheck(f.port, KEEP, ORIG("new-src.example", "new-tgt.example"));
    assert.equal(b.code, 0, b.out);
    assert.doesNotMatch(b.out, /만듦/);
    assert.match(b.out, /출발 pool 오리진 바꿈 → new-src\.example/);
    assert.deepEqual(await poolsOf(f), { "cf-check-src": "new-src.example", "cf-check-tgt": "new-tgt.example" });
    const c = cfCheck(f.port, KEEP, ORIG("new-src.example", "new-tgt.example"));   // 같은 값이면 PATCH 안 함
    assert.doesNotMatch(c.out, /오리진 바꿈/);
  } finally { f.stop(); }
});

test("FM-TRF-02 거부: 다른 pool 이 오리진 한도를 쓰고 있으면 아무것도 만들기 전에 멈춘다 (dry-run 도 rc 1)", async () => {
  const f = await fake({ FAKE_ORIGIN_LIMIT: "2" });
  try {
    await f.post(`/accounts/${ACC}/load_balancers/pools`, { name: "old-manual", origins: [{ name: "o", address: "a.example" }] });
    const dry = cfCheck(f.port, ["--hold-sec=0"], ORIG("s.example", "t.example"));
    assert.equal(dry.code, 1, dry.out);
    assert.match(dry.out, /오리진 한도 2 를 넘는다: 다른 pool old-manual\(1\)/);
    const r = cfCheck(f.port, KEEP, ORIG("s.example", "t.example"));
    assert.equal(r.code, 1, r.out);
    assert.equal((await f.get(`/accounts/${ACC}/load_balancers/monitors`)).length, 0);   // 반쯤 만든 것이 안 남음
    assert.deepEqual(Object.keys(await poolsOf(f)), ["old-manual"]);
  } finally { f.stop(); }
});

test("FM-TRF-08·09: 정리는 만들 때와 LB 이름이 달라도 지우고 0 을 다시 확인, --list 는 비어 rc 0", async () => {
  const f = await fake();
  try {
    assert.equal(cfCheck(f.port, KEEP, { ...ORIG("s.example", "t.example"), CF_CHECK_LB_HOSTNAME: "made.example.test" }).code, 0);
    const l = cfCheck(f.port, ["--list"]);
    assert.equal(l.code, 0, l.out);
    assert.deepEqual(l.out.trim().split("\n").sort(), ["lb made.example.test", "monitor cf-check-monitor", "pool cf-check-src", "pool cf-check-tgt"]);
    const c = cfCheck(f.port, ["--cleanup", "--apply"]);   // CF_CHECK_LB_HOSTNAME 빠짐 → 설명(cf-check lb)으로 찾음
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /LB 지움/);
    assert.match(c.out, /정리 확인: cf-check 모니터·pool·LB 0/);
    assert.equal(cfCheck(f.port, ["--list"]).out.trim(), "");
  } finally { f.stop(); }
});

test("FM-TRF-08 거부: 지우기가 실패하면 rc 1 + 남은 것 목록, --list 조회 실패는 rc 2", async () => {
  const f = await fake({ FAKE_DELETE_FAIL: "lb" });
  try {
    assert.equal(cfCheck(f.port, KEEP, ORIG("s.example", "t.example")).code, 0);
    const c = cfCheck(f.port, ["--cleanup", "--apply"]);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /실패 LB 지우기 HTTP 500/);
    assert.match(c.out, /정리 뒤에도 남음: .*LB cf-check\.example\.test/);
    assert.equal(cfCheck(f.port, ["--list"], { CLOUDFLARE_API_TOKEN: "wrong" }).code, 2);
  } finally { f.stop(); }
});

test("FM-TRF-09: cloud-zero cf 줄이 남은 cf-check 자원을 세고(rc 1), 정리 뒤 0(rc 0), 토큰 없으면 건너뜀", async () => {
  const f = await fake();
  const cz = (env: Record<string, string>) => {
    const r = spawnSync("bash", ["tools/cloud-zero.sh", "cf"], { cwd: ROOT, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", CLOUDFLARE_ZONE_NAME: "example.test", CF_CHECK_API_BASE: `http://127.0.0.1:${f.port}/client/v4`, ...env } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  try {
    assert.equal(cfCheck(f.port, KEEP, ORIG("s.example", "t.example")).code, 0);
    const left = cz({ CLOUDFLARE_API_TOKEN: "fake-token" });
    assert.equal(left.code, 1, left.out);
    assert.match(left.out, /Cloudflare LB·pool·모니터\(cf-check\): +4/);
    assert.equal(cfCheck(f.port, ["--cleanup", "--apply"]).code, 0);
    const zero = cz({ CLOUDFLARE_API_TOKEN: "fake-token" });
    assert.equal(zero.code, 0, zero.out);
    assert.match(zero.out, /OK zero/);
    assert.equal(cz({ CLOUDFLARE_API_TOKEN: "wrong" }).code, 2);   // 조회 실패를 0 이라고 말하지 않음
  } finally { f.stop(); }
});

test("FM-TRF-10: 가짜 지표로 돈 전환은 결과에 metricsSource=stub (실측처럼 안 보이게)", async () => {
  let w: Weights = { source: 1, target: 0 };
  const sw: TrafficSwitcher = { provider: "cloudflare", async get() { return w; }, async set(_id, x) { w = x; } };
  const r = await runShift({ migrationId: "11111111-1111-4111-8111-111111111111", lbId: "lb", switcher: sw, metrics: stubMetrics("clean"),
    shareTolPct: 10, stepObserveSec: 0, observeSec: 0, sleep: async () => {} });
  assert.equal(r.metricsSource, "stub");
  assert.equal(stubMetrics("clean").source, "stub");
});

test("FM-TRF-22 거부: LB 가 도착으로 보내는 중이면 --cleanup 은 안 지우고, --force 면 지운다", async () => {
  const f = await fake();
  try {
    assert.equal(cfCheck(f.port, KEEP, ORIG("s.example", "t.example")).code, 0);
    const [lb] = await f.get(`/zones/0123456789abcdef0123456789abcdef/load_balancers`);
    const pools = await f.get(`/accounts/${ACC}/load_balancers/pools`);
    const src = pools.find((p) => p.name === "cf-check-src").id, tgt = pools.find((p) => p.name === "cf-check-tgt").id;
    await fetch(`http://127.0.0.1:${f.port}/client/v4/zones/0123456789abcdef0123456789abcdef/load_balancers/${lb.id}`, { method: "PATCH",
      headers: { authorization: "Bearer fake-token", "content-type": "application/json" },
      body: JSON.stringify({ steering_policy: "random", random_steering: { default_weight: 0, pool_weights: { [src]: 0.5, [tgt]: 0.5 } } }) });
    const r = cfCheck(f.port, ["--cleanup", "--apply"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /도착으로 50% 보내는 중/);
    assert.equal(cfCheck(f.port, ["--list"]).out.trim().split("\n").length, 4);   // 하나도 안 지움
    const g = cfCheck(f.port, ["--cleanup", "--apply", "--force"]);
    assert.equal(g.code, 0, g.out);
    assert.equal(cfCheck(f.port, ["--list"]).out.trim(), "");
  } finally { f.stop(); }
});

test("FM-TRF-13: Cloudflare setFallback 은 fallback_pool 만 PATCH, getFallback 은 도착/출발을 알아본다", async () => {
  const f = await fake();
  try {
    assert.equal(cfCheck(f.port, KEEP, ORIG("s.example", "t.example")).code, 0);
    const Z = "0123456789abcdef0123456789abcdef";
    const [lb] = await f.get(`/zones/${Z}/load_balancers`);
    const pools = await f.get(`/accounts/${ACC}/load_balancers/pools`);
    const src = pools.find((p) => p.name === "cf-check-src").id, tgt = pools.find((p) => p.name === "cf-check-tgt").id;
    const { cloudflareLb } = await import("@svc/traffic");
    const sw = cloudflareLb({ zoneId: Z, sourcePoolId: src, targetPoolId: tgt, token: async () => "fake-token", baseUrl: `http://127.0.0.1:${f.port}/client/v4` });
    assert.equal(await sw.getFallback!(lb.id), "source");
    await sw.setFallback!(lb.id, "target");
    assert.equal(await sw.getFallback!(lb.id), "target");
    assert.deepEqual(await sw.get(lb.id), { source: 1, target: 0 });   // 가중치는 그대로
    // 컷오버 뒤 fallback=도착이면 shift 재진입 점검이 CF_FALLBACK_NOT_SOURCE 로 막는다 → 롤백이 출발로 되돌려야 한다
    assert.deepEqual(await sw.preflight!(lb.id), ["CF_FALLBACK_NOT_SOURCE"]);
    await sw.setFallback!(lb.id, "source");
    assert.deepEqual(await sw.preflight!(lb.id), []);
  } finally { f.stop(); }
});

test("FM-TRF-13: 롤백(restoreSource)은 출발 100% 와 함께 fallback 도 출발로, 실패해도 가중치 결과는 그대로 남긴다", async () => {
  const { mockLb, restoreSource } = await import("@svc/traffic");
  const sw = mockLb({ source: 0, target: 1 });
  await sw.setFallback!("lb", "target");
  const r = await restoreSource({ switcher: sw, lbId: "lb", migrationId: "11111111-1111-4111-8111-111111111111", sleep: async () => {} });
  assert.equal(r.evidence.sourceWeight100, true);
  assert.equal(await sw.getFallback!("lb"), "source");
  assert.deepEqual(r.detail.fallback, { to: "source", ok: true });
  const bad = { ...mockLb({ source: 0, target: 1 }), async setFallback() { throw new Error("cf 500"); } };
  const r2 = await restoreSource({ switcher: bad, lbId: "lb", migrationId: "11111111-1111-4111-8111-111111111111", sleep: async () => {} });
  assert.equal(r2.evidence.sourceWeight100, true);
  assert.deepEqual(r2.detail.fallback, { to: "source", ok: false, error: "cf 500" });
});

test("RV-08: --apply 단계 중 Cloudflare 429 로 멈추면 LB 를 출발 100% 로 되돌리고 rc 1", async () => {
  // 기본 단계 90/10,50/50,0/100,100/0 → 3번째 LB PATCH(0/100)에서 429. 되돌리기 PATCH 는 정상
  const f = await fake({ FAKE_LB_PATCH_429_AT: "3" });
  try {
    const r = cfCheck(f.port, KEEP, ORIG("s.example", "t.example"));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /출발 100% 로 되돌림 \(확인됨\)/);
    const [lb] = await f.get(`/zones/0123456789abcdef0123456789abcdef/load_balancers`);
    const w = lb.random_steering?.pool_weights ?? {};
    const pools = Object.fromEntries((await f.get(`/accounts/${ACC}/load_balancers/pools`)).map((p) => [p.name, p.id]));
    assert.equal(w[pools["cf-check-src"]], 1, JSON.stringify(lb.random_steering));
    assert.equal(w[pools["cf-check-tgt"]] ?? 0, 0, JSON.stringify(lb.random_steering));
  } finally { f.stop(); }
});

test("TRF-21 거부: --register 를 --apply 와 쓰면서 --keep 이 없으면 만들기 전에 멈춘다 (끝에 지우면 등록이 죽은 LB)", async () => {
  const f = await fake();
  try {
    const r = cfCheck(f.port, ["--apply", "--hold-sec=0", "--repeat=1", "--register=11111111-1111-4111-8111-111111111111", "--tenant=22222222-2222-4222-8222-222222222222"], ORIG("s.example", "t.example"));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /--keep 도 필요하다/);
    assert.equal((await f.get(`/accounts/${ACC}/load_balancers/monitors`)).length, 0, "아무것도 안 만듦");
  } finally { f.stop(); }
});
