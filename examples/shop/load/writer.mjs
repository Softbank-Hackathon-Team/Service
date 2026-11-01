// DRAFT(ai): 컷오버 중 "쓰기 실패 0" 증명용 부하. 의존성 없음(Node 22 fetch).
// 주문 생성(POST) + 상태 변경(PATCH)을 계속 보낸다. 같은 clientRef 로 다시 보내므로 재시도해도 두 번 안 들어간다.
// 환경 변수: TARGET_URL, RATE(초당 요청), CONCURRENCY, DURATION_SEC(0=Ctrl+C까지), RETRIES, RETRY_DELAY_MS, TIMEOUT_MS, OUT_DIR, PATCH_RATIO
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";

const cfg = {
  url: (process.env.TARGET_URL ?? "http://localhost:8080").replace(/\/$/, ""),
  rate: Number(process.env.RATE ?? 50),
  concurrency: Number(process.env.CONCURRENCY ?? 8),
  durationSec: Number(process.env.DURATION_SEC ?? 30),
  retries: Number(process.env.RETRIES ?? 3),
  retryDelayMs: Number(process.env.RETRY_DELAY_MS ?? 100),
  timeoutMs: Number(process.env.TIMEOUT_MS ?? 10000),
  patchRatio: Number(process.env.PATCH_RATIO ?? 0.2),
  customers: Number(process.env.CUSTOMERS ?? 20000),
  products: Number(process.env.PRODUCTS ?? 1000),
  outDir: process.env.OUT_DIR ?? new URL("./out/", import.meta.url).pathname,
};

const runId = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(cfg.outDir, { recursive: true });
const ackFile = `${cfg.outDir.replace(/\/$/, "")}/acked-${runId}.txt`;
writeFileSync(ackFile, "");

const st = { sent: 0, ok: 0, failed: 0, retried: 0, retriedOk: 0, attempts: 0, lat: [], errors: {}, perSec: [] };
const acked = [];
let secOk = 0, secFail = 0, secRetry = 0, maxLat = 0;
const rnd = (n) => 1 + Math.floor(Math.random() * n);

async function once(method, path, body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const r = await fetch(cfg.url + path, {
      method, signal: ac.signal,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  } finally {
    clearTimeout(t);
  }
}

// 5xx·연결 오류·타임아웃이면 같은 요청을 다시 보낸다(최대 RETRIES번, RETRY_DELAY_MS 간격). 4xx 는 다시 안 보낸다.
async function withRetry(method, path, body) {
  let lastErr = "";
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    st.attempts++;
    if (attempt > 0) {
      st.retried++; secRetry++;
      await new Promise((r) => setTimeout(r, cfg.retryDelayMs));
    }
    try {
      const r = await once(method, path, body);
      if (r.status < 500) {
        if (attempt > 0) st.retriedOk++;
        return r;
      }
      lastErr = `http_${r.status}`;
    } catch (e) {
      lastErr = e.name === "AbortError" ? "timeout" : (e.cause?.code ?? e.code ?? e.message);
    }
  }
  return { status: 0, error: lastErr };
}

async function oneRequest() {
  st.sent++;
  const t0 = performance.now();
  let r;
  if (acked.length > 0 && Math.random() < cfg.patchRatio) {
    const id = acked[Math.floor(Math.random() * acked.length)];
    r = await withRetry("PATCH", `/api/v1/orders/${id}`, { status: ["paid", "shipped"][rnd(2) - 1] });
  } else {
    const items = Array.from({ length: rnd(3) }, () => ({ productId: rnd(cfg.products), qty: rnd(3) }));
    r = await withRetry("POST", "/api/v1/orders", { clientRef: randomUUID(), customerId: rnd(cfg.customers), items });
    if (r.status === 201 || r.status === 200) {
      acked.push(r.json.id);
      appendFileSync(ackFile, `${r.json.id}\n`);
    }
  }
  const ms = performance.now() - t0;
  st.lat.push(ms);
  if (ms > maxLat) maxLat = ms;
  if (r.status >= 200 && r.status < 300) { st.ok++; secOk++; }
  else {
    st.failed++; secFail++;
    const k = r.error ?? `http_${r.status}`;
    st.errors[k] = (st.errors[k] ?? 0) + 1;
  }
}

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
};

let stop = false;
let inflight = 0;
const startedAt = Date.now();
const interval = 1000 / cfg.rate;
let next = performance.now();

const ticker = setInterval(() => {
  const sec = Math.round((Date.now() - startedAt) / 1000);
  st.perSec.push({ sec, ok: secOk, fail: secFail, retry: secRetry, maxMs: +maxLat.toFixed(1) });
  console.log(`t=${String(sec).padStart(3)}s ok=${secOk} fail=${secFail} retry=${secRetry} max=${maxLat.toFixed(0)}ms inflight=${inflight}`);
  secOk = 0; secFail = 0; secRetry = 0; maxLat = 0;
}, 1000);

process.on("SIGINT", () => { stop = true; });
process.on("SIGTERM", () => { stop = true; });
if (cfg.durationSec > 0) setTimeout(() => { stop = true; }, cfg.durationSec * 1000);

console.log(`writer → ${cfg.url} rate=${cfg.rate}/s concurrency=${cfg.concurrency} duration=${cfg.durationSec || "∞"}s retries=${cfg.retries}x${cfg.retryDelayMs}ms`);

while (!stop) {
  if (inflight < cfg.concurrency) {
    inflight++;
    oneRequest().finally(() => { inflight--; });
  }
  next += interval;
  const wait = next - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  else if (inflight >= cfg.concurrency) await new Promise((r) => setTimeout(r, 1));
}
while (inflight > 0) await new Promise((r) => setTimeout(r, 20));
clearInterval(ticker);

const summary = {
  runId, target: cfg.url, durationSec: +((Date.now() - startedAt) / 1000).toFixed(1),
  sent: st.sent, ok: st.ok, failed: st.failed,
  retries: st.retried, recoveredByRetry: st.retriedOk, attempts: st.attempts,
  ordersAcked: acked.length,
  latencyMs: { p50: pct(st.lat, 50), p95: pct(st.lat, 95), p99: pct(st.lat, 99), max: pct(st.lat, 100) },
  errors: st.errors, ackFile,
};
writeFileSync(`${cfg.outDir.replace(/\/$/, "")}/run-${runId}.json`, JSON.stringify({ ...summary, perSec: st.perSec }, null, 2));
console.log("--- 결과 ---");
console.log(`요청 ${summary.sent} / 성공 ${summary.ok} / 실패 ${summary.failed} / 재시도 ${summary.retries}회 (재시도로 살린 요청 ${summary.recoveredByRetry})`);
console.log(`지연 p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms p99=${summary.latencyMs.p99}ms max=${summary.latencyMs.max}ms`);
console.log(JSON.stringify(summary));
process.exit(summary.failed === 0 ? 0 : 1);
