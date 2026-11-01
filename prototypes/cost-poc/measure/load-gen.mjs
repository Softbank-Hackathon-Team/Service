// DRAFT(ai): examples/shop 부하 생성기. 외부 의존성 없음, Node 22.
// 열린 고리(open loop): 도착률 λ를 고정하고 응답을 기다리지 않는다. 응답이 밀리면 지연으로 드러난다.
// 사용: node load-gen.mjs <url> <rps> <durationSec> <warmSec> <mix: target|write> > 결과.json
import http from "node:http";
import { randomUUID } from "node:crypto";

const [base, rpsArg, durArg, warmArg, mix = "target"] = process.argv.slice(2);
const rps = Number(rpsArg); const dur = Number(durArg); const warm = Number(warmArg);
const u = new URL(base);
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

// θ: 요청 구성. target = 고객 앱의 실제 사용을 흉내 낸 읽기 위주 혼합(가정), write = 팀 데모 부하(writer.mjs)와 같은 쓰기 위주
const MIXES = {
  target: [["list", 0.60], ["detail", 0.20], ["create", 0.12], ["patch", 0.05], ["html", 0.03]],
  write: [["create", 0.80], ["patch", 0.20]],
};
const table = MIXES[mix];
if (!table) { console.error(`unknown mix ${mix}`); process.exit(2); }
let seedState = 42;
const rnd = () => { seedState = (seedState * 1664525 + 1013904223) >>> 0; return seedState / 2 ** 32; };
const pick = () => { let x = rnd(); for (const [k, w] of table) { if ((x -= w) <= 0) return k; } return table[0][0]; };
const lastOrder = { id: 60000 };

function plan(kind) {
  if (kind === "list") return { method: "GET", path: "/api/v1/orders?limit=20" };
  if (kind === "detail") return { method: "GET", path: `/api/v1/orders/${1 + Math.floor(rnd() * lastOrder.id)}` };
  if (kind === "html") return { method: "GET", path: "/" };
  if (kind === "patch") return { method: "PATCH", path: `/api/v1/orders/${1 + Math.floor(rnd() * lastOrder.id)}`, body: { status: "paid" } };
  const n = 1 + Math.floor(rnd() * 3);
  return { method: "POST", path: "/api/v1/orders", body: {
    clientRef: randomUUID(), customerId: 1 + Math.floor(rnd() * 20000),
    items: Array.from({ length: n }, () => ({ productId: 1 + Math.floor(rnd() * 1000), qty: 1 + Math.floor(rnd() * 3) })),
  } };
}

const latencies = []; const counts = { ok: 0, err4xx: 0, err5xx: 0, netErr: 0 };
let bytesIn = 0; let bytesOut = 0; let measured = false; let inflight = 0; let maxInflight = 0;
const seenSockets = new Set();

function fire() {
  const k = pick(); const p = plan(k);
  const payload = p.body ? JSON.stringify(p.body) : null;
  const t0 = performance.now(); const count = measured;
  inflight++; if (inflight > maxInflight) maxInflight = inflight;
  const req = http.request({ host: u.hostname, port: u.port, method: p.method, path: p.path, agent,
    headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, (res) => {
    res.on("data", () => {});
    res.on("end", () => {
      inflight--;
      if (!count) return;
      latencies.push(performance.now() - t0);
      if (res.statusCode >= 500) counts.err5xx++;
      else if (res.statusCode === 404 && (k === "detail" || k === "patch")) counts.ok++; // 없는 번호 조회는 앱 오류가 아니다
      else if (res.statusCode >= 400) counts.err4xx++;
      else counts.ok++;
    });
  });
  req.on("socket", (s) => { if (!seenSockets.has(s)) { seenSockets.add(s); } });
  req.on("error", () => { inflight--; if (count) counts.netErr++; });
  if (payload) req.write(payload);
  req.end();
}

const socketTotals = () => { let i = 0; let o = 0; for (const s of seenSockets) { i += s.bytesRead; o += s.bytesWritten; } return { i, o }; };

const started = performance.now();
let sent = 0;
let winStart = null; let winBase = null;
const tick = () => {
  const el = (performance.now() - started) / 1000;
  const want = Math.floor(el * rps);
  while (sent < want) { fire(); sent++; }
  if (!measured && el >= warm) { measured = true; winStart = performance.now(); winBase = socketTotals(); process.stderr.write("WINDOW_START\n"); }
  if (el >= warm + dur) {
    clearInterval(timer);
    const winEnd = performance.now();
    const end = socketTotals();
    process.stderr.write("WINDOW_END\n");
    setTimeout(() => {
      latencies.sort((a, b) => a - b);
      const q = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : null;
      bytesIn = end.i - winBase.i; bytesOut = end.o - winBase.o;
      const secs = (winEnd - winStart) / 1000;
      const total = counts.ok + counts.err4xx + counts.err5xx + counts.netErr;
      console.log(JSON.stringify({
        mix, targetRps: rps, windowSec: secs, requests: total, achievedRps: total / secs,
        p50Ms: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxInflight, ...counts,
        errorRate: total ? (counts.err5xx + counts.netErr) / total : 0,
        // 소켓 바이트 = 본문 + HTTP 헤더. TCP/IP 머리글은 포함하지 않는다
        bytesToClient: bytesIn, bytesFromClient: bytesOut, bytesPerRequest: total ? bytesIn / total : 0,
      }));
      process.exit(0);
    }, 300);
  }
};
const timer = setInterval(tick, 5);
