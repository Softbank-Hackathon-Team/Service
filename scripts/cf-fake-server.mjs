// 가짜 Cloudflare API (cf-check.ts 를 토큰 없이 리허설). 실행: node scripts/cf-fake-server.mjs
import http from "node:http";
import { randomBytes } from "node:crypto";
const ZONE = "0123456789abcdef0123456789abcdef", ACC = "fedcba9876543210fedcba9876543210";
const db = { monitors: new Map(), pools: new Map(), lbs: new Map(), lbPatches: 0 };
const log = [];
// z75-38: LB 가중치 변경 이력 (FAKE_EDGE_LAG_MS 용)
const lbHist = [];
const lbSeen = (o) => lbHist.push({ t: Date.now(), w: { ...(o.random_steering?.pool_weights ?? {}) }, pools: [...(o.default_pools ?? [])] });
const id = () => randomBytes(16).toString("hex");
const send = (res, code, result, errors = []) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ success: code < 400, errors, result })); };
const api = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const b = body ? JSON.parse(body) : undefined;
  const u = new URL(req.url, "http://x"); const p = u.pathname.replace("/client/v4", "");
  log.push(`${req.method} ${p}`);
  if (req.headers.authorization !== "Bearer fake-token") return send(res, 403, null, [{ code: 10000, message: "Authentication error" }]);
  if (p === "/user/tokens/verify") return send(res, 200, { status: "active" });
  if (p === "/zones") return send(res, 200, u.searchParams.get("name") === "example.test" ? [{ id: ZONE, name: "example.test", account: { id: ACC }, plan: { name: "Free Website" } }] : []);
  // Z70-3: 구역 SSL 모드 (FAKE_SSL_MODE, 기본 full) 와 pool 건강 (FAKE_EDGE=522 이면 나쁨)
  if (p === `/zones/${ZONE}/settings/ssl`) return send(res, 200, { id: "ssl", value: process.env.FAKE_SSL_MODE ?? "full" });
  const hm = p.match(new RegExp(`^/accounts/${ACC}/load_balancers/pools/([0-9a-f]+)/health$`));
  if (hm) {
    // Z38 REVIEW-8 §6: z75-22(demo-preflight) 의 같은 경로와 합침 — 풀을 만들 때 healthy:false 를 준 풀도 나쁨 (두 패치를 같이 붙이면 hm 이 두 번 선언돼 문법 오류였다)
    const bad = process.env.FAKE_EDGE === "522" || db.pools.get(hm[1])?.healthy === false;
    return send(res, 200, { pool_id: hm[1], pop_health: { LAX: { healthy: !bad, origins: [{ "203.0.113.10": bad
      ? { healthy: false, failure_reason: "TCP connection failed", response_code: 0 } : { healthy: true, rtt: "12ms" } }] } } });
  }
  if (p === `/accounts/${ACC}/cfd_tunnel`) return send(res, 200, [{ id: "11111111-2222-3333-4444-555555555555", name: "demo", status: "healthy" }]);
  const coll = p.startsWith(`/accounts/${ACC}/load_balancers/monitors`) ? db.monitors : p.startsWith(`/accounts/${ACC}/load_balancers/pools`) ? db.pools : p.startsWith(`/zones/${ZONE}/load_balancers`) ? db.lbs : null;
  if (!coll) return send(res, 404, null, [{ code: 7003, message: "no route" }]);
  const rid = p.split("/").at(-1); const isItem = !["monitors", "pools", "load_balancers"].includes(rid);
  if (!isItem && req.method === "GET") return send(res, 200, [...coll.values()]);
  // pf-d: FAKE_ORIGIN_LIMIT 이 있으면 계정 오리진 합이 넘는 pool POST 를 거부 (실제 응답 code·문구는 【추정】)
  if (!isItem && req.method === "POST" && coll === db.pools && process.env.FAKE_ORIGIN_LIMIT) {
    const used = [...db.pools.values()].reduce((a, x) => a + (x.origins?.length ?? 0), 0);
    if (used + (b?.origins?.length ?? 0) > Number(process.env.FAKE_ORIGIN_LIMIT)) return send(res, 400, null, [{ code: 1003, message: "origin limit reached" }]);
  }
  if (!isItem && req.method === "POST") { const o = { id: id(), ...b }; coll.set(o.id, o); if (coll === db.lbs) lbSeen(o); return send(res, 200, o); }
  const o = coll.get(rid); if (!o) return send(res, 404, null, [{ code: 1002, message: "not found" }]);
  if (req.method === "GET") return send(res, 200, o);
  // RV-08: FAKE_LB_PATCH_429_AT=N 이면 N 번째 LB PATCH 하나만 429 (그 뒤는 정상)
  if (req.method === "PATCH" && coll === db.lbs && process.env.FAKE_LB_PATCH_429_AT && ++db.lbPatches === Number(process.env.FAKE_LB_PATCH_429_AT))
    return send(res, 429, null, [{ code: 971, message: "rate limited" }]);
  if (req.method === "PATCH") { Object.assign(o, b); if (coll === db.lbs) lbSeen(o); return send(res, 200, o); }
  if (req.method === "DELETE") {
    // pf-d: FAKE_DELETE_FAIL=lb|pool|monitor 이면 그 종류 지우기를 500 으로 실패
    const kind = coll === db.lbs ? "lb" : coll === db.pools ? "pool" : "monitor";
    if (process.env.FAKE_DELETE_FAIL === kind) return send(res, 500, null, [{ code: 1000, message: "internal error" }]);
    // 사용 중이면 거부 (실제 Cloudflare 와 같은 순서 강제 【추정】)
    if (coll === db.pools && [...db.lbs.values()].some((l) => l.default_pools.includes(rid))) return send(res, 400, null, [{ code: 1001, message: "pool in use" }]);
    if (coll === db.monitors && [...db.pools.values()].some((x) => x.monitor === rid)) return send(res, 400, null, [{ code: 1001, message: "monitor in use" }]);
    coll.delete(rid); return send(res, 200, { id: rid });
  }
  send(res, 405, null, []);
});
// PORT=0 이면 운영체제가 빈 포트를 준다. 시험은 이 줄에서 포트를 읽는다
api.listen(Number(process.env.PORT ?? 8787), () => console.log(`fake cf up ${api.address().port}`));

