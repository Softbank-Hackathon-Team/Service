// Z31: 붙잡기 프록시 단위 시험. 진짜 Postgres 없이, Postgres 메시지 몇 개만 흉내 내는 가짜 서버로 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Framer, HoldProxy, controlServer, parseUpstreams } from "../src/proxy.js";
import { holdHooks, appLinkFromEnv } from "../src/hooks.js";

const msg = (type: string, body: Buffer = Buffer.alloc(0)) => {
  const h = Buffer.alloc(5); h.write(type, 0); h.writeInt32BE(body.length + 4, 1); return Buffer.concat([h, body]);
};
const Z = (s: "I" | "T" | "E") => msg("Z", Buffer.from(s));
const startup = () => { const b = Buffer.alloc(8); b.writeInt32BE(8, 0); b.writeInt32BE(196608, 4); return b; };
const sslRequest = () => { const b = Buffer.alloc(8); b.writeInt32BE(8, 0); b.writeInt32BE(80877103, 4); return b; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 가짜 DB: startup → AuthOk + Z(I). 'Q' 본문 "BEGIN" → Z(T), "COMMIT" → Z(I), 그 밖 → Z(현재). 받은 질의를 name 과 함께 적는다 */
async function fakeDb(name: string, seen: string[]) {
  const srv = net.createServer((s) => {
    let started = false, tx: "I" | "T" = "I"; let buf = Buffer.alloc(0);
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!started) { if (buf.length < 8) return; const len = buf.readInt32BE(0); buf = buf.subarray(len); started = true;
          s.write(Buffer.concat([msg("R", Buffer.from([0, 0, 0, 0])), Z("I")])); continue; }
        if (buf.length < 5) return;
        const len = buf.readInt32BE(1); if (buf.length < len + 1) return;
        const type = String.fromCharCode(buf[0]!); const body = buf.subarray(5, len + 1).toString().replace(/\0$/, "");
        buf = buf.subarray(len + 1);
        if (type === "X") { s.end(); return; }
        if (type === "Q") { seen.push(`${name}:${body}`); if (body === "BEGIN") tx = "T"; if (body === "COMMIT") tx = "I";
          s.write(Buffer.concat([msg("C", Buffer.from("OK\0")), Z(tx)])); }
      }
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { srv, port: (srv.address() as net.AddressInfo).port };
}

/** 가짜 앱 연결: startup 을 보내고 Z 를 받을 때까지 기다리는 아주 작은 클라이언트 */
function client(port: number, skipBytes = 0) {
  const s = net.connect(port, "127.0.0.1");
  let skip = skipBytes;
  const zs: string[] = []; let closed = false; let wake: (() => void) | null = null;
  let buf = Buffer.alloc(0);
  s.on("data", (d: Buffer) => {
    if (skip) { const k = Math.min(skip, d.length); skip -= k; d = d.subarray(k); }
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) { const len = buf.readInt32BE(1); if (buf.length < len + 1) break;
      if (buf[0] === 0x5a) zs.push(String.fromCharCode(buf[5]!)); buf = buf.subarray(len + 1); }
    wake?.();
  });
  s.on("close", () => { closed = true; wake?.(); });
  s.on("error", () => {});
  const nextZ = async (n: number, ms = 2000) => { const t = Date.now(); while (zs.length < n && !closed && Date.now() - t < ms) await new Promise<void>((r) => { wake = r; setTimeout(r, 20); }); return zs.length >= n; };
  return { s, zs, isClosed: () => closed, nextZ, send: (b: Buffer) => s.write(b), q: (sql: string) => s.write(msg("Q", Buffer.from(sql + "\0"))) };
}

async function setup() {
  const seen: string[] = [];
  const a = await fakeDb("A", seen), b = await fakeDb("B", seen);
  const p = new HoldProxy({ upstreams: { source: { host: "127.0.0.1", port: a.port }, target: { host: "127.0.0.1", port: b.port } }, active: "source", drainTimeoutMs: 500, holdMaxMs: 3000, log: () => {} });
  const addr = await p.listen(0, "127.0.0.1");
  const done = async () => { await p.close(); a.srv.close(); b.srv.close(); };
  return { p, port: addr.port, seen, done };
}

test("Framer: 쪼개져 들어온 메시지도 경계와 Z 상태 바이트를 센다", () => {
  const got: string[] = [];
  const f = new Framer((t, b) => got.push(t === "Z" ? `Z${String.fromCharCode(b!)}` : t));
  const all = Buffer.concat([msg("C", Buffer.from("SELECT 1\0")), Z("T"), msg("D", Buffer.alloc(300)), Z("I")]);
  for (let i = 0; i < all.length; i += 3) f.push(all.subarray(i, i + 3));
  assert.deepEqual(got, ["C", "ZT", "D", "ZI"]);
});

