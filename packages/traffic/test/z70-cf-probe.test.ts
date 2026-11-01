// Z70-2: cf-check --probe 가 시스템 리졸버 없이 LB 이름을 풀고, 그 주소로만 붙는지 (네트워크·진짜 DNS 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pinnedLookup, probeOnce, waitResolvable, dnsServersFromEnv, withSystemFallback, judgeShare, authServers, zoneOf, isErrorKey, poolHealthOf, PROBE_TIMEOUT_MS, inCloudflareV4, originCheck } from "../../../scripts/cf-probe.js";

test("이름이 늦게 생겨도(처음 2번 ENOTFOUND) 풀릴 때까지 기다리고, 제한 시간이 지나면 빈 결과", async () => {
  let n = 0, clock = 0;
  const resolve4 = async () => { n++; if (n < 3) throw Object.assign(new Error("nf"), { code: "ENOTFOUND" }); return ["104.16.0.1"]; };
  const fake = { now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  const ok = await waitResolvable("cf-check.example.com", { resolve4, intervalMs: 2000, timeoutMs: 120_000, ...fake });
  assert.deepEqual(ok, { addrs: ["104.16.0.1"], waitedMs: 4000, tries: 3 });
  clock = 0;
  const never = await waitResolvable("x", { resolve4: async () => { throw Object.assign(new Error("nf"), { code: "ENOTFOUND" }); }, intervalMs: 2000, timeoutMs: 5000, ...fake });
  assert.equal(never.addrs.length, 0);
  assert.equal(never.lastError, "ENOTFOUND");
  assert.equal(never.tries, 3);
  assert.deepEqual(dnsServersFromEnv({}), ["1.1.1.1", "1.0.0.1"]);
  // 직접 질의가 막힌 망이면 시스템 리졸버로 한 번 더
  const fb = withSystemFallback(async () => { throw new Error("ECONNREFUSED"); }, async () => ["10.0.0.9"]);
  assert.deepEqual(await fb("h"), ["10.0.0.9"]);
  const direct = withSystemFallback(async () => ["1.2.3.4"], async () => { throw new Error("must not call"); });
  assert.deepEqual(await direct("h"), ["1.2.3.4"]);
  assert.deepEqual(dnsServersFromEnv({ CF_CHECK_DNS_SERVERS: "9.9.9.9" }), ["9.9.9.9"]);
});

test("고정 주소로 붙는다: 없는 이름(.invalid)이어도 getaddrinfo 를 안 타고 헤더를 읽는다, Host 는 LB 이름", async () => {
  let seenHost = "";
  const srv = http.createServer((req, res) => { seenHost = req.headers.host ?? ""; res.writeHead(200, { "x-served-by": "gcp-app-demo" }); res.end("ok"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    const host = "cf-check.never-resolves.invalid";
    const r = await probeOnce(host, "/healthz", "x-served-by", { lookup: pinnedLookup(["127.0.0.1"]), port, tls: false });
    assert.deepEqual(r, { status: 200, header: "gcp-app-demo" });
    assert.equal(seenHost, host);
    await assert.rejects(probeOnce(host, "/healthz", "x-served-by", { port, tls: false }), /ENOTFOUND|EAI_AGAIN/);
  } finally { srv.close(); }
});

test("분배 판정: 도착 몫이 기대 ±10%p 안. 오류도 분모에 들어간다", () => {
  const c = (o: Record<string, number>) => new Map(Object.entries(o));
  assert.equal(judgeShare(c({ "aws-app-demo": 45, "gcp-app-demo": 5 }), "gcp-app-demo", 0.1).ok, true);
  assert.equal(judgeShare(c({ "aws-app-demo": 30, "gcp-app-demo": 20 }), "gcp-app-demo", 0.1).ok, false);
  assert.deepEqual(judgeShare(c({ "gcp-app-demo": 25, "오류 ENOTFOUND": 25 }), "gcp-app-demo", 1), { ok: false, gotPct: 50, wantPct: 100, total: 50, tolPct: 10, errors: 25, errorPct: 50, reason: "오류 25/50 (50% > 20%)" });
  assert.equal(judgeShare(c({}), "gcp-app-demo", 0).ok, false);
});

// Z38 REVIEW-7 R7-6: 정확히 나누는 LB 도 표본 50개면 몫이 흔들린다 → 허용 폭 = max(10%p, 2.58σ)
test("분배 판정 경계: 50/50 가중치·요청 50번에서 33% 는 표본 오차 안(통과), 25% 는 실패. 0·100% 는 ±10%p 그대로", () => {
  const c = (t: number, n: number) => new Map([["gcp-app-demo", t], ["aws-app-demo", n - t]]);
  const v = judgeShare(c(17, 50), "gcp-app-demo", 0.5);
  assert.equal(v.tolPct, 18.2);
  assert.equal(v.ok, true);
  assert.equal(judgeShare(c(12, 50), "gcp-app-demo", 0.5).ok, false);
  assert.equal(judgeShare(c(5, 50), "gcp-app-demo", 0).tolPct, 10);
  assert.equal(judgeShare(c(6, 50), "gcp-app-demo", 0).ok, false);
  // 요청을 늘리면 폭이 10%p 로 줄어든다 (500번·50% → σ 2.2%p)
  assert.equal(judgeShare(c(330, 500), "gcp-app-demo", 0.5).ok, false);
  // 몬테카를로: 정확한 50% LB 를 2,000번 흉내 → 실패 비율이 2% 아래 (예전 고정 ±10%p 면 약 16%)
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let failNew = 0, failOld = 0;
  for (let k = 0; k < 2000; k++) {
    let t = 0; for (let i = 0; i < 50; i++) if (rnd() < 0.5) t++;
    if (!judgeShare(c(t, 50), "gcp-app-demo", 0.5).ok) failNew++;
    if (!judgeShare(c(t, 50), "gcp-app-demo", 0.5, 10, 0).ok) failOld++;
  }
  assert.ok(failNew / 2000 < 0.02, `new ${failNew}`);
  assert.ok(failOld / 2000 > 0.08, `old ${failOld}`);
});

// Z38 REVIEW-7 R7-5: 공개 리졸버의 "없음" 캐시를 피하려고 구역 권한 서버(NS) 주소를 찾는다
test("authServers: NS 이름 → 주소 (중복 제거, 일부 실패 무시), NS 조회 실패면 빈 배열", async () => {
  const r = { resolveNs: async (z: string) => (z === "example.com" ? ["a.ns.cf", "b.ns.cf"] : []),
    resolve4: async (h: string) => (h === "a.ns.cf" ? ["173.245.58.1"] : h === "b.ns.cf" ? ["173.245.58.1", "172.64.33.2"] : []) };
  assert.deepEqual(await authServers("example.com", [], r), ["173.245.58.1", "172.64.33.2"]);
  assert.deepEqual(await authServers("x.com", [], { resolveNs: async () => { throw new Error("SERVFAIL"); }, resolve4: async () => [] }), []);
  assert.deepEqual(await authServers("example.com", [], { ...r, resolve4: async (h: string) => { if (h === "a.ns.cf") throw new Error("t"); return ["172.64.33.2"]; } }), ["172.64.33.2"]);
  assert.equal(zoneOf("cf-check.softbank-team-iron.com"), "softbank-team-iron.com");
});

// ---- Z70-3: 맥 C 1회차 (522·판정 버그) ----
test("Z70-3 판정: 50번 전부 오류면 비율이 허용 폭 안이어도 실패 (예전엔 90/10 '도착 0% / 기대 10% ±10.9%p → OK')", () => {
  const all522 = new Map([["오류 ETIMEDOUT", 50]]);
  const v = judgeShare(all522, "gcp-app-demo", 0.1);
  assert.equal(v.ok, false);
  assert.equal(v.errors, 50);
  assert.match(v.reason ?? "", /오류 50\/50/);
  // 오류 20% 까지는 비율로 판정, 넘으면 실패
  assert.equal(judgeShare(new Map([["aws-app-demo", 36], ["gcp-app-demo", 4], ["HTTP 522", 10]]), "gcp-app-demo", 0.1).ok, true);
  assert.equal(judgeShare(new Map([["aws-app-demo", 35], ["gcp-app-demo", 4], ["HTTP 522", 11]]), "gcp-app-demo", 0.1).ok, false);
  assert.equal(isErrorKey("HTTP 522"), true);
  assert.equal(isErrorKey("오류 ECONNRESET"), true);
  assert.equal(isErrorKey("gcp-app-demo"), false);
});

test("Z70-3 pool 건강: 나쁜 오리진 이유를 꺼내고, 모르는 모양은 unknown", () => {
  const bad = poolHealthOf({ pop_health: { LAX: { healthy: false, origins: [{ "34.64.1.2": { healthy: false, failure_reason: "TCP connection failed", response_code: 0 } }] } } });
  assert.deepEqual(bad, { state: "unhealthy", pops: ["LAX"], reason: "LAX 34.64.1.2: TCP connection failed" });
  assert.equal(poolHealthOf({ pop_health: { NRT: { healthy: true, origins: [] }, LAX: { healthy: false } } }).state, "healthy");
  assert.equal(poolHealthOf({}).state, "unknown");
  assert.equal(poolHealthOf(null).state, "unknown");
});

test("Z70-3 엣지가 20초쯤 끌다 522 를 주면: 제한 시간이 길면 'HTTP 522' 로 보이고, 짧으면 ETIMEDOUT 으로 가려진다", async () => {
  const srv = http.createServer((_q, res) => setTimeout(() => { res.writeHead(522, { "cf-ray": "x-LAX" }); res.end("522"); }, 300));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    const o = { lookup: pinnedLookup(["127.0.0.1"]), port, tls: false };
    assert.deepEqual(await probeOnce("cf-check.example.invalid", "/healthz", "x-served-by", { ...o, timeoutMs: 2000 }), { status: 522, header: null });
    await assert.rejects(probeOnce("cf-check.example.invalid", "/healthz", "x-served-by", { ...o, timeoutMs: 100 }), (e: NodeJS.ErrnoException) => e.code === "ETIMEDOUT");
    assert.equal(PROBE_TIMEOUT_MS >= 25_000, true, "기본 제한 시간은 Cloudflare 오리진 대기(약 20초)보다 길다");
  } finally { srv.close(); }
});

// ---- z75-32: probe 전 선행 점검 ----
test("z75-32 ③ Cloudflare 대역: 엣지 주소는 안, 오리진·사설 주소는 밖", () => {
  assert.equal(inCloudflareV4("104.21.33.7"), true);
  assert.equal(inCloudflareV4("172.67.140.1"), true);
  assert.equal(inCloudflareV4("34.64.200.10"), false);
  assert.equal(inCloudflareV4("127.0.0.1"), false);
  assert.equal(inCloudflareV4("not-an-ip"), false);
});

test("z75-32 ① 오리진 직접: 헤더 있으면 통과, 헤더 없거나·200 아니거나·내려가 있으면 실패 (5초 안)", async () => {
  const mk = (code: number, hdr: boolean) => http.createServer((_q, r) => { r.writeHead(code, hdr ? { "x-served-by": "gcp-app-demo" } : {}); r.end(); });
  const servers = [mk(200, true), mk(200, false), mk(503, true)];
  const ports: number[] = [];
  for (const s of servers) { await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r())); ports.push((s.address() as AddressInfo).port); }
  try {
    const chk = (p: number) => originCheck(`127.0.0.1:${p}`, "/healthz", "x-served-by", { tls: false, timeoutMs: 2000 });
    assert.deepEqual((({ ok, detail }) => ({ ok, detail }))(await chk(ports[0]!)), { ok: true, detail: "x-served-by: gcp-app-demo" });
    assert.match((await chk(ports[1]!)).detail, /헤더 없음/);
    assert.equal((await chk(ports[2]!)).detail, "HTTP 503");
    servers[0]!.close(); await new Promise((r) => setTimeout(r, 50));
    const down = await chk(ports[0]!);
    assert.equal(down.ok, false);
    assert.equal(down.detail, "ECONNREFUSED");
    assert.ok(down.ms < 5000);
  } finally { for (const s of servers) s.close(); }
});
