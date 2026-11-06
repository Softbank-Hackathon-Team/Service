// ADR-029 후속: 스키마 복사로 CNPG svc_migrate 가 주인이 된 앱 객체를 정리 때 앱 계정에 넘긴다.
//   2026-11-06 실플랫폼 889c1257: 정리 뒤 CNPG 가 svc_migrate 를 못 지움 ("objects depend on it") → 사람이 손으로 주인을 넘겼다.
//   넘긴 뒤 관리자 역할을 실제로 지울 수 있는지(= CNPG 가 할 일)까지 본다. 먼저: npm run db:up
import assert from "node:assert/strict";
import { before, test } from "node:test";
import pg from "pg";
import { handOwnershipToApp, type Endpoint } from "../src/index.js";
import { TARGET, q, reachable } from "./harness.js";

const up = await reachable(TARGET);
const skip = up ? false : "docker Postgres(55433)가 안 떠 있음: npm run db:up";
const url = (user: string, db = "own1") => { const u = new URL(TARGET.adminUrl); if (user !== u.username) { u.username = user; u.password = "own"; } u.pathname = `/${db}`; return u.toString(); };
const ep = (provider: Endpoint["provider"]): Endpoint => ({ ...TARGET, label: "cnpg-like", provider, appRole: "own_app", adminUrl: url("own_migrate") });
const owners = async () => q({ ...TARGET, adminUrl: url("postgres") }, `
  SELECT cl.relname n, pg_get_userbyid(cl.relowner) o FROM pg_class cl WHERE cl.relnamespace='public'::regnamespace AND cl.relkind IN ('r','S','v')
  UNION ALL SELECT p.proname, pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT t.typname, pg_get_userbyid(t.typowner) FROM pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typtype='e' ORDER BY 1`);

before(async () => {
  if (!up) return;
  await q(TARGET, `DROP DATABASE IF EXISTS own1 WITH (FORCE)`);
  await q(TARGET, `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='own_migrate') THEN DROP ROLE own_migrate; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='own_app') THEN CREATE ROLE own_app NOLOGIN; END IF;
    END $$;
    CREATE ROLE own_migrate LOGIN PASSWORD 'own' IN ROLE own_app;`);
  await q(TARGET, `CREATE DATABASE own1 OWNER own_app`);
  // 스키마 복사가 하는 것처럼 관리자(svc_migrate 모양)가 표·시퀀스·뷰·함수·enum 을 만든다
  await q({ ...TARGET, adminUrl: url("own_migrate") }, `
    CREATE TYPE mood AS ENUM ('a','b');
    CREATE TABLE orders (id serial PRIMARY KEY, m mood, item text);
    CREATE SEQUENCE loose_seq;
    CREATE VIEW v_orders AS SELECT id, item FROM orders;
    CREATE FUNCTION f_count() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM orders';`);
});

test("CNPG: 관리자가 주인인 앱 객체를 앱 계정에 넘기고, 넘긴 뒤 관리자 역할을 지울 수 있다", { skip }, async () => {
  const c = new pg.Client({ connectionString: url("own_migrate") }); await c.connect();
  let n: number;
  try { n = await handOwnershipToApp(c, ep("cnpg")); } finally { await c.end(); }
  assert.ok(n >= 5, `넘긴 수 ${n}`);
  const rows = await owners();
  assert.deepEqual(rows.filter((r) => r.o !== "own_app"), [], JSON.stringify(rows));
  // CNPG 가 할 일: 관리자 역할 지우기. 객체가 남아 있으면 "objects depend on it" 으로 실패한다
  await q({ ...TARGET, adminUrl: url("postgres") }, `DROP ROLE own_migrate`);
});

test("CNPG 가 아니면 아무것도 안 한다 (RDS 관리자는 앱 계정으로 SET ROLE 을 못 하는 것이 보통)", { skip }, async () => {
  await q(TARGET, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='own_migrate') THEN CREATE ROLE own_migrate LOGIN PASSWORD 'own' IN ROLE own_app; END IF; END $$`);
  await q({ ...TARGET, adminUrl: url("own_migrate") }, `CREATE TABLE IF NOT EXISTS t_rds (id int)`);
  const c = new pg.Client({ connectionString: url("own_migrate") }); await c.connect();
  try { assert.equal(await handOwnershipToApp(c, ep("rds")), 0); } finally { await c.end(); }
  const rows = await owners();
  assert.equal(rows.find((r) => r.n === "t_rds")?.o, "own_migrate");
});
