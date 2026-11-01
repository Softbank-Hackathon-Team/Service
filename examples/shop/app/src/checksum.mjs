// DRAFT(ai): 표마다 행 수 + 내용 지문(md5). 원본과 대상에서 각각 돌려 비교한다 (쓰기를 멈춘 뒤).
import { createDb } from "./db.mjs";

const db = createDb();
const tables = ["customers", "products", "orders", "order_items"];
const out = {};
for (const t of tables) {
  const r = await db.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(x::text), '' ORDER BY x.id)), '') AS h FROM shop.${t} x`);
  out[t] = { rows: r.rows[0].n, md5: r.rows[0].h };
}
console.log(JSON.stringify(out));
await db.pool.end();