test("parseUpstreams / appLinkFromEnv", () => {
  assert.deepEqual(parseUpstreams("source=db:5432, target=target:5432"), { source: { host: "db", port: 5432 }, target: { host: "target", port: 5432 } });
  assert.throws(() => parseUpstreams("source=db"));
  assert.equal(appLinkFromEnv({}), null);
  assert.deepEqual(appLinkFromEnv({ APP_LINK_URLS: "http://a:1/, http://b:2" })?.urls, ["http://a:1", "http://b:2"]);
});

test("pause: 쉬는 연결은 닫고, 새 연결은 붙잡았다가 resume 대상(B)으로 보낸다", async () => {
  const { p, port, seen, done } = await setup();
  const c1 = client(port); c1.send(startup()); assert.ok(await c1.nextZ(1));
  c1.q("SELECT a"); assert.ok(await c1.nextZ(2));
  const r = await p.pause();
  assert.equal(r.closedIdle, 1); assert.equal(r.leftBusy, 0);
  await sleep(30); assert.ok(c1.isClosed(), "쉬던 연결은 닫힘 (앱 pool 이 새로 연다)");
  const c2 = client(port); c2.send(startup());
  assert.equal(await c2.nextZ(1, 150), false, "붙잡힌 동안 답이 없다 (에러도 없다)");
  assert.equal(c2.isClosed(), false);
  const rr = p.resume("target");
  assert.equal(rr.released, 1); assert.equal(rr.previous, "source");
  assert.ok(await c2.nextZ(1)); c2.q("INSERT x"); assert.ok(await c2.nextZ(2));
  assert.deepEqual(seen, ["A:SELECT a", "B:INSERT x"]);
  c2.s.destroy(); await done();
});

test("pause: 트랜잭션 중인 연결은 COMMIT 답까지 받은 뒤 닫는다 (진행 중 쓰기는 출발에서 끝난다)", async () => {
  const { p, port, seen, done } = await setup();
  const c = client(port); c.send(startup()); await c.nextZ(1);
  c.q("BEGIN"); await c.nextZ(2); assert.equal(c.zs.at(-1), "T");
  const pausing = p.pause();
  await sleep(50); assert.equal(c.isClosed(), false, "트랜잭션 중에는 안 닫는다");
  c.q("INSERT y"); await c.nextZ(3);
  c.q("COMMIT");
  const r = await pausing;
  assert.equal(r.drainedBusy, 1); assert.equal(r.leftBusy, 0);
  assert.ok(await c.nextZ(4)); assert.equal(c.zs.at(-1), "I", "COMMIT 답(Z I)은 닫기 전에 앱에 간다");
  await sleep(30); assert.ok(c.isClosed());
  assert.deepEqual(seen, ["A:BEGIN", "A:INSERT y", "A:COMMIT"]);
  p.resume("target"); await done();
});

test("pause: 드레인 시간 초과면 그대로 두고 돌아온다 (leftBusy). resume 대상이 바뀌면 그 연결은 닫는다", async () => {
  const { p, port, done } = await setup();
  const c = client(port); c.send(startup()); await c.nextZ(1); c.q("BEGIN"); await c.nextZ(2);
  const r = await p.pause(100);
  assert.equal(r.leftBusy, 1); assert.ok(r.drainMs >= 90);
  p.resume("target"); await sleep(30);
  assert.ok(c.isClosed(), "옛 대상에 남은 연결은 닫힘");
  await done();
});

test("SSLRequest 에는 'N' 으로 답하고 평문으로 잇는다", async () => {
  const { port, done } = await setup();
  const c = client(port, 1);
  const first = new Promise<string>((r) => c.s.once("data", (d: Buffer) => r(d.subarray(0, 1).toString())));
  c.send(sslRequest()); assert.equal(await first, "N");
  c.send(startup()); assert.ok(await c.nextZ(1));
  c.s.destroy(); await done();
});

test("holdMax: resume 이 안 오면 지금 대상으로 저절로 푼다", async () => {
  const seen: string[] = [];
  const a = await fakeDb("A", seen);
  const p = new HoldProxy({ upstreams: { source: { host: "127.0.0.1", port: a.port } }, active: "source", holdMaxMs: 120, log: () => {} });
  const { port } = await p.listen(0, "127.0.0.1");
  await p.pause();
  const c = client(port); c.send(startup());
  assert.ok(await c.nextZ(1, 1000)); assert.equal(p.stats.autoReleases, 1);
  c.s.destroy(); await p.close(); a.srv.close();
});

