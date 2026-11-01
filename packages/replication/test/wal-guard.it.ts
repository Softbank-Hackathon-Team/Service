// Z52 (모의 심사 Q16): "복제가 멈춰 출발 WAL이 쌓이면?" 을 진짜 Postgres로 재현한다.
// 출발에 max_slot_wal_keep_size를 작게 걸고 → 구독을 멈춘 채 WAL을 만든다 → 출발이 슬롯을 끊는지(lost),
// 판정이 SLOT_LOST + fatal을 내는지, 디스크(pg_wal)가 상한 근처에서 멈추는지 본다.
// 먼저: npm run db:up (docker-compose.test.yml) 또는 같은 포트의 Postgres 두 대
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Migration, judgeCutoverReady, precheck, slotLag, withClient } from "../src/index.js";
import { SOURCE, TABLES, TARGET, q, reachable, resetAndSeed, sleep } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const log = (...a: unknown[]) => console.log("   ", ...a);
const KEEP_MB = 64;

async function setKeep(v: string) {
  await q(SOURCE, `ALTER SYSTEM SET max_slot_wal_keep_size = '${v}'`);
  await q(SOURCE, `SELECT pg_reload_conf()`);
  await sleep(300);
}
async function walDirBytes() {
  return Number((await q(SOURCE, `SELECT coalesce(sum(size),0) n FROM pg_ls_waldir()`))[0].n);
}

before(async () => { if (up) await resetAndSeed(500); });
after(async () => {
  if (!up) return;
  await setKeep("-1").catch(() => {});
  await q(SOURCE, `ALTER SYSTEM RESET max_slot_wal_keep_size`).catch(() => {});
  await q(SOURCE, `SELECT pg_reload_conf()`).catch(() => {});
  await q(SOURCE, `ALTER SYSTEM RESET max_wal_size`).catch(() => {});
  await q(SOURCE, `SELECT pg_reload_conf()`).catch(() => {});
});

test("점검 DB-06: 무제한(-1)이면 권고(warn)로만 뜨고 전체 ok는 막지 않는다", { skip }, async () => {
  await setKeep("-1");
  const pc = await precheck(SOURCE, TARGET, { tables: TABLES });
  const c = pc.checks.find((x) => x.id === "DB-06")!;
  assert.equal(c.ok, false); assert.equal(c.level, "warn"); assert.equal(pc.ok, true);
  await setKeep(`${KEEP_MB}MB`);
  const c2 = (await precheck(SOURCE, TARGET, { tables: TABLES })).checks.find((x) => x.id === "DB-06")!;
  assert.equal(c2.ok, true); assert.match(c2.detail, /=64MB/);
});

// 한 바퀴: 복제 시작 → 구독 멈춤 → WAL 약 200MB 생성 → 체크포인트 → 슬롯 상태·pg_wal 크기
async function scenario(keep: string, key: string) {
  await resetAndSeed(500);
  await setKeep(keep);
  const mm = new Migration({ key, source: SOURCE, target: TARGET, tables: TABLES });
  try {
    const s = await mm.sync();
    assert.equal(s.gate.ready, true, s.gate.reasons.join());
    const fwd = mm.names.fwd;
    const slot = () => withClient(SOURCE, (a) => withClient(TARGET, (b) => slotLag(a, b, fwd)));
    const before = await slot();
    // 복제가 멈춘 상황 = 도착 구독 끄기 (네트워크 끊김·도착 장애와 같은 효과: 슬롯 확인 위치가 안 움직인다)
    await q(TARGET, `ALTER SUBSCRIPTION "${fwd}" DISABLE`);
    await sleep(500);
    const t0 = Date.now();
    for (let i = 0; i < 24; i++) {   // 약 8MB씩 24번 ≈ 200MB 이상 WAL
      await q(SOURCE, `INSERT INTO orders(customer_id, amount, note) SELECT 1, g, repeat('x', 900) FROM generate_series(1, 8000) g`);
      await q(SOURCE, `SELECT pg_switch_wal()`);
    }
    const mid = await slot();
    await q(SOURCE, `CHECKPOINT`); // 체크포인트가 상한을 넘긴 슬롯을 무효로 만들고 남는 WAL을 지운다
    await sleep(300);
    await q(SOURCE, `CHECKPOINT`);
    const end = await slot();
    const walMB = Math.round((await walDirBytes()) / 1e5) / 10;
    log(`keep=${keep}`, "before", JSON.stringify(before), "| mid", JSON.stringify(mid), "| end", JSON.stringify(end), `| pg_wal ${walMB}MB | ${Date.now() - t0}ms`);
    return { before, mid, end, walMB };
  } finally {
    await mm.teardown().catch(() => {});
  }
}

const results: Record<string, number> = {};

test("상한 64MB: 구독이 멈춘 채 WAL이 쌓이면 출발이 슬롯을 끊고(lost), 판정은 SLOT_LOST + fatal, pg_wal이 줄어든다", { skip, timeout: 180_000 }, async () => {
  await q(SOURCE, `ALTER SYSTEM SET max_wal_size = '64MB'`);   // 체크포인트가 남는 WAL을 바로 지우게 (기본 1GB면 재사용용으로 남긴다)
  const r = await scenario(`${KEEP_MB}MB`, "walg");
  assert.equal(r.before.walStatus, "reserved");
  assert.ok(r.before.safeWalBytes != null && r.before.safeWalBytes > 0);
  assert.equal(r.end.walStatus, "lost");
  const verdict = judgeCutoverReady({ tables: 2, ready: 2, states: { r: 2 }, done: true }, [0, 1, 2].map(() => ({ markerMs: 10, slot: r.end })));
  log("verdict", JSON.stringify(verdict));
  assert.equal(verdict.ready, false); assert.equal(verdict.fatal, true);
  results.guarded = r.walMB;
});

test("대조군 무제한(-1): 같은 양을 써도 슬롯은 살아 있고(extended) pg_wal에 전부 남는다", { skip, timeout: 180_000 }, async () => {
  const r = await scenario("-1", "walu");
  assert.notEqual(r.end.walStatus, "lost");
  assert.equal(r.end.safeWalBytes, null);
  results.unlimited = r.walMB;
  log("pg_wal MB", JSON.stringify(results));
  assert.ok(results.guarded! < results.unlimited, `guarded ${results.guarded}MB >= unlimited ${results.unlimited}MB`);
  await q(SOURCE, `ALTER SYSTEM RESET max_wal_size`); await q(SOURCE, `SELECT pg_reload_conf()`);
});
