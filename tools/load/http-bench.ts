// HTTP 처리량: autocannon(npx 로 받음, 설치 없음)으로 경로별 p50/p95/p99·초당 요청·오류를 잰다
// 실행: npx tsx --env-file=.env tools/load/http-bench.ts   (BENCH_SEC=10, POST_SEC=3)
// 주의: POST 시나리오는 이전을 실제로 만든다(초당 수백 개). 끝나면 워커가 가져오기 큐를 한동안 처리한다
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { call, owner, sampleConnections, pct, TENANT, SRC, DST } from "./lib.js";

const SEC = process.env.BENCH_SEC ?? "10";
const BASE = `http://localhost:${process.env.API_PORT ?? 3000}`;
const AC = process.env.AUTOCANNON ?? "autocannon@8.0.0";
// POST 는 이전을 실제로 만들어 가져오기 큐가 밀린다(워커 3개 ≈ 초당 6개 처리). 그래서 짧게
const POST_SEC = Number(process.env.POST_SEC ?? 3);
const id = (await call("POST", "/migrations", { sourceEnvId: SRC, targetEnvId: DST })).json.id;

const scenarios: { name: string; c: number; args: string[] }[] = [
  { name: "GET /healthz (DB 없음, 기준선)", c: 20, args: [`${BASE}/healthz`] },
  { name: "GET /api/v1/migrations (목록 50)", c: 20, args: [`${BASE}/api/v1/migrations`] },
  { name: "GET /api/v1/migrations (목록 50)", c: 50, args: [`${BASE}/api/v1/migrations`] },
  { name: "GET /api/v1/migrations/:id", c: 20, args: [`${BASE}/api/v1/migrations/${id}`] },
];

// spawnSync 를 쓰면 이벤트 루프가 막혀 DB 연결 표본을 못 뜬다 → 비동기 실행
function run(cmd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args); let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => res({ status, stdout, stderr }));
  });
}

// POST 는 요청마다 다른 Idempotency-Key 가 필요하다. autocannon CLI 의 [<id>] 치환은 헤더 값에서 거부돼서
// (8.0.0, "Usage" 출력) 여기서는 직접 닫힌 고리(동시 c개가 끝나는 대로 다음 요청)로 잰다
async function closedLoop(c: number, sec: number, fn: () => Promise<number>) {
  const lat: number[] = []; const codes = new Map<number, number>(); let errs = 0;
  const until = performance.now() + sec * 1000;
  await Promise.all(Array.from({ length: c }, async () => {
    while (performance.now() < until) {
      const t = performance.now();
      try { const st = await fn(); codes.set(st, (codes.get(st) ?? 0) + 1); } catch { errs++; }
      lat.push(performance.now() - t);
    }
  }));
  return { lat, codes, errs };
}

const rows: string[] = [];
for (const s of scenarios) {
  const conn = sampleConnections(200);
  const r = await run("npx", ["--yes", AC, "--json", "-c", String(s.c), "-d", SEC, "-H", `x-dev-tenant=${TENANT}`, ...s.args]);
  const peak = conn.stop();
  if (r.status !== 0 || !r.stdout.trim()) { console.error(r.status, r.stderr.slice(-800)); throw new Error("autocannon failed"); }
  const j = JSON.parse(r.stdout);
  const non2xx = j.non2xx ?? 0, errs = j.errors ?? 0, total = j.requests.total;
  const row = `| ${s.name} | ${s.c} | ${Math.round(j.requests.average)} | ${j.latency.p50} | ${j.latency.p97_5 ?? "-"} | ${j.latency.p99} | ${j.latency.max} | ${non2xx}/${total} | ${errs} | ${j["5xx"] ?? 0} | ${peak.total}/${peak.maxConnections} |`;
  console.log(row);
  rows.push(row);
}
{
  const c = 10; const conn = sampleConnections(200);
  const body = JSON.stringify({ sourceEnvId: SRC, targetEnvId: DST });
  const r = await closedLoop(c, POST_SEC, async () => (await fetch(`${BASE}/api/v1/migrations`, { method: "POST", body,
    headers: { "content-type": "application/json", "x-dev-tenant": TENANT, "idempotency-key": `load-${randomUUID()}` } }).then(async (x) => { await x.arrayBuffer(); return x.status; })));
  const peak = conn.stop();
  const total = r.lat.length; const ok = r.codes.get(202) ?? 0; const s5 = [...r.codes].filter(([k]) => k >= 500).reduce((a, [, v]) => a + v, 0);
  const row = `| POST /api/v1/migrations + 새 Idempotency-Key (fetch 고리) | ${c} | ${Math.round(total / POST_SEC)} | ${Math.round(pct(r.lat, 50))} | ${Math.round(pct(r.lat, 97.5))} | ${Math.round(pct(r.lat, 99))} | ${Math.round(Math.max(...r.lat))} | ${total - ok}/${total} | ${r.errs} | ${s5} | ${peak.total}/${peak.maxConnections} |`;
  console.log(row); rows.push(row);
}
console.log("\n| 시나리오 | 동시 | 초당 요청 | p50 ms | p97.5 ms | p99 ms | max ms | 2xx 아님 | 연결 오류 | 5xx | DB 연결 최대 |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
rows.forEach((x) => console.log(x));
await owner.end();
