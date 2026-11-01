// 컨테이너 HEALTHCHECK 용 작은 검사기. 묶어서 dist/<app>/healthcheck.mjs 로 들어간다.
//   node healthcheck.mjs http://127.0.0.1:3000/healthz  → HTTP 2xx 면 성공(api)
//   node healthcheck.mjs db                              → DATABASE_URL 로 SELECT 1(worker, agent-worker)
// 왜 db 검사인가: 워커는 HTTP 포트가 없다(T 관측성 병합 후엔 :9465/metrics 로 바꾸는 게 낫다).
// DRAFT(ai): 2초 안에 답이 없으면 실패
import pg from "pg";

const target = process.argv[2] ?? "db";
const timer = setTimeout(() => { console.error("healthcheck timeout"); process.exit(1); }, 2000);

try {
  if (target === "db") {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1500 });
    await c.connect();
    await c.query("SELECT 1");
    await c.end();
  } else {
    const res = await fetch(target);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
  clearTimeout(timer);
  process.exit(0);
} catch (e) {
  console.error("unhealthy:", e instanceof Error ? e.message : e);
  process.exit(1);
}
