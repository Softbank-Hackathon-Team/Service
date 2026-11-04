// PF-E9·E10 (FM-APP-18·19): 출발 확장(citext)을 스키마 복사가 도착에 만든다 / 뷰·함수·트리거가 도착에 없으면 점검 DB-T6 이 멈춘다.
//   진짜 Postgres 두 개(harness 55432·55433)
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { copySchema, precheck, precheckSource } from "../src/index.js";
import { SOURCE, TARGET, q, reachable } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "Postgres 두 개(55432/55433) 없음";
const T = ["pfe9_users"];
const CLEAN = `DROP MATERIALIZED VIEW IF EXISTS pfe9_mv; DROP VIEW IF EXISTS pfe9_v; DROP TABLE IF EXISTS pfe9_users CASCADE; DROP FUNCTION IF EXISTS pfe9_touch() CASCADE; DROP EXTENSION IF EXISTS citext CASCADE;`;
const OBJS = `CREATE VIEW pfe9_v AS SELECT id, email FROM pfe9_users;
  CREATE FUNCTION pfe9_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
  CREATE TRIGGER pfe9_t BEFORE UPDATE ON pfe9_users FOR EACH ROW EXECUTE FUNCTION pfe9_touch();`;

before(async () => {
  if (!up) return;
  await q(TARGET, `ALTER ROLE app_user LOGIN PASSWORD 'app'`).catch(() => undefined);
  for (const e of [SOURCE, TARGET]) await q(e, CLEAN);
  await q(SOURCE, `CREATE EXTENSION citext;
    CREATE TABLE pfe9_users (id bigint PRIMARY KEY, email citext NOT NULL UNIQUE, updated_at timestamptz);
    INSERT INTO pfe9_users SELECT g, 'U' || g || '@x' FROM generate_series(1, 10) g; ${OBJS}
    CREATE MATERIALIZED VIEW pfe9_mv AS SELECT count(*) n FROM pfe9_users;
    GRANT SELECT ON pfe9_v TO app_user;`);
});
after(async () => { if (up) for (const e of [SOURCE, TARGET]) await q(e, CLEAN); });

test("PF-E10 출발만: precheckSource 가 복제가 안 옮기는 뷰·함수·트리거·확장을 warn DB-T6S 로 알린다 (멈추진 않음)", { skip }, async () => {
  const r = await precheckSource(SOURCE, { tables: T });
  const c = r.checks.find((x) => x.id === "DB-T6S");
  assert.ok(c, JSON.stringify(r.checks));
  assert.equal(c.level, "warn");
  for (const k of ["view:pfe9_v", "function:pfe9_touch", "trigger:pfe9_users.pfe9_t", "extension:citext"]) assert.ok(c.detail.includes(k), c.detail);
});

test("PF-E9·E16: 도착에 citext 가 없어도 확장을 먼저 만들고, 함수·뷰·트리거도 출발 정의대로 만든다", { skip }, async () => {
  const r = await copySchema(SOURCE, TARGET, T.map((name) => ({ schema: "public", name })));
  assert.deepEqual(r.created, T);
  assert.ok(r.ddl.some((d) => /CREATE EXTENSION IF NOT EXISTS "?citext"?/.test(d)), r.ddl.join("\n"));
  const ty = await q(TARGET, `SELECT format_type(atttypid, atttypmod) t FROM pg_attribute WHERE attrelid='pfe9_users'::regclass AND attname='email'`);
  assert.equal(ty[0]?.t, "citext");
  assert.deepEqual([...(r.objects ?? [])].sort(), ["function:pfe9_touch", "trigger:pfe9_users.pfe9_t", "view:pfe9_v"]);
  // 트리거가 진짜로 돈다 (앱이 도착에서 고칠 때)
  await q(TARGET, `INSERT INTO pfe9_users VALUES (1, 'a@x', NULL); UPDATE pfe9_users SET email='b@x' WHERE id=1`);
  const [u] = await q(TARGET, `SELECT updated_at IS NOT NULL ok FROM pfe9_users WHERE id=1`);
  assert.equal(u.ok, true);
  const [g] = await q(TARGET, `SELECT has_table_privilege('app_user', 'pfe9_v', 'SELECT') ok`);
  assert.equal(g.ok, true, "뷰 권한도 출발대로");
  await q(TARGET, `DELETE FROM pfe9_users`);
});

test("PF-E10 거부: 복사가 못 만드는 것(구체화 뷰)이 도착에 없으면 DB-T6 실패로 점검이 멈춘다", { skip }, async () => {
  const r = await precheck(SOURCE, TARGET, { tables: T });
  const c = r.checks.find((x) => x.id === "DB-T6")!;
  assert.equal(c.ok, false, c.detail);
  assert.equal(r.ok, false);
  assert.match(c.detail, /view:pfe9_mv/);
  assert.ok(!/view:pfe9_v\b|trigger:|function:|extension:/.test(c.detail), c.detail);
});

test("PF-E10 정상: 도착에 앱 마이그레이션으로 구체화 뷰를 만들면 DB-T6 통과, 다시 복사해도 아무것도 안 만듦", { skip }, async () => {
  await q(TARGET, `CREATE MATERIALIZED VIEW pfe9_mv AS SELECT count(*) n FROM pfe9_users`);
  const r = await precheck(SOURCE, TARGET, { tables: T });
  const c = r.checks.find((x) => x.id === "DB-T6")!;
  assert.equal(c.ok, true, c.detail);
  const again = await copySchema(SOURCE, TARGET, T.map((name) => ({ schema: "public", name })));
  assert.deepEqual(again.created, []); assert.deepEqual(again.ddl, []);
});
