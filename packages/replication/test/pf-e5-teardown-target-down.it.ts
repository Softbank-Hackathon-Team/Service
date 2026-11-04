// PF-E5 (FM-APP-14): 도착 DB 가 없어졌거나 못 닿아도 teardown 이 출발 슬롯·발행을 걷는다 (예전: 도착에서 먼저 던져 출발이 그대로 남음)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Migration } from "../src/index.js";
import { SOURCE, TARGET, TABLES, q, reachable, resetAndSeed } from "./harness.js";

let skip: string | false = false;
const key = "pfe5";
const live = new Migration({ key, source: SOURCE, target: TARGET, tables: TABLES });
// 같은 이름표, 도착만 못 닿는 주소 (down 으로 지워진 RDS 와 같은 처지)
const gone = new Migration({ key, source: SOURCE, target: { ...TARGET, adminUrl: "postgres://postgres:postgres@127.0.0.1:1/app" }, tables: TABLES });

before(async () => {
  if (!(await reachable(SOURCE)) || !(await reachable(TARGET))) { skip = "DB 두 개 없음"; return; }
  await resetAndSeed(50);
});
after(async () => {
  if (skip) return;
  // 도착에 남긴 구독은 슬롯 없이 지운다 (출발 슬롯은 이미 걷힘)
  for (const s of await q(TARGET, `SELECT subname FROM pg_subscription WHERE subname = $1`, [live.names.fwd])) {
    await q(TARGET, `ALTER SUBSCRIPTION "${s.subname}" DISABLE`);
    await q(TARGET, `ALTER SUBSCRIPTION "${s.subname}" SET (slot_name = NONE)`);
    await q(TARGET, `DROP SUBSCRIPTION "${s.subname}"`);
  }
  await live.teardown().catch(() => undefined);
});

