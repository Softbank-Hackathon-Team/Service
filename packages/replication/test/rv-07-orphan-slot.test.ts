// RV-07: 구독 만들기 중간에 끊겨 출발에 슬롯만 남은 경우, 다시 sync 하면 그 슬롯을 지우고 새로 만든다 (42710 slot already exists 반복 방지)
import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { startForwardOn } from "../src/replicate.js";
import { endpointFromEnv } from "../src/index.js";

type Q = { sql: string; params?: unknown[] };
function fake(answer: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number }) {
  const log: Q[] = [];
  const c = { query: async (sql: string, params?: unknown[]) => { log.push({ sql, ...(params ? { params } : {}) }); return answer(sql, params); } };
  return { c: c as unknown as pg.Client, log };
}
const src = endpointFromEnv("REPL_SOURCE", { REPL_SOURCE_URL: "postgres://a:b@src:5432/x" });
const T = [{ schema: "public", name: "orders" }];

function target(subExists: boolean) {
  return fake((sql) => {
    if (sql.includes("FROM pg_subscription WHERE subname=$1")) return { rows: subExists ? [{}] : [], rowCount: subExists ? 1 : 0 };
    if (sql.includes("current_setting('server_version_num')")) return [{ rows: [], rowCount: 0 }, { rows: [{ e: subExists, v: "160004" }], rowCount: 1 }] as never;
    return { rows: [], rowCount: 0 };
  });
}

test("RV-07 구독이 없고 쓰는 사람 없는 같은 이름 슬롯이 남아 있으면 지운 뒤 CREATE SUBSCRIPTION", async () => {
  const s = fake((sql) => sql.startsWith("SELECT active FROM pg_replication_slots") ? { rows: [{ active: false }], rowCount: 1 } : { rows: [], rowCount: 0 });
  const d = target(false);
  await startForwardOn(s.c, d.c, src, "repl_m1_fwd", T);
  const drop = s.log.findIndex((q) => q.sql.includes("pg_drop_replication_slot"));
  assert.ok(drop >= 0, "남은 슬롯을 안 지움");
  assert.deepEqual(s.log[drop]!.params, ["repl_m1_fwd"]);
  assert.ok(d.log.some((q) => q.sql.includes("CREATE SUBSCRIPTION")));
});

test("RV-07 슬롯을 누가 쓰고 있거나(active) 구독이 이미 있으면 안 지운다", async () => {
  const s1 = fake((sql) => sql.startsWith("SELECT active FROM pg_replication_slots") ? { rows: [{ active: true }], rowCount: 1 } : { rows: [], rowCount: 0 });
  await startForwardOn(s1.c, target(false).c, src, "repl_m1_fwd", T);
  assert.equal(s1.log.some((q) => q.sql.includes("pg_drop_replication_slot")), false);
  const s2 = fake(() => ({ rows: [{ active: false }], rowCount: 1 }));
  const d2 = target(true);
  await startForwardOn(s2.c, d2.c, src, "repl_m1_fwd", T);
  assert.equal(s2.log.some((q) => q.sql.includes("pg_replication_slots")), false);
  assert.ok(d2.log.some((q) => q.sql.includes("ENABLE")));
});
