// /metrics(작업 T, api :9464) 한 번 긁는 비용. 순차 N회 + 동시 c개 + (선택) 다른 부하 중
// 실행: npx tsx --env-file=.env tools/load/metrics-scrape.ts   (SCRAPE_N=50, SCRAPE_C=5, METRICS_URL=http://localhost:9464/metrics)
// T 가 통합본에 들어간 뒤에만 의미가 있다. 없으면 연결 거부로 바로 끝난다
import { owner, summary } from "./lib.js";

const URL_ = process.env.METRICS_URL ?? "http://localhost:9464/metrics";
const N = Number(process.env.SCRAPE_N ?? 50);
const C = Number(process.env.SCRAPE_C ?? 5);

const dbMs: number[] = [];                                      // 지표가 스스로 잰 DB 집계 시간
async function one() {
  const t = performance.now();
  const r = await fetch(URL_);
  const body = await r.text();
  const m = body.match(/^svc_metrics_collect_duration_seconds\S*\s+([0-9.eE+-]+)/m);
  if (m) dbMs.push(Number(m[1]) * 1000);
  return { ms: performance.now() - t, status: r.status, bytes: body.length, series: body.split("\n").filter((l) => l && !l.startsWith("#")).length };
}
const rows = (await owner.query(`SELECT (SELECT count(*) FROM migrations)::int m, (SELECT count(*) FROM audit_events)::int a, (SELECT count(*) FROM pgboss.job)::int j`)).rows[0];
console.log(`DB size: migrations=${rows.m} audit_events=${rows.a} pgboss.job=${rows.j}`);
await one();                                                   // 첫 요청(준비) 제외
const seq: number[] = []; let bytes = 0, series = 0, bad = 0;
for (let i = 0; i < N; i++) { const r = await one(); seq.push(r.ms); bytes = r.bytes; series = r.series; if (r.status !== 200) bad++; }
console.log(`sequential x${N} ms`, JSON.stringify(summary(seq)), `body=${bytes}B series=${series} non200=${bad}`);
const con: number[] = [];
for (let k = 0; k < Math.ceil(N / C); k++) (await Promise.all(Array.from({ length: C }, one))).forEach((r) => { con.push(r.ms); if (r.status !== 200) bad++; });
console.log(`concurrent c=${C} ms`, JSON.stringify(summary(con)), `non200=${bad}`);
console.log("DB collect part (svc_metrics_collect_duration_seconds) ms", JSON.stringify(summary(dbMs)));
await owner.end();
