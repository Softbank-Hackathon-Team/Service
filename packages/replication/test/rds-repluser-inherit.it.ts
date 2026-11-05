// 2026-11-05 임시 RDS(PG16) 실측: NOINHERIT 전용 계정은 rds_replication 을 받아도 "permission denied to start WAL sender".
//   PG16 은 멤버십마다 inherit 옵션을 따로 두고 기본값이 "부여 때의 계정 INHERIT" 라서, 나중에 ALTER ROLE … INHERIT 해도 그대로다.
//   여기서는 진짜 RDS 없이 로컬 Postgres 에 rds_replication 역할만 흉내 내어, 전용 계정과 그 멤버십이 상속으로 만들어지는지 본다
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { ensureReplUser, dropReplUser, replUserOf } from "../src/index.js";
import { SOURCE, q, reachable } from "./harness.js";

const up = await reachable(SOURCE);
let skip: string | false = up ? false : "Postgres(55432) 없음: npm run db:up";
const NAME = "repl_rdsinh_fwd", USER = replUserOf(NAME);
const RDS = { ...SOURCE, provider: "rds" as const };

before(async () => {
  if (!up) return;
  const [v] = await q(SOURCE, `SELECT current_setting('server_version_num')::int v`);
  if (v.v < 160000) { skip = "PG16 멤버십 inherit 옵션 시험"; return; }
  await q(SOURCE, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rds_replication') THEN CREATE ROLE rds_replication NOLOGIN; END IF; END $$`);
  await q(SOURCE, `DROP ROLE IF EXISTS ${USER}`);
});
after(async () => { if (up && !skip) await q(SOURCE, `DROP ROLE IF EXISTS ${USER}`).catch(() => undefined); });

const membership = async () => (await q(SOURCE, `SELECT u.rolinherit, m.inherit_option FROM pg_auth_members m
  JOIN pg_roles u ON u.oid = m.member JOIN pg_roles g ON g.oid = m.roleid WHERE u.rolname = $1 AND g.rolname = 'rds_replication'`, [USER]))[0];

test("RDS 전용 계정: 계정도 INHERIT, rds_replication 멤버십도 inherit (예전: NOINHERIT 라 WAL sender 거부)", { skip }, async () => {
  const c = new pg.Client({ connectionString: SOURCE.adminUrl }); await c.connect();
  try { await ensureReplUser(c, RDS, NAME); } finally { await c.end(); }
  assert.deepEqual(await membership(), { rolinherit: true, inherit_option: true });
});

test("예전 NOINHERIT 로 남은 계정도 다시 부르면 멤버십 inherit 가 켜진다", { skip }, async () => {
  await q(SOURCE, `DROP ROLE IF EXISTS ${USER}`);
  await q(SOURCE, `CREATE ROLE ${USER} LOGIN NOINHERIT; GRANT rds_replication TO ${USER}`);
  assert.deepEqual(await membership(), { rolinherit: false, inherit_option: false });
  const c = new pg.Client({ connectionString: SOURCE.adminUrl }); await c.connect();
  try { await ensureReplUser(c, RDS, NAME); } finally { await c.end(); }
  assert.deepEqual(await membership(), { rolinherit: true, inherit_option: true });
});

test("RDS 가 아니면 예전처럼 NOINHERIT + REPLICATION 속성 (거부 쪽: 넓어지지 않는다)", { skip }, async () => {
  const c = new pg.Client({ connectionString: SOURCE.adminUrl }); await c.connect();
  try {
    await dropReplUser(c, NAME);
    await ensureReplUser(c, SOURCE, NAME);
  } finally { await c.end(); }
  const [r] = await q(SOURCE, `SELECT rolinherit, rolreplication FROM pg_roles WHERE rolname = $1`, [USER]);
  assert.deepEqual(r, { rolinherit: false, rolreplication: true });
  assert.equal(await membership(), undefined);
});