test("제어 HTTP + holdHooks: 토큰, pause → resume(target), 모르는 대상 400", async () => {
  const { p, port, done } = await setup();
  const ctl = controlServer(p, "t0k");
  await new Promise<void>((r) => ctl.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(ctl.address() as net.AddressInfo).port}`;
  assert.equal((await fetch(`${url}/status`)).status, 401);
  const bad = await fetch(`${url}/resume`, { method: "POST", headers: { authorization: "Bearer t0k" }, body: JSON.stringify({ upstream: "x" }) });
  assert.equal(bad.status, 400);
  const h = holdHooks({ urls: [url], token: "t0k", timeoutMs: 1000, retries: 1 }, (w) => (w.adminUrl.includes("55433") ? "target" : "source"));
  const c = client(port); c.send(startup()); await c.nextZ(1);
  await h.pause();
  assert.equal(p.paused, true);
  await h.resume({ label: "dst", adminUrl: "postgres://x@localhost:55433/shop" });
  assert.equal(p.active, "target"); assert.equal(p.paused, false);
  const rep = h.report();
  assert.equal(rep.pause?.closedIdle, 1); assert.equal(rep.resume?.upstream, "target"); assert.equal(rep.resumeFailed, false);
  ctl.close(); await done();
});

test("holdHooks: pause 가 한 곳에서 실패하면 붙잡은 곳을 그대로 풀고 예외 (펜스 전에 멈춘다)", async () => {
  const { p, done } = await setup();
  const ctl = controlServer(p);
  await new Promise<void>((r) => ctl.listen(0, "127.0.0.1", () => r()));
  const good = `http://127.0.0.1:${(ctl.address() as net.AddressInfo).port}`;
  const h = holdHooks({ urls: [good, "http://127.0.0.1:1"], timeoutMs: 300, retries: 0 }, () => "target");
  await assert.rejects(h.pause(), /APP_LINK_PAUSE_FAILED/);
  assert.equal(p.paused, false); assert.equal(p.active, "source");
  ctl.close(); await done();
});

test("holdHooks: resume 이 끝내 실패해도 던지지 않고 resumeFailed 를 남긴다 (C6 뒤 예외 = 반쯤 컷오버를 막는다)", async () => {
  let n = 0;
  const f = (async (u: string) => { n++; if (String(u).endsWith("/status")) return new Response(JSON.stringify({ active: "source" })); throw new Error("down"); }) as typeof fetch;
  const h = holdHooks({ urls: ["http://x"], timeoutMs: 100, retries: 2 }, () => "target", f);
  await h.resume({ label: "dst", adminUrl: "u" });
  assert.equal(h.report().resumeFailed, true); assert.equal(h.report().resume?.attempts, 3); assert.equal(n, 3);
});

// Z70: 진짜 apply 가 만든 도착 DB 주소를 컷오버 전에 넣는 길
test("Z70 setUpstream: 쓰기 대상이 아닌 upstream 만, 붙잡는 중엔 거절. HTTP POST /upstream", async () => {
  const p = new HoldProxy({ upstreams: parseUpstreams("source=127.0.0.1:1,target=127.0.0.1:2"), active: "source", log: () => {} });
  assert.throws(() => p.setUpstream("source", { host: "x", port: 5432 }), /active/);
  assert.throws(() => p.setUpstream("target", { host: "x", port: 0 }), /bad host/);
  const r = p.setUpstream("target", { host: "shop.rds.example", port: 5432 });
  assert.deepEqual(r.previous, { host: "127.0.0.1", port: 2 });
  assert.deepEqual(p.upstreamOf("target"), { host: "shop.rds.example", port: 5432 });
  const ctl = controlServer(p, "tok");
  await new Promise<void>((res) => ctl.listen(0, "127.0.0.1", () => res()));
  const port = (ctl.address() as net.AddressInfo).port;
  const post = (body: object, auth = "Bearer tok") => fetch(`http://127.0.0.1:${port}/upstream`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ name: "target", host: "h2", port: 6432 }, "Bearer no")).status, 401);
  assert.equal((await post({ name: "target", host: "h2", port: 6432 })).status, 200);
  assert.deepEqual(p.upstreamOf("target"), { host: "h2", port: 6432 });
  assert.equal((await post({ name: "source", host: "h3", port: 1 })).status, 409);
  ctl.close();
});
