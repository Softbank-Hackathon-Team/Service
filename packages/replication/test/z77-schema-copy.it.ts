// Z77: 도착에 표가 없을 때 출발 스키마(모양만)를 복사하고 그대로 복제·전환·롤백까지 되는지. 먼저: npm run db:up
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Migration, copySchema, precheck, withClient, checksum, type Endpoint, type TableRef } from "../src/index.js";
import { SOURCE, TARGET, q, reachable, sleep } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "docker Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const TABLES = ["z77_customers", "z77_orders"];
const refs: TableRef[] = TABLES.map((name) => ({ schema: "public", name }));

async function dropRepl(e: Endpoint) {
  for (const s of await q(e, `SELECT subname FROM pg_subscription WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())`)) {
    await q(e, `ALTER SUBSCRIPTION "${s.subname}" DISABLE`);
    await q(e, `ALTER SUBSCRIPTION "${s.subname}" SET (slot_name = NONE)`);
    await q(e, `DROP SUBSCRIPTION "${s.subname}"`);
  }
  await q(e, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_type='logical' AND database = current_database() AND NOT active`);
  for (const p of await q(e, `SELECT pubname FROM pg_publication`)) await q(e, `DROP PUBLICATION "${p.pubname}"`);
}

const CLEAN = `DROP SCHEMA IF EXISTS _repl CASCADE; DROP SCHEMA IF EXISTS z77other CASCADE;
  DROP TABLE IF EXISTS z77_orders, z77_customers, z77_parts, z77_dom CASCADE; DROP TYPE IF EXISTS z77_status; DROP DOMAIN IF EXISTS z77_pos; DROP SEQUENCE IF EXISTS z77_orders_created;
  ALTER DATABASE app RESET default_transaction_read_only;`;

before(async () => {
  if (!up) return;
  // Z38 R8: 지난 실행이 중간에 죽어 app_user 가 NOLOGIN 으로 남았을 수 있다 → 먼저 원래 모양으로
  await q(TARGET, `ALTER ROLE app_user LOGIN PASSWORD 'app'`).catch(() => undefined);
  for (const e of [TARGET, SOURCE]) await dropRepl(e);
  await q(SOURCE, `${CLEAN}
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN CREATE ROLE app_user LOGIN PASSWORD 'app'; END IF; END $$;
    CREATE TYPE z77_status AS ENUM ('new', 'paid', 'shipped');
    CREATE TABLE z77_customers (id bigserial PRIMARY KEY, email text NOT NULL COLLATE "C", name text NOT NULL DEFAULT 'x',
      CONSTRAINT z77_customers_email_key UNIQUE (email));
    CREATE TABLE z77_orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      customer_id bigint NOT NULL REFERENCES z77_customers(id), amount numeric(10,2) NOT NULL CHECK (amount >= 0),
      status z77_status NOT NULL DEFAULT 'new', qty int NOT NULL DEFAULT 1, total numeric GENERATED ALWAYS AS (amount * qty) STORED,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX z77_orders_created ON z77_orders (created_at DESC) WHERE status <> 'shipped';
    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON z77_customers, z77_orders TO app_user;
    GRANT USAGE, SELECT ON SEQUENCE z77_customers_id_seq TO app_user;
    INSERT INTO z77_customers(email) SELECT 'c' || g || '@x' FROM generate_series(1, 50) g;
    INSERT INTO z77_orders(customer_id, amount, qty) SELECT 1 + g % 50, g, 1 + g % 3 FROM generate_series(1, 3000) g;`);
  // 도착: 표도 앱 계정도 없다 (클러스터 없는 RDS 처럼)
  await q(TARGET, `${CLEAN} DROP OWNED BY app_user; DROP ROLE IF EXISTS app_user;`).catch(async () =>
    q(TARGET, `${CLEAN}`));
});

// 다른 시험(harness resetAndSeed)은 app_user 가 있으면 다시 안 만든다 → 이 시험이 만든 NOLOGIN 역할을 원래 모양으로 돌려 둔다
after(async () => { if (up) await q(TARGET, `ALTER ROLE app_user LOGIN PASSWORD 'app'`).catch(() => undefined); });

test("1 점검: 도착 표 없음이 DB-T4 로 분명히 잡힌다", { skip }, async () => {
  const r = await precheck(SOURCE, TARGET, { tables: TABLES });
  const t4 = r.checks.find((c) => c.id === "DB-T4")!;
  assert.equal(r.ok, false);
  assert.equal(t4.ok, false);
  assert.match(t4.detail, /표가 없다.*z77_customers, z77_orders/);
  assert.match(t4.hint!, /REPL_COPY_SCHEMA=1/);
});

test("2 스키마 복사: 표·enum·시퀀스·제약·인덱스·외래키·권한, 데이터는 0", { skip }, async () => {
  const r = await copySchema(SOURCE, TARGET, refs);
  console.log("    created", r.created, "types", r.types, "seq", r.sequences, "idx", r.indexes, "fk", r.foreignKeys, "grants", r.grants, "ms", Math.round(r.ms));
  assert.deepEqual(r.created, TABLES);
  assert.deepEqual(r.types, ["z77_status"]);
  assert.deepEqual(r.sequences, ["z77_customers_id_seq"]);
  assert.equal(r.indexes, 1);
  assert.equal(r.foreignKeys, 1);
  assert.equal(r.roleCreated, true);
  assert.equal(r.grants, 3);
  // 열 모양이 출발과 같다
  const shape = `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) t, a.attnotnull, a.attidentity, a.attgenerated,
      pg_get_expr(d.adbin, d.adrelid) def, a.attcollation::regcollation::text coll
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1, a.attnum`;
  assert.deepEqual(await q(TARGET, shape, [TABLES]), await q(SOURCE, shape, [TABLES]));
  const cons = `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid::regclass::text = ANY($1) ORDER BY 1`;
  assert.deepEqual(await q(TARGET, cons, [TABLES]), await q(SOURCE, cons, [TABLES]));
  const idx = `SELECT indexdef FROM pg_indexes WHERE tablename = ANY($1) ORDER BY 1`;
  assert.deepEqual(await q(TARGET, idx, [TABLES]), await q(SOURCE, idx, [TABLES]));
  const acl = `SELECT relname, relacl::text FROM pg_class WHERE relname = ANY($1) ORDER BY 1`;
  const names = [...TABLES, "z77_customers_id_seq"];
  assert.deepEqual((await q(TARGET, acl, [names])).map((x) => x.relacl.replace(/\/\w+/g, "")), (await q(SOURCE, acl, [names])).map((x) => x.relacl.replace(/\/\w+/g, "")));
  assert.equal(Number((await q(TARGET, `SELECT count(*) n FROM z77_orders`))[0].n), 0);
  assert.equal((await q(TARGET, `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'app_user'`))[0].rolcanlogin, false);
  // 두 번째는 할 일이 없다 (이미 있는 표는 안 건드림)
  const again = await copySchema(SOURCE, TARGET, refs);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.ddl, []);
});

test("3 복사한 도착으로 복제 → 전환 → 롤백 (REPL_COPY_SCHEMA 경로)", { skip }, async () => {
  await q(TARGET, `DROP TABLE z77_orders, z77_customers; DROP TYPE z77_status`);
  const m = new Migration({ key: "z77sc", source: SOURCE, target: TARGET, tables: TABLES, copySchema: true, gate: { maxLagMs: 1000, consecutive: 3 } });
  try {
    const prep = await m.prepareTarget();
    assert.deepEqual(prep!.created, TABLES);
    assert.equal((await m.precheck()).ok, true);
    const s = await m.sync();
    assert.equal(s.gate.ready, true, s.gate.reasons.join(","));
    const ev = await m.catchUpEvidence();
    assert.equal(ev.rowCountMatch, true);
    assert.equal(ev.counts.target["public.z77_orders"], 3000);
    const sum = async () => [await withClient(SOURCE, (c) => checksum(c, refs[1]!)), await withClient(TARGET, (c) => checksum(c, refs[1]!))];
    const [a, b] = await sum();
    assert.equal(a, b);
    const cut = await m.cutover();
    assert.equal(cut.ok, true, JSON.stringify(cut));
    // 도착이 주인: 시퀀스·identity 가 이어진다 (switchover 가 setval)
    await q(TARGET, `INSERT INTO z77_customers(email) VALUES ('new@x'); INSERT INTO z77_orders(customer_id, amount) VALUES (1, 1)`);
    await sleep(500);
    const back = await m.rollback();
    assert.equal(back.kind, "after_cutover");
    assert.equal(back.result!.ok, true, JSON.stringify(back.result));
    assert.equal(Number((await q(SOURCE, `SELECT count(*) n FROM z77_orders`))[0].n), 3001);
  } finally {
    await m.teardown().catch(() => undefined);
  }
});

test("4 다른 도착 스키마 이름에도 이름 없이 만든다", { skip }, async () => {
  const other: Endpoint = { ...TARGET, schema: "z77other" };
  const r = await copySchema(SOURCE, other, refs);
  assert.deepEqual(r.created, TABLES);
  const n = await q(TARGET, `SELECT count(*) n FROM pg_tables WHERE schemaname = 'z77other'`);
  assert.equal(Number(n[0].n), 2);
  const fk = await q(TARGET, `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = 'z77other.z77_orders'::regclass AND contype = 'f'`);
  assert.match(fk[0].d, /REFERENCES z77other\.z77_customers\(id\)/);
  await q(TARGET, `DROP SCHEMA z77other CASCADE`);
});

test("5 못 하는 모양(파티션·domain)은 바로 멈추고 도착에 아무것도 안 남긴다", { skip }, async () => {
  await q(SOURCE, `CREATE TABLE z77_parts (id int, at date) PARTITION BY RANGE (at);
    CREATE DOMAIN z77_pos AS int CHECK (VALUE > 0); CREATE TABLE z77_dom (id int PRIMARY KEY, v z77_pos)`);
  await assert.rejects(copySchema(SOURCE, TARGET, [{ schema: "public", name: "z77_parts" }]), (e: Error & { code?: string }) =>
    e.code === "REPL_SCHEMA_COPY_FAILED" && /파티션/.test(e.message));
  await assert.rejects(copySchema(SOURCE, TARGET, [{ schema: "public", name: "z77_dom" }]), /enum 밖 사용자 타입.*z77_dom\.v/);
  assert.equal((await q(TARGET, `SELECT count(*) n FROM pg_class WHERE relname IN ('z77_parts', 'z77_dom')`))[0].n, "0");
  // 도착 DDL 이 중간에 깨지면 앞에서 만든 것도 다 되돌린다 (도착에 같은 이름의 다른 객체를 미리 둔다)
  await q(TARGET, `DROP TABLE IF EXISTS z77_orders, z77_customers; DROP TYPE IF EXISTS z77_status`);
  await q(TARGET, `CREATE SEQUENCE z77_orders_created`);   // 인덱스 이름과 겹친다 → CREATE INDEX 실패
  await assert.rejects(copySchema(SOURCE, TARGET, refs), /아무것도 안 남김/);
  assert.equal((await q(TARGET, `SELECT count(*) n FROM pg_class WHERE relname IN ('z77_orders', 'z77_customers')`))[0].n, "0");
  await q(TARGET, `DROP SEQUENCE z77_orders_created`);
  await q(SOURCE, `DROP TABLE z77_parts, z77_dom; DROP DOMAIN z77_pos`);
});

// 실측(2026-11-06 실제 RDS): 앱 계정이 표 주인(relacl NULL)이면 권한이 0개로 읽혀 도착에서 앱 계정이 그 표를 못 썼다 (schemaCopy.grants 0)
test("6 앱 계정이 주인인 표(기본 권한)도 도착에서 앱 계정이 쓸 수 있게 권한을 옮긴다", { skip }, async () => {
  await q(TARGET, `DROP TABLE IF EXISTS z77_owned`);
  await q(SOURCE, `DROP TABLE IF EXISTS z77_owned; CREATE TABLE z77_owned (id bigserial PRIMARY KEY, v int); ALTER TABLE z77_owned OWNER TO app_user`);
  try {
    const r = await copySchema(SOURCE, TARGET, [{ schema: "public", name: "z77_owned" }]);
    assert.deepEqual(r.created, ["z77_owned"]);
    assert.ok(r.grants >= 2, `표·시퀀스 권한이 옮겨져야 함 (grants=${r.grants})`);
    const can = await q(TARGET, `SELECT p, has_table_privilege('app_user', 'public.z77_owned', p) ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p ORDER BY 1`);
    assert.deepEqual(can.filter((x) => x.ok).map((x) => x.p), ["DELETE", "INSERT", "SELECT", "UPDATE"]);
    assert.equal((await q(TARGET, `SELECT has_sequence_privilege('app_user', 'public.z77_owned_id_seq', 'USAGE') ok`))[0].ok, true);
  } finally {
    await q(TARGET, `DROP TABLE IF EXISTS z77_owned`);
    await q(SOURCE, `DROP TABLE IF EXISTS z77_owned`);
  }
});
