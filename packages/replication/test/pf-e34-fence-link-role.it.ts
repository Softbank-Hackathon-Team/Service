// PF-E34 APP-22 (가) DECISION(team, 11/4 01:57Z): 도착 앱은 컷오버 전까지 출발에 전용 계정(svc_link_<8자>)으로 붙는다.
//   컷오버 울타리가 그 계정의 쓰기도 막고(회수·세션 끊기), 걷기(롤백)가 그대로 되돌린다. 계정이 없으면 건너뛴다. 진짜 Postgres 두 개
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { Migration, sourceLinkRoleOf, switchover, withClient, fence, unfence } from "../src/index.js";
import { SOURCE, TARGET, TABLES, q, reachable, resetAndSeed } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "Postgres 두 개(55432/55433) 없음";
const MID = "e34a1b2c-0000-4000-8000-000000000000";
const ROLE = sourceLinkRoleOf(MID);
const src = { ...SOURCE, fenceRoles: [ROLE] };
const m = new Migration({ key: "pfe34", source: src, target: TARGET, tables: TABLES });
const canInsert = async () => (await q(SOURCE, `SELECT has_table_privilege($1, 'public.orders', 'INSERT') ok`, [ROLE]))[0].ok as boolean;

before(async () => {
  if (!up) return;
  await resetAndSeed(300);
  await q(SOURCE, `DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
  await q(SOURCE, `CREATE ROLE ${ROLE} LOGIN PASSWORD 'e34pw'`);
  await q(SOURCE, `GRANT USAGE ON SCHEMA public TO ${ROLE}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
});
after(async () => {
  if (!up) return;
  await m.teardown().catch(() => undefined);
  await q(SOURCE, `DROP OWNED BY ${ROLE}; DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
});

test("PF-E34 정상: 이름 규칙 + 컷오버 울타리가 전용 계정 세션을 끊고 쓰기를 막고, 롤백이 권한을 되돌린다", { skip }, async () => {
  assert.equal(ROLE, "svc_link_e34a1b2c");
  // 도착 앱 흉내: 전용 계정으로 출발에 붙어 있음
  const u = new URL(SOURCE.adminUrl); u.username = ROLE; u.password = "e34pw";
  const app = new pg.Client({ connectionString: u.toString() }); app.on("error", () => {}); await app.connect();
  let ended = false; app.on("end", () => { ended = true; });
  assert.equal((await m.sync()).gate.ready, true);
  const tables = TABLES.map((name) => ({ schema: "public", name }));
  const r = await switchover({ from: src, to: TARGET, current: m.names.fwd, reverse: m.names.rev, tables });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await canInsert(), false, "컷오버 뒤 출발 = 전용 계정도 쓰기 못 함 (예전: 앱 계정만 막혀 도착 앱 쓰기가 출발로 샘)");
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(ended || !(await app.query("SELECT 1").then(() => true, () => false)), true, "전용 계정 세션이 끊김");
  await app.end().catch(() => undefined);
  const rb = await m.rollback({ teardown: false });
  assert.equal(rb.kind, "after_cutover");
  assert.equal(rb.result?.ok, true, JSON.stringify(rb.result));
  assert.equal(await canInsert(), true, "롤백 뒤 출발 = 전용 계정 쓰기 복원 (도착 앱이 다시 출발로)");
});

test("PF-E34 거부: 전용 계정이 없는 DB 에서도 울타리·걷기가 에러 없이 앱 계정만 다룬다", { skip }, async () => {
  const ghost = { ...TARGET, fenceRoles: ["svc_link_nope0000"] };
  await withClient(ghost, async (c) => {
    const f = await fence(c, ghost, { check: [{ schema: "public", name: "orders" }] });
    assert.deepEqual(f.leaky, []);
    const u = await unfence(c, ghost);
    assert.ok(["saved", "default"].includes(u.restored));
  });
});