// Z70-3: 가짜 엣지 (EDGE_PORT 가 있을 때만). cf-check --probe 를 VM 에서 흉내 낸다 (CF_CHECK_PROBE_ADDR=127.0.0.1, CF_CHECK_PROBE_PORT, CF_CHECK_PROBE_SCHEME=http)
//   FAKE_EDGE=522 : 오리진 443 이 닫힌 경우. FAKE_EDGE_DELAY_MS(기본 1000) 뒤 522, x-served-by 없음 (Cloudflare 실제는 약 20초)
//   FAKE_EDGE=ok  : LB 의 pool_weights 대로 고르고 x-served-by = <pool 이름 끝>-app (예: src-app, tgt-app)
//   FAKE_EDGE_LAG_MS (z75-38): 엣지가 LB 가중치를 이만큼 늦게 본다 (실제 Cloudflare 전파 지연 흉내). 그 전엔 두 pool 반반
if (process.env.EDGE_PORT) {
  http.createServer((req, res) => {
    if (process.env.FAKE_EDGE === "522") {
      setTimeout(() => { res.writeHead(522, { "content-type": "text/html", "cf-ray": "fake-LAX" }); res.end("522"); }, Number(process.env.FAKE_EDGE_DELAY_MS ?? 1000));
      return;
    }
    const lb = [...db.lbs.values()][0];
    const lag = Number(process.env.FAKE_EDGE_LAG_MS ?? 0);
    let w = lb?.random_steering?.pool_weights ?? {};
    if (lag > 0 && lb) {
      const seen = lbHist.filter((h) => h.t <= Date.now() - lag).at(-1);
      w = seen ? seen.w : Object.fromEntries((lb.default_pools ?? []).map((k) => [k, 0.5]));
    }
    const ids = Object.keys(w); const sum = ids.reduce((a, k) => a + w[k], 0);
    let r = Math.random() * (sum || 1), pick = ids[0];
    for (const k of ids) { r -= w[k]; if (r <= 0) { pick = k; break; } }
    const name = (db.pools.get(pick)?.name ?? "none").split("-").at(-1);
    res.writeHead(200, { "x-served-by": `${name}-app`, "content-type": "application/json" }); res.end("{}");
  }).listen(Number(process.env.EDGE_PORT), "127.0.0.1", () => console.log("fake edge up"));
}
process.on("SIGTERM", () => { console.log(JSON.stringify({ left: { m: db.monitors.size, p: db.pools.size, l: db.lbs.size }, calls: log.length })); process.exit(0); });
