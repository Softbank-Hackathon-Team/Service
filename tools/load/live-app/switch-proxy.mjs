// DRAFT(ai): 모의 트래픽 전환기. 통합본에는 아직 "앱 접속을 도착 DB 로 옮기는" 단계가 없다(shift 는 STUB, 앱 연결 드레인 TODO(human)).
// 그래서 샘플 앱을 두 개 띄우고(A=출발 DB, B=도착 DB) 이 프록시가 이전 상태를 보고 A→B 로 넘긴다.
// MODE=switch : 상태가 rollback_window 이후가 되는 순간 B 로 보낸다 (그 전 cutover 중 쓰기는 출발 펜스에 맞는다)
// MODE=hold   : 상태가 cutover 인 동안 요청을 붙잡았다가(드레인 후보) 끝나면 B 로 보낸다
// 환경 변수: LAT_KEEP(20000) PORT(8090) A_URL(8080) B_URL(8081) API(http://localhost:3000/api/v1) MIGRATION_ID(없으면 POST /__track/<id> 로 알려 준다) POLL_MS(50)
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8090);
const A = process.env.A_URL ?? "http://localhost:8080";
const B = process.env.B_URL ?? "http://localhost:8081";
const API = process.env.API ?? "http://localhost:3000/api/v1";
const TENANT = process.env.TENANT ?? "11111111-1111-4111-8111-111111111111";
const MODE = process.env.MODE ?? "hold";
const POLL = Number(process.env.POLL_MS ?? 50);
const AFTER = new Set(["rollback_window", "cleanup", "completed"]);

let status = "?", id = process.env.MIGRATION_ID ?? null, switchedAt = null, held = 0, maxHoldMs = 0;

// 작업 Z35 (Z15 제안 3): 앱 요청 숫자. API GET /migrations/:id/live-traffic 가 LIVE_TRAFFIC_URL=<이 프록시>/__stats 로 읽는다
// 요청 하나 = 지연 1개. 실패 = 5xx 또는 위쪽 연결 실패(502). 4xx 는 c4xx 로 따로 (앱이 거절한 것, 이전 탓 아님)
// 상태는 요청이 "들어온" 순간의 이전 상태로 묶는다. 지연은 최근 LAT_KEEP 개만 기억한다 (데모 몇 분이면 충분)
const LAT_KEEP = Number(process.env.LAT_KEEP ?? 20000);
let c = null;
function resetCounters() { c = { since: new Date().toISOString(), total: 0, ok: 0, fail: 0, c4xx: 0, lat: [], by: {} }; }
resetCounters();
function record(state, code, ms) {
  c.total++;
  if (code >= 500) c.fail++; else if (code >= 400) c.c4xx++; else c.ok++;
  c.lat.push(ms); if (c.lat.length > LAT_KEEP) c.lat.shift();
  const b = (c.by[state] ??= { n: 0, fail: 0, lat: [] });
  b.n++; if (code >= 500) b.fail++;
  b.lat.push(ms); if (b.lat.length > LAT_KEEP) b.lat.shift();
}
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; };
function stats() {
  const byState = Object.fromEntries(Object.entries(c.by).map(([k, v]) => [k, { n: v.n, fail: v.fail, p95Ms: q(v.lat, 0.95) }]));
  return { id, status, switchedAt, held, maxHoldMs: Math.round(maxHoldMs), mode: MODE,
           since: c.since, total: c.total, ok: c.ok, fail: c.fail, c4xx: c.c4xx, p50Ms: q(c.lat, 0.5), p95Ms: q(c.lat, 0.95), byState };
}
const waiters = [];
async function poll() {
  try {
    const h = { "x-dev-tenant": TENANT };
    if (id) status = (await (await fetch(`${API}/migrations/${id}`, { headers: h })).json()).status;
    if (AFTER.has(status) && !switchedAt) { switchedAt = new Date().toISOString(); console.log(JSON.stringify({ msg: "switched to B", id, status, at: switchedAt })); }
    if (status !== "cutover") while (waiters.length) waiters.shift()();
  } catch { /* 다음 번에 */ }
  setTimeout(poll, POLL);
}
poll();

http.createServer(async (req, res) => {
  const t0 = performance.now();
  const tr = req.url?.match(/^\/__track\/([0-9a-f-]{36})$/);
  if (tr) { id = tr[1]; switchedAt = null; held = 0; maxHoldMs = 0; resetCounters(); res.end("ok"); return; }
  if (req.url === "/__stats") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(stats())); return; }
  const stateIn = id ? status : "before";
  if (MODE === "hold" && status === "cutover") { held++; await new Promise((r) => waiters.push(r)); maxHoldMs = Math.max(maxHoldMs, performance.now() - t0); }
  const up = switchedAt ? B : A;
  const body = await new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
  try {
    const r = await fetch(up + req.url, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json", "x-upstream": up });
    res.end(Buffer.from(await r.arrayBuffer()));
    record(stateIn, r.status, performance.now() - t0);
  } catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: String(e) })); record(stateIn, 502, performance.now() - t0); }
}).listen(PORT, () => console.log(JSON.stringify({ msg: "switch-proxy", PORT, A, B, MODE })));
process.on("SIGTERM", () => { console.log(JSON.stringify({ msg: "proxy stats", ...stats() })); process.exit(0); });
