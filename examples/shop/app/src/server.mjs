import http from "node:http";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createDb } from "./db.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = process.env.APP_VERSION ?? "1.0.0";
const db = createDb();
const started = Date.now();
let shuttingDown = false;
const reqCount = { total: 0, error5xx: 0 };

const indexHtml = await readFile(new URL("../public/index.html", import.meta.url));

// Z70: 어느 클러스터가 응답했는지 (Cloudflare LB 분배 실측, scripts/cf-check.ts --probe). 플랫폼 배포가 SERVED_BY 를 넣는다
const SERVED_BY = process.env.SERVED_BY || "local";

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-served-by": SERVED_BY, ...headers });
  res.end(data);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw Object.assign(new Error("body too large"), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("invalid json"), { status: 400 }); }
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const intId = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${name} must be a positive integer`);
  return n;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["placed", "paid", "shipped", "cancelled"]);

async function createOrder(body) {
  const clientRef = body.clientRef ?? randomUUID();
  if (!UUID_RE.test(clientRef)) throw bad("clientRef must be a uuid");
  const customerId = intId(body.customerId, "customerId");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) throw bad("items must have 1..20 entries");
  const items = body.items.map((it) => ({ productId: intId(it.productId, "productId"), qty: intId(it.qty, "qty") }));

  return db.tx(async (c) => {
    const ins = await c.query(
      "INSERT INTO orders (client_ref, customer_id, total_krw) VALUES ($1, $2, 0) ON CONFLICT (client_ref) DO NOTHING RETURNING id",
      [clientRef, customerId],
    );
    if (ins.rowCount === 0) {
      const old = await c.query("SELECT id FROM orders WHERE client_ref = $1", [clientRef]);
      return { status: 200, body: { id: Number(old.rows[0].id), clientRef, duplicate: true } };
    }
    const id = ins.rows[0].id;
    const r = await c.query(
      `INSERT INTO order_items (order_id, product_id, qty, price_krw)
       SELECT $1, p.id, x.qty, p.price_krw
       FROM unnest($2::bigint[], $3::int[]) AS x(product_id, qty)
       JOIN products p ON p.id = x.product_id
       RETURNING qty, price_krw`,
      [id, items.map((i) => i.productId), items.map((i) => i.qty)],
    );
    if (r.rowCount !== items.length) throw bad("unknown productId");
    const total = r.rows.reduce((s, x) => s + x.qty * x.price_krw, 0);
    await c.query("UPDATE orders SET total_krw = $2 WHERE id = $1", [id, total]);
    return { status: 201, body: { id: Number(id), clientRef, totalKrw: total } };
  });
}

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const m = req.method;

  if (p === "/healthz") return send(res, shuttingDown ? 503 : 200, { ok: !shuttingDown });
  if (p === "/readyz") {
    if (shuttingDown) return send(res, 503, { ok: false, reason: "shutting down" });
    try { await db.pool.query("SELECT 1"); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 503, { ok: false, reason: e.code ?? e.message }); }
  }
  if (p === "/" && m === "GET") return send(res, 200, indexHtml, { "content-type": "text/html; charset=utf-8" });

  if (p === "/api/v1/info" && m === "GET") {
    const r = await db.query("SELECT host(inet_server_addr()) AS addr, current_setting('server_version') AS ver, current_setting('wal_level') AS wal, now() AS now");
    return send(res, 200, {
      app: "shop", version: VERSION, pod: os.hostname(), uptimeSec: Math.round((Date.now() - started) / 1000),
      db: { host: process.env.DB_HOST ?? "localhost", serverAddr: r.rows[0].addr, version: r.rows[0].ver, walLevel: r.rows[0].wal, now: r.rows[0].now },
    });
  }
  if (p === "/api/v1/stats" && m === "GET") {
    const r = await db.query(
      `SELECT (SELECT count(*) FROM customers)::int AS customers, (SELECT count(*) FROM products)::int AS products,
              (SELECT count(*) FROM orders)::int AS orders, (SELECT count(*) FROM order_items)::int AS order_items,
              (SELECT max(id) FROM orders)::bigint AS last_order_id,
              (SELECT count(*) FROM orders WHERE created_at > now() - interval '10 seconds')::int AS orders_last_10s`,
    );
    const row = r.rows[0];
    return send(res, 200, { ...row, last_order_id: Number(row.last_order_id), app: { requests: reqCount, db: db.counters } });
  }
  if (p === "/api/v1/orders" && m === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
    const r = await db.query(
      `SELECT o.id::int, o.status, o.total_krw, o.created_at, c.name AS customer
       FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT $1`, [limit]);
    return send(res, 200, { items: r.rows });
  }
  if (p === "/api/v1/orders" && m === "POST") {
    const out = await createOrder(await readJson(req));
    return send(res, out.status, out.body);
  }
  const one = p.match(/^\/api\/v1\/orders\/(\d+)$/);
  if (one && m === "GET") {
    const id = intId(one[1], "id");
    const o = await db.query("SELECT id::int, client_ref, customer_id::int, status, total_krw, created_at, updated_at FROM orders WHERE id = $1", [id]);
    if (!o.rowCount) return send(res, 404, { code: "NOT_FOUND" });
    const it = await db.query("SELECT product_id::int, qty, price_krw FROM order_items WHERE order_id = $1 ORDER BY id", [id]);
    return send(res, 200, { ...o.rows[0], items: it.rows });
  }
  if (one && m === "PATCH") {
    const id = intId(one[1], "id");
    const body = await readJson(req);
    if (!STATUSES.has(body.status)) throw bad("status must be one of placed|paid|shipped|cancelled");
    const r = await db.query("UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING id::int, status", [id, body.status]);
    if (!r.rowCount) return send(res, 404, { code: "NOT_FOUND" });
    return send(res, 200, r.rows[0]);
  }
  return send(res, 404, { code: "NOT_FOUND" });
}

const server = http.createServer(async (req, res) => {
  reqCount.total++;
  try {
    await route(req, res);
  } catch (e) {
    const status = e.status ?? (e.code === "23503" ? 400 : 500);
    if (status >= 500) {
      reqCount.error5xx++;
      console.error(JSON.stringify({ level: "error", method: req.method, path: req.url, code: e.code, err: e.message }));
    }
    if (!res.headersSent) send(res, status, { code: status >= 500 ? "INTERNAL" : "BAD_REQUEST", message: e.message });
  }
});
server.keepAliveTimeout = 65000;

server.listen(PORT, () => console.log(JSON.stringify({ level: "info", msg: "shop listening", port: PORT, dbHost: process.env.DB_HOST ?? "localhost", version: VERSION })));

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", msg: "shutdown", sig }));
  const grace = Number(process.env.SHUTDOWN_GRACE_MS ?? 5000);
  setTimeout(() => server.close(() => db.pool.end().finally(() => process.exit(0))), grace).unref();
  setTimeout(() => process.exit(1), grace + 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
