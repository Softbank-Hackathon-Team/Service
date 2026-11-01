// Z19 H2 재현: 컷오버(switchover) 도중 예외가 나면 출발 DB 울타리(쓰기 금지)가 걷히나.
// 먼저: npm run db:up (Postgres 두 대). 예외는 onStep(단계 끝마다 불림)에서 던져 넣는다
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { Migration, appCanWrite, withClient, switchover, SwitchoverError, unfence, type TableRef } from "../src/index.js";
import { SOURCE, TABLES, TARGET, appUrl, reachable, resetAndSeed } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "docker Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const m = new Migration({ key: "z19h2", source: SOURCE, target: TARGET, tables: TABLES, gate: { maxLagMs: 1000, consecutive: 3 } });
const refs: TableRef[] = TABLES.map((name) => ({ schema: "public", name }));

// 앱 계정으로 실제로 한 줄 써 본다 (권한 + read_only 둘 다 본다)
async function appInsert(e: typeof SOURCE) {
  const c = new pg.Client({ connectionString: appUrl(e) }); await c.connect();
  try { await c.query(`INSERT INTO orders(customer_id, amount, note) VALUES (1, 1, 'z19')`); return "ok"; }
  catch (err) { return (err as Error).message; } finally { await c.end(); }
}
const boomAt = (step: string) => (s: string) => { if (s === step) throw new Error(`injected failure after ${step}`); };

before(async () => { if (up) { await resetAndSeed(500); await m.sync(); } });
// 마지막 시험이 출발을 울타리 친 채 두므로 되돌려 놓는다 (read_only 세션에서는 ALTER DATABASE가 안 돼서 세션 값을 먼저 끈다)
const clearFence = (e: typeof SOURCE) => withClient(e, async (c) => { await c.query("SET default_transaction_read_only = off"); await unfence(c, e); });
before(async () => { if (up) { await clearFence(SOURCE); await clearFence(TARGET); } });
after(async () => { if (up) { await clearFence(SOURCE).catch(() => {}); await m.teardown().catch(() => {}); } });

for (const step of ["c2_fence", "c3_catchup", "c4_sequences"]) {
  test(`H2 C5 전(${step} 직후) 예외 → SwitchoverError(pastNoReturn=false), 출발 울타리 걷힘, 앱이 출발에 다시 씀, 정방향 복제 그대로`, { skip }, async () => {
    assert.equal(await appInsert(SOURCE), "ok");
    const e = await switchover({ from: SOURCE, to: TARGET, current: m.names.fwd, reverse: m.names.rev, tables: refs,
      onStep: boomAt(step) }).then(() => null, (x) => x);
    assert.ok(e instanceof SwitchoverError, `SwitchoverError 기대, 받은 것: ${e}`);
    assert.equal(e.pastNoReturn, false);
    assert.equal(e.unfenced, true);
    assert.equal(await appInsert(SOURCE), "ok", "출발에 쓰기가 돌아와야 한다");
    assert.equal(await withClient(SOURCE, (c) => appCanWrite(c, SOURCE, "orders")), true);
    assert.equal(await m.phase(), "forward", "다시 컷오버할 수 있게 정방향 복제가 남아 있다");
  });
}

// Z77 (Z62 주제 60, 맥 실측 00:01Z): 예전 기대는 "C5 뒤면 출발 울타리 유지(사람이 판단)". C6(쓰기 대상 바꾸기) 전이면 앱은 아직 출발만 쓰고
//   도착은 앱 트래픽을 안 받아 갈라진 쓰기가 없다 → 이제 출발 울타리를 걷어 서비스를 살린다. 이 이전은 실패이고 새로 sync 해야 한다
test("H2 C5 뒤(c5_slots 직후, C6 전) 예외 → pastNoReturn=true, 출발 울타리는 걷힌다 (Z77)", { skip }, async () => {
  const e = await switchover({ from: SOURCE, to: TARGET, current: m.names.fwd, reverse: m.names.rev, tables: refs,
    onStep: boomAt("c5_slots") }).then(() => null, (x) => x);
  assert.ok(e instanceof SwitchoverError, `SwitchoverError 기대, 받은 것: ${e}`);
  assert.equal(e.pastNoReturn, true);
  assert.equal(e.unfenced, true, e.message);
  assert.equal(await appInsert(SOURCE), "ok", "C6 전이라 앱은 출발을 쓴다 → 출발이 다시 쓸 수 있어야 한다");
});