test("PF-E5: 도착이 안 닿아도 출발 슬롯·발행은 걷고, 못 걷은 쪽은 이유와 함께 던진다", async (t) => {
  if (skip) return t.skip(skip);
  const r = await live.sync();
  assert.equal(r.gate.ready, true, r.gate.reasons.join());
  // 도착이 멈춘 것처럼: 구독 작업자를 세워 출발 슬롯을 놓게 한다
  await q(TARGET, `ALTER SUBSCRIPTION ${live.names.fwd} DISABLE`);
  for (let i = 0; i < 50; i++) {
    const a = await q(SOURCE, `SELECT active FROM pg_replication_slots WHERE slot_name=$1`, [live.names.fwd]);
    if (a[0] && !a[0].active) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const e = await gone.teardown().then(() => null, (x: Error & { removed?: string[] }) => x);
  assert.ok(e, "도착을 못 걷었으니 던진다");
  assert.match(e!.message, /teardown partial: dst/);
  assert.ok(e!.removed?.includes(`src:slot:${live.names.fwd}`), e!.message);
  assert.ok(e!.removed?.includes(`src:publication:${live.names.fwd}`), e!.message);
  const left = await q(SOURCE, `SELECT slot_name FROM pg_replication_slots WHERE slot_name LIKE $1
                                UNION ALL SELECT pubname FROM pg_publication WHERE pubname LIKE $1`, [`repl_${key}%`]);
  assert.deepEqual(left, [], "출발에 남은 복제 객체 0");
});

test("PF-E5 정상: 두 쪽 다 닿으면 예전처럼 던지지 않고 removed 만", async (t) => {
  if (skip) return t.skip(skip);
  const r = await new Migration({ key: "pfe5b", source: SOURCE, target: TARGET, tables: TABLES }).teardown();
  assert.deepEqual(r.removed, []);
});

test("PF-E5 거울 (FM-APP-23): 컷오버 뒤 출발이 안 닿아도 도착의 역방향 슬롯·발행은 걷는다 (도착 WAL 이 안 쌓이게)", async (t) => {
  if (skip) return t.skip(skip);
  const k = "pfe5c";
  const mk = new Migration({ key: k, source: SOURCE, target: TARGET, tables: TABLES });
  // 역방향(도착 → 출발) 발행·슬롯이 도착에 있고, 출발 구독자는 사라진 상황
  await q(TARGET, `CREATE PUBLICATION ${mk.names.rev} FOR TABLE ${TABLES.join(", ")}`);
  await q(TARGET, `SELECT pg_create_logical_replication_slot($1, 'pgoutput')`, [mk.names.rev]);
  const srcGone = new Migration({ key: k, source: { ...SOURCE, adminUrl: "postgres://postgres:postgres@127.0.0.1:1/app" }, target: TARGET, tables: TABLES });
  const e = await srcGone.teardown().then(() => null, (x: Error & { removed?: string[] }) => x);
  assert.ok(e, "출발을 못 걷었으니 던진다");
  assert.match(e!.message, /teardown partial: src/);
  assert.ok(e!.removed?.includes(`dst:slot:${mk.names.rev}`), e!.message);
  assert.ok(e!.removed?.includes(`dst:publication:${mk.names.rev}`), e!.message);
  const left = await q(TARGET, `SELECT slot_name FROM pg_replication_slots WHERE slot_name = $1 UNION ALL SELECT pubname FROM pg_publication WHERE pubname = $1`, [mk.names.rev]);
  assert.deepEqual(left, [], "도착에 남은 역방향 복제 객체 0");
});

test("PF-E21 (FM-APP-14): 컷오버 전 도착이 안 닿아도 rollback 은 before_cutover 로 끝나고 출발 슬롯·발행을 걷는다", async (t) => {
  if (skip) return t.skip(skip);
  const k = "pfe5d";
  await resetAndSeed(50);
  const ok = new Migration({ key: k, source: SOURCE, target: TARGET, tables: TABLES });
  assert.equal((await ok.sync()).gate.ready, true);
  await q(TARGET, `ALTER SUBSCRIPTION ${ok.names.fwd} DISABLE`);
  for (let i = 0; i < 50; i++) {
    const a = await q(SOURCE, `SELECT active FROM pg_replication_slots WHERE slot_name=$1`, [ok.names.fwd]);
    if (a[0] && !a[0].active) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const down = new Migration({ key: k, source: SOURCE, target: { ...TARGET, adminUrl: "postgres://postgres:postgres@127.0.0.1:1/app" }, tables: TABLES });
  const r = await down.rollback();
  assert.equal(r.kind, "before_cutover");
  assert.equal(r.targetUnreachable, true);
  const left = await q(SOURCE, `SELECT slot_name FROM pg_replication_slots WHERE slot_name LIKE $1 UNION ALL SELECT pubname FROM pg_publication WHERE pubname LIKE $1`, [`repl_${k}%`]);
  assert.deepEqual(left, []);
  // 도착에 남은 구독은 슬롯 없이 지운다
  await q(TARGET, `ALTER SUBSCRIPTION ${ok.names.fwd} SET (slot_name = NONE)`);
  await q(TARGET, `DROP SUBSCRIPTION ${ok.names.fwd}`);
});

test("PF-E21 거부: 출발도 안 닿으면 예전처럼 던진다", async (t) => {
  if (skip) return t.skip(skip);
  const bad = { adminUrl: "postgres://postgres:postgres@127.0.0.1:1/app" };
  const both = new Migration({ key: "pfe5e", source: { ...SOURCE, ...bad }, target: { ...TARGET, ...bad }, tables: TABLES });
  await assert.rejects(() => both.rollback());
});

test("PF-E29 (hdd-08): 도착이 워커에선 안 닿지만 살아서 구독이 붙어 있어도 출발 슬롯을 걷는다 (예전: active 라 조용히 남음)", async (t) => {
  if (skip) return t.skip(skip);
  const k = "pfe5f";
  await resetAndSeed(50);
  const ok = new Migration({ key: k, source: SOURCE, target: TARGET, tables: TABLES });
  assert.equal((await ok.sync()).gate.ready, true);
  const [a] = await q(SOURCE, `SELECT active FROM pg_replication_slots WHERE slot_name=$1`, [ok.names.fwd]);
  assert.equal(a.active, true, "구독이 붙어 있는 상태에서 시작");
  const blind = new Migration({ key: k, source: SOURCE, target: { ...TARGET, adminUrl: "postgres://postgres:postgres@127.0.0.1:1/app" }, tables: TABLES });
  const e = await blind.teardown().then(() => null, (x: Error & { removed?: string[] }) => x);
  assert.ok(e && /teardown partial: dst/.test(e.message), e?.message);
  assert.ok(e!.removed?.includes(`src:slot:${ok.names.fwd}`), e!.message);
  assert.deepEqual(await q(SOURCE, `SELECT slot_name FROM pg_replication_slots WHERE slot_name LIKE $1`, [`repl_${k}%`]), []);
  await q(TARGET, `ALTER SUBSCRIPTION ${ok.names.fwd} DISABLE`);
  await q(TARGET, `ALTER SUBSCRIPTION ${ok.names.fwd} SET (slot_name = NONE)`);
  await q(TARGET, `DROP SUBSCRIPTION ${ok.names.fwd}`);
});
