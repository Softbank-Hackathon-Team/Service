// 재시도 전 도착 초기화 (ADR-030 자동화): 스키마 복사가 만든 표(주석 svc-copy:<이전 id>)만, 허락된 이전 id 일 때만 지운다.
//   고객이 만든(표지 없는) 데이터가 있는 표가 하나라도 있으면 아무것도 안 지운다. 먼저: npm run db:up
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { copySchema, handOwnershipToApp, resetCopiedTables, listTables, type Endpoint } from "../src/index.js";
import pg from "pg";
import { SOURCE, TARGET, q, reachable } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "docker Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const SCH = "rst1";
const S: Endpoint = { ...SOURCE, schema: SCH }, T: Endpoint = { ...TARGET, schema: SCH };
const names = async () => (await q(T, `SELECT relname FROM pg_class WHERE relnamespace = to_regnamespace('${SCH}') AND relkind='r' ORDER BY 1`)).map((r) => r.relname);

async function fresh() {
  for (const e of [S, T]) await q(e, `DROP SCHEMA IF EXISTS ${SCH} CASCADE; CREATE SCHEMA ${SCH}`);
  await q(S, `CREATE TABLE ${SCH}.a (id serial PRIMARY KEY, v text); CREATE TABLE ${SCH}.b (id int PRIMARY KEY, a_id int REFERENCES ${SCH}.a(id))`);
  const tables = await (async () => { const c = new pg.Client({ connectionString: S.adminUrl }); await c.connect(); try { return await listTables(c, SCH); } finally { await c.end(); } })();
  await copySchema(S, T, tables, { copiedBy: "mig-1" });
  // 롤백된 판이 남긴 모양: 도착 표에 데이터가 들어 있다
  await q(T, `INSERT INTO ${SCH}.a(v) VALUES ('x'); INSERT INTO ${SCH}.b VALUES (1, 1)`);
}
before(async () => { if (up) await fresh(); });
// 다른 시험(DB-T7: 복제 스키마 밖 앱 표)을 깨지 않게 양쪽 스키마를 지운다
after(async () => { if (up) for (const e of [S, T]) await q(e, `DROP SCHEMA IF EXISTS ${SCH} CASCADE`); });

test("허락 안 된 이전 id 면 아무것도 안 지운다 (완료된 이전이 만든 표 = 고객 데이터)", { skip }, async () => {
  const r = await resetCopiedTables(T, ["mig-other"]);
  assert.deepEqual(r, { dropped: [], blocked: ["a", "b"] });   // 데이터가 든 남의 표 = 막힌 것으로 알려 준다 (sync 는 DB-T5 로 멈춤)
  assert.deepEqual(await names(), ["a", "b"]);
});

test("표지 없는 비어 있지 않은 표가 하나라도 있으면 아무것도 안 지우고 그 표를 알려 준다", { skip }, async () => {
  await q(T, `CREATE TABLE ${SCH}.customer_own (id int); INSERT INTO ${SCH}.customer_own VALUES (1)`);
  const r = await resetCopiedTables(T, ["mig-1"]);
  assert.deepEqual(r, { dropped: [], blocked: ["customer_own"] });
  assert.deepEqual(await names(), ["a", "b", "customer_own"]);
  await q(T, `DROP TABLE ${SCH}.customer_own`);
});

test("허락된 이전의 스키마 복사가 만든 표만 지운다. 주인 넘기기(정리) 뒤에도 표지가 남는다", { skip }, async () => {
  await q(T, `CREATE TABLE ${SCH}.empty_other (id int)`);   // 표지 없지만 빈 표 = 막지 않고, 지우지도 않는다
  const c = new pg.Client({ connectionString: T.adminUrl }); await c.connect();
  try { await handOwnershipToApp(c, T); } finally { await c.end(); }   // superuser 라 아무것도 안 하지만, 같은 길을 지난다
  const r = await resetCopiedTables(T, ["mig-1"]);
  assert.deepEqual(r, { dropped: ["a", "b"], blocked: [] });
  assert.deepEqual(await names(), ["empty_other"]);
  // 다시 복사하면 같은 모양으로 새로 만든다 (이어지는 sync 의 prepareTarget)
  const tables = await (async () => { const s = new pg.Client({ connectionString: S.adminUrl }); await s.connect(); try { return await listTables(s, SCH); } finally { await s.end(); } })();
  const again = await copySchema(S, T, tables, { copiedBy: "mig-2" });
  assert.deepEqual(again.created.sort(), ["a", "b"]);
  const note = await q(T, `SELECT obj_description('${SCH}.a'::regclass, 'pg_class') n`);
  assert.equal(note[0]!.n, "svc-copy:mig-2");
});
