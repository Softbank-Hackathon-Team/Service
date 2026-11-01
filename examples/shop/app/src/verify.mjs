// DRAFT(ai): 부하 스크립트가 "성공(201)"으로 받은 주문 번호가 DB에 전부 있는지 센다 (RPO 0 확인).
// 사용: node src/verify.mjs < acked-....txt   (DB_* 환경 변수로 원본/대상 아무 DB나 가리킨다)
import { createDb } from "./db.mjs";

let raw = "";
for await (const c of process.stdin) raw += c;
const ids = raw.split(/\s+/).filter(Boolean).map(Number);
const db = createDb();
const r = await db.query("SELECT count(*)::int AS found FROM shop.orders WHERE id = ANY($1::bigint[])", [ids]);
const miss = await db.query(
  "SELECT x.id FROM unnest($1::bigint[]) AS x(id) LEFT JOIN shop.orders o ON o.id = x.id WHERE o.id IS NULL LIMIT 10", [ids]);
const out = { acked: ids.length, found: r.rows[0].found, missing: ids.length - r.rows[0].found, sampleMissing: miss.rows.map((x) => Number(x.id)) };
console.log(JSON.stringify(out));
await db.pool.end();
process.exit(out.missing === 0 ? 0 : 1);
