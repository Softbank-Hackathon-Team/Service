import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GATE, judgeCutoverReady, namesFor, type LagSample } from "../src/index.js";
import { assertName } from "../src/sql.js";

const s = (ms: number, worker = true, bytes = 0): LagSample => ({ markerMs: ms, slot: { bytes, active: true, workerRunning: worker } });
const done = { tables: 3, ready: 3, states: { r: 3 }, done: true };

test("판정: 초기 복사 끝 + 지연 3번 연속 기준 아래면 전환 가능", () => {
  const r = judgeCutoverReady(done, [s(5000), s(20), s(30), s(40)]);
  assert.equal(r.ready, true);
  assert.deepEqual(r.lastLags, [20, 30, 40]);
});

test("판정: 마지막 3번 중 하나라도 느리면 불가", () => {
  const r = judgeCutoverReady(done, [s(20), s(1500), s(30)]);
  assert.equal(r.ready, false);
  assert.match(r.reasons.join(), /LAG_OVER_LIMIT/);
});

test("판정: 초기 복사 중이면 불가, 이유에 진행률", () => {
  const r = judgeCutoverReady({ tables: 3, ready: 1, states: { r: 1, d: 2 }, done: false }, []);
  assert.equal(r.ready, false);
  assert.match(r.reasons.join(), /INITIAL_COPY_NOT_DONE 1\/3/);
});

test("판정: 적용 워커가 멈췄거나 슬롯 지연이 크면 불가", () => {
  assert.match(judgeCutoverReady(done, [s(1), s(1), s(1, false)]).reasons.join(), /APPLY_WORKER_NOT_RUNNING/);
  assert.match(judgeCutoverReady(done, [s(1), s(1), s(1, true, DEFAULT_GATE.maxSlotBytes! + 1)]).reasons.join(), /SLOT_LAG_OVER_LIMIT/);
});

test("이름: 이전 키에서 방향별 이름, 위험한 문자는 막힘", () => {
  assert.deepEqual(namesFor("mig-01"), { fwd: "repl_mig_01_fwd", rev: "repl_mig_01_rev" });
  assert.throws(() => assertName('x"; DROP TABLE t; --'));
  assert.deepEqual(namesFor("9ABC-0d"), { fwd: "repl_9abc_0d_fwd", rev: "repl_9abc_0d_rev" });   // uuid는 숫자로 시작 가능
  assert.equal(namesFor("a99dda60-4dcb-4ee3-a3cc-605c0f0534af").fwd.length <= 63, true);
  assert.throws(() => namesFor(""));
});

// Z52 (Q16): 슬롯 WAL 안전장치 판정
const w = (walStatus: string | null, safeWalBytes: number | null = null): LagSample =>
  ({ markerMs: 10, slot: { bytes: 0, active: true, workerRunning: true, walStatus, safeWalBytes } });
const copied = { tables: 2, ready: 2, states: { r: 2 }, done: true };

test("Z52 슬롯이 lost면 보류 + fatal (재시도해도 소용없음)", () => {
  const r = judgeCutoverReady(copied, [w("reserved"), w("reserved"), w("lost")]);
  assert.equal(r.ready, false); assert.equal(r.fatal, true); assert.match(r.reasons.join(), /SLOT_LOST/);
});
test("Z52 unreserved면 보류, fatal 아님", () => {
  const r = judgeCutoverReady(copied, [w("reserved"), w("unreserved"), w("reserved")]);
  assert.equal(r.ready, false); assert.equal(r.fatal, undefined); assert.match(r.reasons.join(), /SLOT_WAL_UNRESERVED/);
});
test("Z52 safe_wal_size가 64MB 미만이면 보류, null(무제한)이면 통과", () => {
  assert.match(judgeCutoverReady(copied, [w("reserved", 1e9), w("reserved", 1e9), w("extended", 1024)]).reasons.join(), /SLOT_SAFE_WAL_LOW/);
  assert.equal(judgeCutoverReady(copied, [w("reserved"), w("reserved"), w("reserved")]).ready, true);
  assert.equal(judgeCutoverReady(copied, [w("reserved", 1e9), w("reserved", 1e9), w("reserved", 1e9)]).ready, true);
});
