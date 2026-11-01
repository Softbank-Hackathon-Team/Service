// 작업 Z49: 읽기 API 경로별 응답 시간 p50/p95 (STUB 모드, 로컬)
// 실행: npx tsx tools/perf/api-bench.ts   (BENCH_N=300 요청/경로, BENCH_C=1,10 동시 수)
// 재는 것: 요청 하나의 왕복(fetch 시작 → 본문 다 받음). 응답 크기도 같이 적는다
const API = `http://localhost:${process.env.API_PORT ?? 3000}/api/v1`;
const H = { "x-dev-tenant": process.env.BENCH_TENANT ?? "11111111-1111-4111-8111-111111111111" };
const N = Number(process.env.BENCH_N ?? 300);
const CS = (process.env.BENCH_C ?? "1,10").split(",").map(Number);

async function get(path: string): Promise<{ ms: number; status: number; bytes: number }> {
  const t = performance.now();
  const r = await fetch(API + path, { headers: H });
  const b = await r.arrayBuffer();
  return { ms: performance.now() - t, status: r.status, bytes: b.byteLength };
}
const pct = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN; };

const list = await (await fetch(API + "/migrations", { headers: H })).json() as { items?: { id: string; status: string }[] } | { id: string; status: string }[];
const items = Array.isArray(list) ? list : (list.items ?? []);
const done = items.find((m) => m.status === "completed");
if (!done) { console.error("completed 이전이 없다. 먼저 smoke 또는 tools/load/flows.ts"); process.exit(1); }
const id = done.id;
const paths: [string, string][] = [
  ["목록 GET /migrations", "/migrations"],
  ["상세 GET /migrations/:id", `/migrations/${id}`],
  ["타임라인 GET /migrations/:id/timeline", `/migrations/${id}/timeline`],
  ["보안 표 GET /migrations/:id/security", `/migrations/${id}/security`],
  ["비용 GET /migrations/:id/cost", `/migrations/${id}/cost`],
  ["계획 GET /migrations/:id/plan", `/migrations/${id}/plan`],
  ["리포트 GET /migrations/:id/report", `/migrations/${id}/report`],
  ["환경 GET /environments", "/environments"],
];
console.log(`items=${items.length} id=${id} N=${N}`);
console.log("| 경로 | 동시 | p50 ms | p95 ms | p99 ms | 초당 | 크기 KB | 상태 |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [name, p] of paths) {
  for (let w = 0; w < 20; w++) await get(p);   // 데우기
  for (const c of CS) {
    const lat: number[] = []; const st = new Map<number, number>(); let bytes = 0; let left = N;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: c }, async () => {
      while (left-- > 0) { const r = await get(p); lat.push(r.ms); bytes = r.bytes; st.set(r.status, (st.get(r.status) ?? 0) + 1); }
    }));
    const sec = (performance.now() - t0) / 1000;
    console.log(`| ${name} | ${c} | ${pct(lat, 50).toFixed(1)} | ${pct(lat, 95).toFixed(1)} | ${pct(lat, 99).toFixed(1)} | ${Math.round(lat.length / sec)} | ${(bytes / 1024).toFixed(1)} | ${[...st].map(([k, v]) => `${k}×${v}`).join(" ")} |`);
  }
}
