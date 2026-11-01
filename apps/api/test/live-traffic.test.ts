// 작업 Z35 (Z15 제안 3): 가동 중 앱 숫자. DB 없이 도는 부분
//  - 프록시 원본 → 화면 모양 (다른 이전 숫자는 안 내보냄, 옛 프록시도 받음)
//  - 프록시가 죽거나 느려도 200 모양으로 "숫자 없음 + 이유"
//  - 진짜 switch-proxy.mjs 를 띄워 요청을 흘리고 /__stats 를 읽는다 (가짜 앱·가짜 API 로)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { toLiveView, readLiveTraffic, LiveTrafficView } from "../src/live-traffic.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-11-07T01:00:00Z");

test("toLiveView: 이 이전을 보는 프록시 숫자 → available, 상태는 정상 경로 순서", () => {
  const v = toLiveView(ID, {
    id: ID, status: "cutover", switchedAt: null, held: 3, maxHoldMs: 41, mode: "hold", since: "2026-11-07T00:59:00Z",
    total: 1200, ok: 1199, fail: 0, c4xx: 1, p50Ms: 6.1, p95Ms: 11.8,
    byState: { cutover: { n: 40, fail: 0, p95Ms: 52 }, before: { n: 300, fail: 0, p95Ms: 9 }, syncing: { n: 860, fail: 0, p95Ms: 11 } },
  }, NOW);
  assert.equal(v.available, true);
  assert.equal(v.total, 1200); assert.equal(v.fail, 0); assert.equal(v.held, 3);
  assert.deepEqual(v.byState.map((b) => b.state), ["before", "syncing", "cutover"]);
  assert.equal(LiveTrafficView.safeParse(v).success, true);
});

test("toLiveView: 다른 이전·모양 틀림·옛 프록시(숫자 칸 없음)는 숫자 0 + 이유", () => {
  const other = toLiveView(ID, { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "syncing", total: 99 }, NOW);
  assert.equal(other.available, false); assert.equal(other.reason, "other_migration"); assert.equal(other.total, 0);
  assert.equal(toLiveView(ID, { nope: 1 }, NOW).reason, "bad_shape");
  assert.equal(toLiveView(ID, "x", NOW).reason, "bad_shape");
  const old = toLiveView(ID, { id: ID, status: "cutover", switchedAt: null, held: 2, maxHoldMs: 30, mode: "hold" }, NOW);
  assert.equal(old.reason, "no_counters"); assert.equal(old.held, 2);
  for (const v of [other, old]) assert.equal(LiveTrafficView.safeParse(v).success, true);
});

test("readLiveTraffic: 주소 없음 → not_configured, 500·예외·시간 초과 → unreachable", async () => {
  assert.equal((await readLiveTraffic(ID, {})).reason, "not_configured");
  const r500 = await readLiveTraffic(ID, { url: "http://x/__stats", fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(r500.reason, "unreachable");
  const thrown = await readLiveTraffic(ID, { url: "http://x/__stats", fetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(thrown.reason, "unreachable");
  const t0 = Date.now();
  const slow = await readLiveTraffic(ID, { url: "http://x/__stats", timeoutMs: 50,
    fetch: (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  assert.equal(slow.reason, "unreachable");
  assert.ok(Date.now() - t0 < 1000, "시간 제한이 먹어야 한다");
});

// 진짜 프록시. 가짜 앱 A 는 /boom 에만 500, 가짜 API 는 이전 상태를 "syncing" 으로 답한다
test("switch-proxy.mjs: 요청을 세고 /__stats 가 화면 모양으로 바뀐다 (5xx 는 fail, 4xx 는 c4xx)", async () => {
  const listen = (h: http.RequestListener) => new Promise<http.Server>((r) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => r(s)); });
  const port = (s: http.Server) => (s.address() as AddressInfo).port;
  const app = await listen((req, res) => {
    req.resume();
    res.writeHead(req.url === "/boom" ? 500 : req.url === "/bad" ? 400 : 201, { "content-type": "application/json" }); res.end("{}");
  });
  const api = await listen((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "syncing" })); });
  // 빈 포트 하나 얻기
  const tmp = await listen(() => {}); const PPORT = port(tmp); await new Promise((r) => tmp.close(r));
  const proxyPath = fileURLToPath(new URL("../../../tools/load/live-app/switch-proxy.mjs", import.meta.url));
  const px = spawn(process.execPath, [proxyPath], { env: { ...process.env, PORT: String(PPORT), A_URL: `http://127.0.0.1:${port(app)}`,
    B_URL: `http://127.0.0.1:${port(app)}`, API: `http://127.0.0.1:${port(api)}`, POLL_MS: "20", MODE: "hold" }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((r) => px.stdout!.once("data", () => r()));
    const P = `http://127.0.0.1:${PPORT}`;
    await (await fetch(`${P}/__track/${ID}`)).text();
    // z75-05: 프록시가 이전 상태를 한 번 읽을 때까지 기다린다. 예전엔 100ms 고정이라 CPU 가 바쁘면 첫 읽기 전에 요청이 나가 "?" 칸에 쌓였다
    for (const until = Date.now() + 5000; ; ) {
      const s = await (await fetch(`${P}/__stats`)).json() as { status?: string };
      if (s.status === "syncing") break;
      if (Date.now() > until) assert.fail(`프록시가 5초 안에 상태를 못 읽음: ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    for (let i = 0; i < 20; i++) await (await fetch(`${P}/orders`, { method: "POST", body: "{}" })).text();
    await (await fetch(`${P}/boom`)).text();
    await (await fetch(`${P}/bad`)).text();
    const raw = await (await fetch(`${P}/__stats`)).json();
    const v = toLiveView(ID, raw, NOW);
    assert.equal(v.available, true, JSON.stringify(raw));
    assert.equal(v.total, 22); assert.equal(v.ok, 20); assert.equal(v.fail, 1); assert.equal(v.c4xx, 1);
    assert.ok(v.p95Ms !== null && v.p95Ms >= 0);
    assert.deepEqual(v.byState.map((b) => [b.state, b.n, b.fail]), [["syncing", 22, 1]]);
    // 다른 이전으로 __track 하면 숫자가 처음부터
    await (await fetch(`${P}/__track/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)).text();
    const again = await (await fetch(`${P}/__stats`)).json() as { total: number };
    assert.equal(again.total, 0);
    assert.equal(toLiveView(ID, again, NOW).reason, "other_migration");
  } finally {
    px.kill("SIGTERM"); app.close(); api.close();
  }
});
