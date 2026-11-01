// 실제 복제 통합 테스트. 먼저: npm run db:up  (docker-compose.test.yml 의 Postgres 두 대)
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Migration, appCanWrite, markerLagMs, withClient, checksum, writableTables, type TableRef } from "../src/index.js";
import { dropSlotIfIdle } from "../src/replicate.js";
import { Router, SOURCE, TABLES, TARGET, q, reachable, resetAndSeed, sleep, startLoad, appUrl } from "./harness.js";
import pg from "pg";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "docker Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const m = new Migration({ key: "it01", source: SOURCE, target: TARGET, tables: TABLES, gate: { maxLagMs: 1000, consecutive: 3 } });
const refs: TableRef[] = TABLES.map((name) => ({ schema: "public", name }));
const log = (...a: unknown[]) => console.log("   ", ...a);

async function waitSame(timeoutMs = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const a = await withClient(SOURCE, async (c) => Promise.all(refs.map((t) => checksum(c, t))));
    const b = await withClient(TARGET, async (c) => Promise.all(refs.map((t) => checksum(c, t))));
    if (a.every((x, k) => x === b[k])) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) assert.fail(`checksums differ after ${timeoutMs}ms`);
    await sleep(100);
  }
}
async function appInsert(e: typeof SOURCE) {
  const c = new pg.Client({ connectionString: appUrl(e) }); await c.connect();
  try { await c.query(`INSERT INTO orders(customer_id, amount, note) VALUES (1, 1, 'probe')`); return "ok"; }
  catch (err) { return (err as Error).message; } finally { await c.end(); }
}

before(async () => { if (up) await resetAndSeed(2000); });
after(async () => { if (up) await m.teardown().catch(() => {}); });

test("1 점검: 기본키 없는 표를 잡고, 대상 표만 고르면 통과", { skip }, async () => {
  const all = await new Migration({ key: "it01", source: SOURCE, target: TARGET }).precheck();
  const t2 = all.checks.find((c) => c.id === "DB-T2")!;
  assert.equal(t2.ok, false); assert.match(t2.detail, /audit_log/);
  const pc = await m.precheck();
  assert.equal(pc.ok, true, JSON.stringify(pc.checks.filter((c) => !c.ok)));
});

test("2~5 복제 → 판정 → 전환 → 역방향 → 롤백 (쓰기 부하 중, 실패 0)", { skip }, async () => {
  const router = new Router(SOURCE);
  const load = startLoad(router, 6, "it");
  await sleep(300);

  // 2 초기 스냅샷 + 따라잡기 (부하 중에 시작)
  const s = await m.sync();
  log("sync", s.created, s.copy, s.gate, s.measures.map((x) => `${x.name}=${x.value}${x.unit}`).join(" "));
  assert.equal(s.created, true); assert.equal(s.copy.done, true);
  assert.equal(s.gate.ready, true, s.gate.reasons.join());
  assert.equal(await m.phase(), "forward");
  const again = await m.sync({ samples: 3 });
  assert.equal(again.created, false, "두 번 불러도 새로 만들지 않음");

  // 3 전환: 출발 울타리 → 마지막 따라잡기 → 시퀀스 → 대상 승격
  const maxSrcId = Number((await q(SOURCE, `SELECT max(id) m FROM orders`))[0].m);
  const cut = await m.cutover({ hooks: router });
  log("cutover", cut.ok, cut.measures.map((x) => `${x.name}=${x.value}`).join(" "));
  assert.equal(cut.ok, true);
  assert.equal(router.writer, TARGET);
  assert.equal(await m.phase(), "reverse");
  await sleep(500);
  assert.equal(load.fail, 0, JSON.stringify(load.errors));
  // 옛 출발은 앱이 못 쓴다, 새 주인은 쓴다
  assert.equal(await withClient(SOURCE, (c) => appCanWrite(c, SOURCE, "orders")), false);
  assert.match(await appInsert(SOURCE), /permission denied/);
  assert.equal(await appInsert(TARGET), "ok");
  // 시퀀스가 앞으로 밀려서 도착에서 새로 받은 id가 출발 max보다 크다
  const newId = Number((await q(TARGET, `SELECT max(id) m FROM orders`))[0].m);
  assert.ok(newId > maxSrcId + 999, `${newId} > ${maxSrcId}+1000`);
  // 4 역방향: 도착에 쓴 것이 출발에도 보인다 (롤백 대비)
  const revLag = await withClient(TARGET, (t) => withClient(SOURCE, (src) => markerLagMs(t, src)));
  log("reverse marker lag ms", revLag.toFixed(1));
  assert.ok(revLag < 1000);

  // 5 롤백: 같은 함수로 방향만 반대
  const rb = await m.rollback({ hooks: router });
  log("rollback", rb.kind, rb.result?.ok, rb.result?.measures.filter((x) => x.name === "cutover_pause_ms").map((x) => x.value));
  assert.equal(rb.kind, "after_cutover"); assert.equal(rb.result?.ok, true);
  assert.equal(router.writer, SOURCE);
  assert.equal(await m.phase(), "forward");
  await sleep(500);
  await load.stop();
  assert.equal(load.fail, 0, JSON.stringify(load.errors));
  log("load", { ok: load.ok, fail: load.fail });
  // 부하가 넣은 모든 행이 출발에 있다 (도착 시절에 쓴 것 포함 = RPO 0)
  await waitSame();
  const have = new Set((await q(SOURCE, `SELECT id FROM orders WHERE note='it'`)).map((r) => Number(r.id)));
  assert.equal(load.ids.filter((id) => !have.has(id)).length, 0);
  assert.equal(await appInsert(SOURCE), "ok");
  assert.match(await appInsert(TARGET), /permission denied/);
});

