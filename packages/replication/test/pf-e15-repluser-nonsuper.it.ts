// PF-E15 (FM-APP-28): 비superuser 관리자(PG16, CREATEROLE — RDS rds_superuser 와 같은 처지)도 전용 복제 계정을 지울 수 있다
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { dropReplUser, replUserOf } from "../src/index.js";
import { SOURCE, q, reachable } from "./harness.js";

const up = await reachable(SOURCE);
let skip: string | false = up ? false : "Postgres(55432) 없음";
const ADMIN = "pfe15_admin", NAME = "repl_pfe15_fwd", USER = replUserOf(NAME);
const adminUrl = () => { const u = new URL(SOURCE.adminUrl); u.username = ADMIN; u.password = "pw"; return u.toString(); };

before(async () => {
  if (!up) return;
  const [v] = await q(SOURCE, `SELECT current_setting('server_version_num')::int v`);
  if (v.v < 160000) { skip = "PG16 규칙 시험"; return; }
  await q(SOURCE, `DROP TABLE IF EXISTS pfe15_t; DROP ROLE IF EXISTS ${USER}; DROP ROLE IF EXISTS ${ADMIN}`).catch(() => undefined);
  await q(SOURCE, `CREATE ROLE ${ADMIN} LOGIN PASSWORD 'pw' CREATEROLE; GRANT CREATE ON SCHEMA public TO ${ADMIN}`);
  const c = new pg.Client({ connectionString: adminUrl() }); await c.connect();
  try {
    await c.query(`CREATE TABLE pfe15_t (id int primary key)`);
    await c.query(`CREATE ROLE ${USER} LOGIN PASSWORD 'x' NOINHERIT`);
    await c.query(`GRANT USAGE ON SCHEMA public TO ${USER}; GRANT SELECT ON pfe15_t TO ${USER}`);
  } finally { await c.end(); }
});
after(async () => {
  if (!up || skip) return;
  await q(SOURCE, `DROP TABLE IF EXISTS pfe15_t; DROP OWNED BY ${ADMIN}; DROP ROLE IF EXISTS ${USER}; DROP ROLE IF EXISTS ${ADMIN}`).catch(() => undefined);
});

test("PF-E15: 비superuser 관리자가 권한 받은 전용 계정을 지운다 (예전: permission denied to drop objects)", async (t) => {
  if (skip) return t.skip(skip);
  const c = new pg.Client({ connectionString: adminUrl() }); await c.connect();
  try { assert.equal(await dropReplUser(c, NAME), true); } finally { await c.end(); }
  assert.deepEqual(await q(SOURCE, `SELECT 1 FROM pg_roles WHERE rolname=$1`, [USER]), []);
});

test("PF-E15 정상: 없는 계정이면 false (아무것도 안 함)", async (t) => {
  if (skip) return t.skip(skip);
  const c = new pg.Client({ connectionString: adminUrl() }); await c.connect();
  try { assert.equal(await dropReplUser(c, NAME), false); } finally { await c.end(); }
});
