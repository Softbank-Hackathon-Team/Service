// Z77: 같은 DB 에 이전 두 건이 동시에 _repl 표지 스키마·표를 만들면 CREATE … IF NOT EXISTS 끼리 부딪쳤다
//   ("duplicate key value violates unique constraint pg_namespace_nspname_index" → sync 600초 재시도). 트랜잭션 잠금(MARKER_DDL_LOCK)으로 줄 세운 뒤 0건
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { SOURCE, q, reachable } from "./harness.js";
import { markerDdl } from "../src/tables.js";

const DBN = "app_z77adv";
const up = await reachable(SOURCE);
const url = (() => { const u = new URL(SOURCE.adminUrl); u.pathname = `/${DBN}`; return u.toString(); })();

before(async () => { if (!up) return; await q(SOURCE, `DROP DATABASE IF EXISTS ${DBN} WITH (FORCE)`); await q(SOURCE, `CREATE DATABASE ${DBN}`); });
after(async () => { if (up) await q(SOURCE, `DROP DATABASE IF EXISTS ${DBN} WITH (FORCE)`).catch(() => {}); });

test("표지 DDL 8개 동시 → 오류 0 (20회 반복, 매번 _repl 지우고)", { skip: up ? false : "복제 시험 Postgres 없음" }, async () => {
  const cs = await Promise.all(Array.from({ length: 8 }, async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }));
  try {
    for (let round = 0; round < 20; round++) {
      await cs[0]!.query("DROP SCHEMA IF EXISTS _repl CASCADE");
      const r = await Promise.allSettled(cs.map((c) => c.query(markerDdl())));
      const bad = r.filter((x) => x.status === "rejected").map((x) => (x as PromiseRejectedResult).reason?.message);
      assert.deepEqual(bad, [], `회차 ${round}`);
    }
  } finally { await Promise.all(cs.map((c) => c.end())); }
});
