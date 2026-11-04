// PF-E1: 사전 점검 단계에서 출발 DB 만 보고 논리 복제가 될지 판정 (자원 만들기 전). 진짜 Postgres 두 개(harness)로 돈다
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { precheckSource } from "../src/index.js";
import { SOURCE, TABLES, appUrl, q, reachable, resetAndSeed } from "./harness.js";

let skip: string | false = false;
before(async () => {
  if (!(await reachable(SOURCE))) { skip = "출발 DB 없음 (IT_SOURCE_URL)"; return; }
  await resetAndSeed(10);
});

test("PF-E1: 기본키 없는 표(audit_log)가 있으면 출발만 봐도 DB-T2 로 실패 (sync 첫 점검과 같은 규칙)", async (t) => {
  if (skip) return t.skip(skip);
  const r = await precheckSource(SOURCE);
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.id === "DB-T2" && !c.ok && /audit_log/.test(c.detail)), JSON.stringify(r.checks));
  assert.ok(r.checks.some((c) => c.id === "DB-01" && c.ok), "wal_level=logical");
});

test("PF-E1 정상: 옮길 표를 고르면(기본키 있음) 통과, 도착은 안 본다", async (t) => {
  if (skip) return t.skip(skip);
  const r = await precheckSource(SOURCE, { tables: TABLES });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.ok(r.checks.every((c) => c.side === "source"));
});

test("PF-E1 거부: 복제 권한 없는 계정(app_user)이면 DB-04 실패", async (t) => {
  if (skip) return t.skip(skip);
  const r = await precheckSource({ ...SOURCE, adminUrl: appUrl(SOURCE) }, { tables: TABLES });
  assert.ok(r.checks.some((c) => c.id === "DB-04" && !c.ok), JSON.stringify(r.checks));
  assert.equal(r.ok, false);
});

test("PF-E27 (hdd-05): 기본키가 있어도 REPLICA IDENTITY NOTHING 이면 DB-T2 실패, DEFAULT 로 되돌리면 통과", async (t) => {
  if (skip) return t.skip(skip);
  await q(SOURCE, `ALTER TABLE orders REPLICA IDENTITY NOTHING`);
  try {
    const r = await precheckSource(SOURCE, { tables: ["orders"] });
    const c = r.checks.find((x) => x.id === "DB-T2")!;
    assert.equal(c.ok, false, c.detail);
    assert.match(c.detail, /orders/);
  } finally { await q(SOURCE, `ALTER TABLE orders REPLICA IDENTITY DEFAULT`); }
  const ok = await precheckSource(SOURCE, { tables: ["orders"] });
  assert.equal(ok.checks.find((x) => x.id === "DB-T2")!.ok, true);
});

test("PF-E31 (hdd-10): 복제 스키마 밖(shop)에 앱 표가 있으면 DB-T7 실패, 없애면 통과", async (t) => {
  if (skip) return t.skip(skip);
  await q(SOURCE, `CREATE SCHEMA IF NOT EXISTS pfe31shop; CREATE TABLE IF NOT EXISTS pfe31shop.items (id int primary key)`);
  try {
    const r = await precheckSource(SOURCE, { tables: TABLES });
    const c = r.checks.find((x) => x.id === "DB-T7")!;
    assert.equal(c.ok, false, c.detail);
    assert.match(c.detail, /pfe31shop\(1\)/);
    assert.equal(r.ok, false);
  } finally { await q(SOURCE, `DROP SCHEMA pfe31shop CASCADE`); }
  assert.equal((await precheckSource(SOURCE, { tables: TABLES })).checks.find((x) => x.id === "DB-T7")!.ok, true);
});
