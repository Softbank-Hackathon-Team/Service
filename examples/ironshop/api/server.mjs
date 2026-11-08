// 아이언 철물점 API (shop-api 자리). 출발 샘플 템플릿(tools/real/flow/sample-3tier-eks.yaml.tpl)을 그대로 쓴다:
//   포트 8080, 준비 검사 GET / (DB 없이 바로 200), env DB_HOST·DB_PORT·DB_NAME·DB_USER·DB_PASSWORD
//   템플릿의 http-echo 인자(-listen=:8080 -text=ok)는 ENTRYPOINT 뒤에 붙어 들어오고 무시된다
// 표는 출발 시드의 orders(id, item, qty, created_at) 하나만 읽고 쓴다. 표를 만들거나 바꾸지 않는다 (논리 복제는 표 구조 변경을 옮기지 않는다)
import http from "node:http";
import pg from "pg";
import { ITEMS, displayName, parseOrder, placeOf } from "./items.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const DB_HOST = process.env.DB_HOST ?? "localhost";
// DRAFT(ai): TLS 기본 켬(인증서 검증 안 함). RDS·Cloud SQL 은 TLS 를 요구한다. 로컬 시험만 DB_SSLMODE=disable
// ponytail: 서버 인증서를 검증하지 않는다 (암호화만). 검증하려면 도착마다 CA 를 넣어야 해서 샘플에서는 뺐다
const ssl = (process.env.DB_SSLMODE ?? "require") === "disable" ? false : { rejectUnauthorized: false };

const pool = new pg.Pool({
  host: DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? "shop", user: process.env.DB_USER ?? "shop_app", password: process.env.DB_PASSWORD,
  ssl, max: 4, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
});
// 컷오버 때 연결이 끊기거나 쓰기가 잠깐 막혀도 앱은 죽지 않는다. 다음 요청이 새 연결로 다시 붙는다
pool.on("error", (e) => console.error(JSON.stringify({ level: "warn", msg: "db idle error", err: e.message })));

async function summary() {
  const [db, stats, recent] = await Promise.all([
    pool.query(`SELECT current_setting('server_version') AS version,
                       current_setting('rds.force_ssl', true) AS rds, current_setting('cloudsql.logical_decoding', true) AS cloudsql`),
    // 데이터 지문: 모든 주문을 번호 순으로 이어 붙인 md5 앞 8자. 출발과 도착에서 같으면 같은 데이터다
    pool.query(`SELECT count(*)::int AS count, coalesce(max(id), 0)::bigint AS last_id,
                       left(md5(coalesce(string_agg(id || ':' || item || ':' || qty, ',' ORDER BY id), '')), 8) AS fingerprint
                FROM orders`),
    pool.query("SELECT id, item, qty, created_at FROM orders ORDER BY id DESC LIMIT 8"),
  ]);
  return {
    db: { host: DB_HOST, place: placeOf(db.rows[0]), version: db.rows[0].version },
    count: stats.rows[0].count, lastId: Number(stats.rows[0].last_id), fingerprint: stats.rows[0].fingerprint,
    orders: recent.rows.map((r) => ({ id: Number(r.id), name: displayName(r.item), qty: r.qty, at: r.created_at })),
    items: ITEMS,
  };
}

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const readJson = (req) => new Promise((ok) => {
  let s = "";
  req.on("data", (c) => { s += c; if (s.length > 4096) req.destroy(); });
  req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { ok(null); } });
});

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  try {
    if (path === "/" || path === "/healthz") return send(res, 200, { ok: true });
    if (path === "/api/summary" && req.method === "GET") return send(res, 200, await summary());
    if (path === "/api/orders" && req.method === "POST") {
      const o = parseOrder(await readJson(req));
      if (!o) return send(res, 400, { error: "상품이나 수량이 맞지 않습니다" });
      const r = await pool.query("INSERT INTO orders (item, qty) VALUES ($1, $2) RETURNING id", [o.item, o.qty]);
      return send(res, 201, { id: Number(r.rows[0].id) });
    }
    return send(res, 404, { error: "없는 경로" });
  } catch (e) {
    // DB 가 잠깐 안 될 때(컷오버 순간 등)는 503 으로 알리고, 화면은 다음 새로고침에서 다시 묻는다
    console.error(JSON.stringify({ level: "warn", msg: "request failed", path, err: e.message }));
    return send(res, 503, { error: "DB 에 잠시 연결할 수 없습니다" });
  }
});

server.listen(PORT, () => console.log(JSON.stringify({ level: "info", msg: "ironshop api", port: PORT })));

// 파드 교체 때: 새 요청은 받지 않고, 하던 요청을 끝낸 뒤 내려간다
process.on("SIGTERM", () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
});
