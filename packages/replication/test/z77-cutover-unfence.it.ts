// Z77 (Z62 주제 60, 맥 실측 00:01Z CUTOVER_HALFWAY): 전환이 C5 뒤·C6 전에 깨져도 출발 울타리가 걷힌다 (실패 주입)
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Migration, SwitchoverError, appCanWrite, switchover, unfence, withClient, type TableRef } from "../src/index.js";
import { SOURCE, TABLES, TARGET, reachable, resetAndSeed } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "docker Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const m = new Migration({ key: "z77cu", source: SOURCE, target: TARGET, tables: TABLES, gate: { maxLagMs: 1000, consecutive: 3 } });
const refs: TableRef[] = TABLES.map((name) => ({ schema: "public", name }));

// R8-47 시험은 도착을 울타리 친 채 끝난다 → 다음 시험 파일을 위해 걷고 정리
after(async () => { if (up) { await withClient(TARGET, (c) => unfence(c, TARGET)).catch(() => undefined); await m.teardown().catch(() => undefined); } });

for (const at of ["c4_sequences", "c5_slots"]) {
  test(`${at} 에서 깨지면 출발 울타리가 걷히고 앱이 출발에 다시 쓸 수 있다`, { skip }, async () => {
    await m.teardown().catch(() => undefined);
    await resetAndSeed(500);   // 앞 시험이 도착에 남긴 행을 비운다 (초기 복사는 빈 표를 가정)
    const s = await m.sync();
    assert.equal(s.gate.ready, true, s.gate.reasons.join(","));
    const err = await switchover({ from: SOURCE, to: TARGET, current: m.names.fwd, reverse: m.names.rev, tables: refs,
      onStep: (step) => { if (step === at) throw new Error(`injected at ${at}`); } }).then(() => null, (e) => e);
    assert.ok(err instanceof SwitchoverError, String(err));
    assert.equal(err.step, at);
    assert.equal(err.unfenced, true, err.message);
    assert.equal(err.pastNoReturn, at === "c5_slots");
    assert.equal(await withClient(SOURCE, (c) => appCanWrite(c, SOURCE, "orders")), true, "출발 앱 계정이 다시 쓸 수 있어야 함");
    const ro = await withClient(SOURCE, async (c) => (await c.query(`SELECT setting FROM pg_settings WHERE name = 'default_transaction_read_only'`)).rows[0]?.setting);
    assert.notEqual(ro, "on");
    // Z38 R8-47: C5 뒤 실패면 도착에 만든 역방향 슬롯을 남기지 않는다
    if (at === "c5_slots") {
      const left = await withClient(TARGET, async (c) => (await c.query(`SELECT count(*)::int n FROM pg_replication_slots WHERE slot_name = $1`, [m.names.rev])).rows[0].n);
      assert.equal(left, 0, "역방향 슬롯이 남았다");
    }
  });
}

test("Z38 R8-47: C6 resume(to) 도중 깨지면 도착을 다시 울타리 치고 출발만 쓰기 가능", { skip }, async () => {
  await m.teardown().catch(() => undefined);
  await resetAndSeed(500);
  assert.equal((await m.sync()).gate.ready, true);
  const hooks = { pause: async () => {}, resume: async (e: { label: string }) => { if (e.label === TARGET.label) throw new Error("proxy flipped, then lost the reply"); } };
  const err = await switchover({ from: SOURCE, to: TARGET, current: m.names.fwd, reverse: m.names.rev, tables: refs, hooks }).then(() => null, (e) => e);
  assert.ok(err instanceof SwitchoverError, String(err));
  assert.equal(err.pastNoReturn, true);
  assert.equal(err.unfenced, true, err.message);
  assert.equal(await withClient(SOURCE, (c) => appCanWrite(c, SOURCE, "orders")), true, "출발은 쓰기 가능");
  assert.equal(await withClient(TARGET, (c) => appCanWrite(c, TARGET, "orders")), false, "도착은 다시 막혀야 한다 (두 쪽 쓰기 방지)");
});
