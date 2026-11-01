// Z36 (Z42 Q17): 쓰기 담당 바꾸기 도중 워커가 "죽으면"(catch가 안 도는 SIGKILL) 울타리를 누가 걷나.
// 죽음은 울타리만 치고 함수를 끝내지 않는 것으로 흉내 낸다 (fence()를 직접 부름 = C2 직후 SIGKILL과 같은 DB 모양).
// 먼저: npm run db:up (Postgres 두 대). 청소 작업 끝-끝 시험은 apps/worker/test/z36-fence-reaper.it.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { Migration, withClient, switchover, SwitchoverError, fence, unfence, type TableRef } from "../src/index.js";
import { SOURCE, TABLES, TARGET, appUrl, reachable, resetAndSeed } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "docker Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const m = new Migration({ key: "z36fence", source: SOURCE, target: TARGET, tables: TABLES, gate: { maxLagMs: 1000, consecutive: 3 } });
const refs: TableRef[] = TABLES.map((name) => ({ schema: "public", name }));

async function appInsert(e: typeof SOURCE) {
  const c = new pg.Client({ connectionString: appUrl(e) }); await c.connect();
  try { await c.query(`INSERT INTO orders(customer_id, amount, note) VALUES (1, 1, 'z36')`); return "ok"; }
  catch (err) { return (err as Error).message; } finally { await c.end(); }
}
const clearFence = (e: typeof SOURCE) => withClient(e, async (c) => { await c.query("SET default_transaction_read_only = off"); await unfence(c, e); });
const killedAfterFence = (e: typeof SOURCE) => withClient(e, (c) => fence(c, e));   // C2까지 하고 죽은 워커

before(async () => { if (up) { await resetAndSeed(300); await m.sync(); } });
after(async () => { if (up) { await clearFence(SOURCE).catch(() => {}); await clearFence(TARGET).catch(() => {}); await m.teardown().catch(() => {}); await resetAndSeed(10).catch(() => {}); } });

test("컷오버 C2 직후 워커 죽음(정방향 구독 남음) → 예전: 출발 읽기 전용 그대로 / 지금: recoverInterruptedSwitch가 출발 울타리를 걷음", { skip }, async () => {
  await killedAfterFence(SOURCE);
  assert.notEqual(await appInsert(SOURCE), "ok", "재현: 죽은 뒤 아무도 안 걷으면 출발은 쓰기 불가");
  const t0 = performance.now();
  const r = await m.recoverInterruptedSwitch("cutover");
  console.log(`[z36] recover cutover(forward): ${Math.round(performance.now() - t0)} ms ${JSON.stringify(r)}`);
  assert.equal(r.phase, "forward"); assert.equal(r.action, "unfenced_source");
  assert.equal(r.sourceWritable, true);
  assert.equal(await appInsert(SOURCE), "ok", "출발에 쓰기가 돌아옴");
  assert.equal(await m.phase(), "forward", "정방향 복제는 그대로 → 다시 컷오버 가능");
});

test("잠금 잃은 워커(signal abort)는 C5 직전에 멈춘다 → 스스로 출발 울타리를 걷고 SwitchoverError(pastNoReturn=false)", { skip }, async () => {
  const ac = new AbortController();
  const e = await switchover({ from: SOURCE, to: TARGET, current: m.names.fwd, reverse: m.names.rev, tables: refs, signal: ac.signal,
    onStep: (s) => { if (s === "c4_sequences") ac.abort(); } }).then(() => null, (x) => x);
  assert.ok(e instanceof SwitchoverError, `SwitchoverError 기대, 받은 것: ${e}`);
  assert.equal(e.pastNoReturn, false); assert.equal(e.unfenced, true);
  assert.equal(await appInsert(SOURCE), "ok");
  assert.equal(await m.phase(), "forward", "C5(정방향 구독 삭제)를 안 함");
});

test("컷오버 C5 뒤 죽음(정방향 구독 없음) → 손대지 않음(left_as_is): 출발에 쓰기를 돌려주면 그 쓰기가 도착에 안 간다", { skip }, async () => {
  // C5 직후 죽은 모양: 울타리 + 정방향 구독 삭제. Z19의 c5_slots 예외 시험과 같은 자리
  await switchover({ from: SOURCE, to: TARGET, current: m.names.fwd, reverse: m.names.rev, tables: refs,
    onStep: (s) => { if (s === "c5_slots") throw new Error("die after c5"); } }).catch(() => {});
  const r = await m.recoverInterruptedSwitch("cutover");
  console.log(`[z36] recover cutover(past C5): ${JSON.stringify(r)}`);
  assert.notEqual(r.phase, "forward"); assert.equal(r.action, "left_as_is");
  // Z77: 이 시험은 "죽음" 을 같은 프로세스 예외로 흉내 낸다. 이제 switchover 의 catch 가 C6 전이면 출발 울타리를 걷으므로 출발은 쓸 수 있다.
  //   청소(recoverInterruptedSwitch)의 판단은 그대로 left_as_is (진짜 SIGKILL 이면 catch 가 안 돌아 출발이 막힌 채 남고, 사람이 판단)
  assert.equal(r.sourceWritable, true, "같은 프로세스 예외면 switchover catch 가 이미 걷었다 (Z77)");
});

test("컷오버 뒤 롤백 C2 직후 죽음(역방향 구독 남음) → 도착(지금 주인) 울타리를 걷음", { skip }, async () => {
  // 새로 복제 → 정상 컷오버(역방향 구독이 출발에 생김) → 롤백이 도착에 울타리 치고 죽음
  await clearFence(SOURCE); await clearFence(TARGET); await m.teardown();
  await resetAndSeed(300); await m.sync();
  const ok = await m.cutover();
  assert.equal(ok.ok, true);
  assert.equal(await m.phase(), "reverse");
  assert.equal(await appInsert(TARGET), "ok", "컷오버 뒤 도착이 주인");
  await killedAfterFence(TARGET);
  assert.notEqual(await appInsert(TARGET), "ok", "재현: 롤백이 죽으면 도착(주인)이 쓰기 불가");
  const r = await m.recoverInterruptedSwitch("rolling_back");
  console.log(`[z36] recover rolling_back(reverse): ${JSON.stringify(r)}`);
  assert.equal(r.action, "unfenced_target"); assert.equal(r.targetWritable, true);
  assert.equal(await appInsert(TARGET), "ok");
  // 같은 상황에서 cutover로 부르면(단계 착각) 아무것도 안 한다: 역방향이면 C5 뒤로 본다
  assert.equal((await m.recoverInterruptedSwitch("cutover")).action, "left_as_is");
});
