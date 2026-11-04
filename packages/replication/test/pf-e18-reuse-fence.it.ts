// PF-E18 (FM-APP-26·27): 지난 이전의 울타리가 남은 출발·도착을 다시 써도 sync 가 먼저 걷고 복제한다
// PF-E19 (FM-APP-22): 컷오버 전 도착에 앱이 직접 쓰면(시퀀스가 불림) 준비 안 됨 TARGET_LOCAL_WRITES. 진짜 Postgres 두 개
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Migration, appCanWrite, withClient } from "../src/index.js";
import { fence } from "../src/fence.js";
import { SOURCE, TARGET, TABLES, q, reachable, resetAndSeed } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "Postgres 두 개(55432/55433) 없음";
const m = new Migration({ key: "pfe18", source: SOURCE, target: TARGET, tables: TABLES });
const unRO = `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I RESET default_transaction_read_only', current_database()); END $$`;

before(async () => { if (up) await resetAndSeed(300); });
after(async () => {
  if (!up) return;
  await m.teardown().catch(() => undefined);
  for (const e of [SOURCE, TARGET]) await q(e, unRO).catch(() => undefined);
});

test("PF-E18: 출발·도착 둘 다 지난 울타리가 남아 있어도 sync 가 걷고(staleFences) 복제가 준비된다", { skip }, async () => {
  for (const e of [SOURCE, TARGET]) await withClient(e, (c) => fence(c, e));
  assert.equal(await withClient(SOURCE, (c) => appCanWrite(c, SOURCE, "orders")), false);
  const r = await m.sync();
  assert.deepEqual([...(r.staleFences ?? [])].sort(), ["dst", "src"]);
  assert.equal(r.gate.ready, true, r.gate.reasons.join(" | "));
  assert.equal(await withClient(SOURCE, (c) => appCanWrite(c, SOURCE, "orders")), true, "출발 앱이 다시 쓸 수 있다");
});

test("PF-E18 정상: 울타리 흔적이 없으면 아무것도 안 걷는다", { skip }, async () => {
  const r = await m.sync();
  assert.equal(r.staleFences, undefined);
  assert.equal(r.gate.ready, true, r.gate.reasons.join(" | "));
});

test("PF-E19 거부: 컷오버 전 도착에 직접 쓰면(시퀀스 불림) TARGET_LOCAL_WRITES 로 준비 안 됨", { skip }, async () => {
  await q(TARGET, `INSERT INTO customers(name) VALUES ('direct-on-target')`).catch(async () => {
    // 키가 겹치면 시퀀스만 불러 둔다 (FM-APP-22 duplicate key 와 같은 처지)
    await q(TARGET, `SELECT nextval(pg_get_serial_sequence('customers','id'))`);
  });
  const r = await m.sync();
  assert.equal(r.gate.ready, false);
  assert.ok(r.gate.reasons.some((x) => x.startsWith("TARGET_LOCAL_WRITES")), r.gate.reasons.join(" | "));
});

test("PF-E30 (hdd-09): 컷오버 마친 출발(read_only 는 풀리고 권한 회수만 남음)을 다시 써도 sync 가 저장본 흔적으로 걷는다", { skip }, async () => {
  await m.teardown();
  await resetAndSeed(300);
  const first = new Migration({ key: "pfe30a", source: SOURCE, target: TARGET, tables: TABLES });
  assert.equal((await first.sync()).gate.ready, true);
  assert.equal((await first.cutover()).ok, true);
  await first.teardown();
  assert.equal(await withClient(SOURCE, (c) => appCanWrite(c, SOURCE, "orders")), false, "옛 출발은 쓰기 회수 상태");
  // 같은 출발로 새 이전 (도착은 비운다)
  await q(TARGET, `TRUNCATE orders, customers`);
  await q(TARGET, unRO).catch(() => undefined);
  const again = new Migration({ key: "pfe30b", source: SOURCE, target: TARGET, tables: TABLES });
  try {
    const r = await again.sync();
    assert.ok(r.staleFences?.includes("src"), JSON.stringify(r.staleFences));
    assert.equal(await withClient(SOURCE, (c) => appCanWrite(c, SOURCE, "orders")), true);
  } finally { await again.teardown().catch(() => undefined); }
});