test("6 따라잡기 실패 → C6' 되돌림: 출발이 그대로 주인, 실패 0", { skip }, async () => {
  const router = new Router(SOURCE);
  const load = startLoad(router, 4, "abort");
  await q(TARGET, `ALTER SUBSCRIPTION ${m.names.fwd} DISABLE`);   // 복제를 일부러 멈춰 마커가 못 오게
  const r = await m.cutover({ hooks: router, maxCatchupMs: 300 });
  log("abort", r.ok, !r.ok && r.reason, Math.round(r.pauseMs), "ms");
  assert.equal(r.ok, false); assert.equal(!r.ok && r.reason, "CATCHUP_TIMEOUT");
  assert.equal(router.writer, SOURCE);
  await sleep(300); await load.stop();
  assert.equal(load.fail, 0, JSON.stringify(load.errors));
  assert.equal(await appInsert(SOURCE), "ok");
  await q(TARGET, `ALTER SUBSCRIPTION ${m.names.fwd} ENABLE`);
  await waitSame(15_000);
});

test("6b 울타리가 안 먹음(다른 역할로 받은 쓰기 권한) → FENCE_INEFFECTIVE C6' 되돌림 (Z10 L4)", { skip }, async () => {
  // 앱 계정이 그룹 역할을 거쳐 orders 쓰기 권한을 받은 상태. REVOKE ... FROM app_user로는 안 걷힌다
  await q(SOURCE, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_writers') THEN CREATE ROLE app_writers NOLOGIN; END IF; END $$;
    GRANT INSERT ON orders TO app_writers; GRANT app_writers TO app_user`);
  try {
    const router = new Router(SOURCE);
    const r = await m.cutover({ hooks: router, maxCatchupMs: 2000 });
    log("fence leak", r.ok, !r.ok && r.reason, !r.ok && r.detail);
    assert.equal(r.ok, false); assert.equal(!r.ok && r.reason, "FENCE_INEFFECTIVE");
    assert.match(!r.ok ? r.detail : "", /orders/);
    assert.equal(router.writer, SOURCE, "출발이 그대로 주인");
    assert.equal(await m.phase(), "forward", "정방향 복제는 그대로");
    assert.equal(await appInsert(SOURCE), "ok", "울타리 걷힘: 앱이 다시 쓴다");
  } finally {
    await q(SOURCE, `REVOKE app_writers FROM app_user; REVOKE ALL ON orders FROM app_writers; DROP ROLE app_writers`);
  }
  // 확인 함수 자체: 울타리 없는 지금은 앱 계정이 두 표 모두 쓸 수 있다
  assert.equal((await withClient(SOURCE, (c) => writableTables(c, SOURCE, refs))).length, 2);
  await waitSame(15_000);
});

test("6c dropSlotIfIdle: 없는 슬롯은 false, 쉬는 슬롯은 지움 (Z10 L2)", { skip }, async () => {
  await withClient(SOURCE, async (c) => {
    assert.equal(await dropSlotIfIdle(c, "z23_none"), false);
    await c.query(`SELECT pg_create_logical_replication_slot('z23_idle', 'pgoutput')`);
    assert.equal(await dropSlotIfIdle(c, "z23_idle", { waitMs: 200 }), true);
    assert.equal((await c.query(`SELECT 1 FROM pg_replication_slots WHERE slot_name='z23_idle'`)).rowCount, 0);
  });
});

test("7 정리: 양쪽에 슬롯·발행·구독이 하나도 안 남음", { skip }, async () => {
  const r = await m.teardown();
  log("removed", r.removed);
  assert.deepEqual(await m.leftovers(), []);
  assert.equal(await m.phase(), "idle");
});
