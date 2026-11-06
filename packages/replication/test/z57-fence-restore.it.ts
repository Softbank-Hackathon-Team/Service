// Z57: 펜스 해제 때 "원래 권한" 그대로 되돌리기 (10/31 보드 기본값). DB 하나(출발)만 쓴다. 복제는 안 건다
//   1) 앱 권한이 좁으면(orders INSERT만, customers 는 SELECT만) 해제 뒤에도 똑같이 좁다 (예전: 전체 부여로 넓어짐)
//   2) fence 두 번(재시도) 해도 첫 저장본이 지켜진다
//   3) writable:false 해제는 회수 유지 + 저장본 유지 → 나중 해제에서 복원
//   4) 저장본 없는 DB 는 예전처럼 전체 부여
import { test, before } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { SOURCE, q, reachable } from "./harness.js";
import { fence, unfence, savedGrants, directWriteGrants } from "../src/fence.js";

let up = false;
before(async () => { up = await reachable(SOURCE); });

async function reset() {
  await q(SOURCE, `
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN CREATE ROLE app_user LOGIN PASSWORD 'app'; END IF; END $$;
    ALTER DATABASE app RESET default_transaction_read_only;
    DROP SCHEMA IF EXISTS _repl CASCADE;
    DROP TABLE IF EXISTS z57_orders, z57_customers;
    CREATE TABLE z57_customers (id bigserial PRIMARY KEY, name text);
    CREATE TABLE z57_orders (id bigserial PRIMARY KEY, amount int);
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_user;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_user;
    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT ON z57_customers TO app_user;
    GRANT SELECT, INSERT ON z57_orders TO app_user;
    GRANT USAGE ON SEQUENCE z57_orders_id_seq TO app_user;`);
}

async function privs() {
  const rows = await q(SOURCE, `SELECT t, p, has_table_privilege('app_user', t, p) ok
    FROM unnest(ARRAY['public.z57_customers','public.z57_orders']) t, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p ORDER BY 1, 2`);
  return rows.filter((r) => r.ok).map((r) => `${r.t.replace("public.z57_", "")}:${r.p}`);
}
async function seqPrivs() {
  const rows = await q(SOURCE, `SELECT p, has_sequence_privilege('app_user', 'public.z57_orders_id_seq', p) ok FROM unnest(ARRAY['USAGE','UPDATE']) p`);
  return rows.filter((r) => r.ok).map((r) => r.p);
}
async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: SOURCE.adminUrl }); await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

test("Z57 fence → unfence 는 좁은 원래 권한을 그대로 되돌린다", async (t) => {
  if (!up) return t.skip("IT_SOURCE_URL DB 없음");
  await reset();
  const before = await privs();
  assert.deepEqual(before, ["customers:SELECT", "orders:INSERT", "orders:SELECT"]);
  await withAdmin(async (c) => {
    await fence(c, SOURCE);
    assert.deepEqual(await privs(), ["customers:SELECT", "orders:SELECT"], "울타리 뒤 쓰기 없음");
    assert.deepEqual(await seqPrivs(), []);
    const saved = await savedGrants(c, SOURCE);
    assert.deepEqual(saved?.map((g) => `${g.kind}:${g.name}:${g.privilege}`),
      ["sequence:z57_orders_id_seq:USAGE", "table:z57_orders:INSERT"]);
    const r = await unfence(c, SOURCE);
    assert.deepEqual(r, { restored: "saved", grants: 2 });
    assert.equal(await savedGrants(c, SOURCE), null, "복원 뒤 저장본은 지운다");
  });
  assert.deepEqual(await privs(), before, "예전 코드는 여기서 UPDATE·DELETE·customers INSERT 까지 넓혔다");
  assert.deepEqual(await seqPrivs(), ["USAGE"]);
});

test("Z57 fence 두 번(재시도)이어도 첫 저장본을 지킨다", async (t) => {
  if (!up) return t.skip("IT_SOURCE_URL DB 없음");
  await reset();
  await withAdmin(async (c) => {
    await fence(c, SOURCE);
    await fence(c, SOURCE);                          // 이미 회수된 상태에서 다시 → 저장본 덮어쓰면 빈 권한이 된다
    assert.equal((await savedGrants(c, SOURCE))?.length, 2);
    await unfence(c, SOURCE);
  });
  assert.deepEqual(await privs(), ["customers:SELECT", "orders:INSERT", "orders:SELECT"]);
});

test("Z57 writable:false 해제는 회수·저장본을 유지하고, 나중 해제에서 복원", async (t) => {
  if (!up) return t.skip("IT_SOURCE_URL DB 없음");
  await reset();
  await withAdmin(async (c) => {
    await fence(c, SOURCE);
    assert.deepEqual(await unfence(c, SOURCE, { writable: false }), { restored: "none", grants: 0 });
    assert.deepEqual(await privs(), ["customers:SELECT", "orders:SELECT"]);
    assert.equal((await savedGrants(c, SOURCE))?.length, 2);
    assert.equal((await unfence(c, SOURCE)).restored, "saved");
  });
  assert.deepEqual(await privs(), ["customers:SELECT", "orders:INSERT", "orders:SELECT"]);
});

test("Z57 저장본 없는 DB(울타리 친 적 없는 도착)는 예전처럼 전체 부여", async (t) => {
  if (!up) return t.skip("IT_SOURCE_URL DB 없음");
  await reset();
  await withAdmin(async (c) => {
    assert.deepEqual(await unfence(c, SOURCE), { restored: "default", grants: 0 });
    assert.equal((await directWriteGrants(c, SOURCE)).filter((g) => g.name === "z57_customers").length, 3);
  });
  assert.deepEqual(await privs(), ["customers:DELETE", "customers:INSERT", "customers:SELECT", "customers:UPDATE",
    "orders:DELETE", "orders:INSERT", "orders:SELECT", "orders:UPDATE"]);
});

// 실측(2026-11-06 실제 RDS): 앱 계정이 표 주인이고 권한을 따로 준 적 없으면(relacl = NULL, 주인 기본 권한) 저장본이 비었다.
//   aclexplode(NULL) 은 0줄이라, REVOKE 뒤 해제가 아무것도 되돌리지 못해 주인이 자기 표에 INSERT·UPDATE·DELETE·TRUNCATE 를 잃었다
//   (컷오버 실패·롤백 뒤 출발 앱 쓰기 실패). 기본 권한(acldefault)도 저장해 그대로 되돌려야 한다
test("Z57 앱 계정이 주인인 표(기본 권한, relacl NULL)도 해제 뒤 쓰기 권한이 그대로 돌아온다", async (t) => {
  if (!up) return t.skip("IT_SOURCE_URL DB 없음");
  await reset();
  await q(SOURCE, `
    DROP TABLE IF EXISTS z57_owned;
    CREATE TABLE z57_owned (id bigserial PRIMARY KEY, v int);
    ALTER TABLE z57_owned OWNER TO app_user;`);
  const owned = async () => (await q(SOURCE, `SELECT p, has_table_privilege('app_user', 'public.z57_owned', p) ok
    FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p ORDER BY 1`)).filter((r) => r.ok).map((r) => r.p);
  const ownedSeq = async () => (await q(SOURCE, `SELECT p, has_sequence_privilege('app_user', 'public.z57_owned_id_seq', p) ok
    FROM unnest(ARRAY['USAGE','UPDATE']) p ORDER BY 1`)).filter((r) => r.ok).map((r) => r.p);
  assert.equal((await q(SOURCE, `SELECT relacl IS NULL AS n FROM pg_class WHERE oid = 'public.z57_owned'::regclass`))[0].n, true, "전제: 기본 권한");
  assert.deepEqual(await owned(), ["DELETE", "INSERT", "TRUNCATE", "UPDATE"]);
  await withAdmin(async (c) => {
    assert.deepEqual((await directWriteGrants(c, SOURCE)).filter((g) => g.name.startsWith("z57_owned")).map((g) => `${g.kind}:${g.privilege}`),
      ["sequence:UPDATE", "sequence:USAGE", "table:DELETE", "table:INSERT", "table:TRUNCATE", "table:UPDATE"], "주인 기본 권한도 직접 권한으로 센다");
    await fence(c, SOURCE);
    assert.deepEqual(await owned(), [], "울타리 뒤 주인도 못 쓴다");
    await unfence(c, SOURCE);
  });
  assert.deepEqual(await owned(), ["DELETE", "INSERT", "TRUNCATE", "UPDATE"], "해제 뒤 주인 쓰기 권한 복원");
  assert.deepEqual(await ownedSeq(), ["UPDATE", "USAGE"], "시퀀스도 복원");
  assert.deepEqual(await privs(), ["customers:SELECT", "orders:INSERT", "orders:SELECT"], "다른 표의 좁은 권한은 그대로");
  await q(SOURCE, `DROP TABLE z57_owned`);
});
