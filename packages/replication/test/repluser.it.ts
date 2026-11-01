// Z52 (모의 심사 Q27): 구독 접속 문자열에 관리자 비밀번호 대신 "쓰고 버리는 복제 전용 계정"이 들어가는지 진짜 Postgres로 본다.
// 먼저: npm run db:up. 비밀번호 인증(scram)이 켜진 서버여야 의미가 있다 (docker postgres:16 기본이 scram)
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { Migration, replUserOf } from "../src/index.js";
import { SOURCE, TABLES, TARGET, q, reachable, resetAndSeed } from "./harness.js";

process.env.REPL_EPHEMERAL_USER = "1";
const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const m = new Migration({ key: "rpu", source: SOURCE, target: TARGET, tables: TABLES });
const log = (...a: unknown[]) => console.log("   ", ...a);
const adminPw = new URL(SOURCE.adminUrl).password;
let leaked = "";

before(async () => { if (up) await resetAndSeed(300); });
after(async () => { if (up) await m.teardown().catch(() => {}); delete process.env.REPL_EPHEMERAL_USER; });

test("구독 접속 문자열 = 전용 계정. 관리자 계정·비밀번호가 없다", { skip }, async () => {
  const s = await m.sync();
  assert.equal(s.gate.ready, true, s.gate.reasons.join());
  const [row] = await q(TARGET, `SELECT subconninfo FROM pg_subscription WHERE subname=$1`, [m.names.fwd]);
  const u = new URL(row.subconninfo);
  log("subconninfo user", u.username, "password length", decodeURIComponent(u.password).length);
  assert.equal(u.username, replUserOf(m.names.fwd));
  assert.notEqual(decodeURIComponent(u.password), adminPw);
  assert.ok(decodeURIComponent(u.password).length >= 40);
  leaked = row.subconninfo;
});

test("전용 계정 권한: 복제 + 표 읽기만. 쓰기·관리자 아님", { skip }, async () => {
  const user = replUserOf(m.names.fwd);
  const [r] = await q(SOURCE, `SELECT rolsuper, rolreplication, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname=$1`, [user]);
  assert.deepEqual(r, { rolsuper: false, rolreplication: true, rolcreaterole: false, rolcreatedb: false });
  for (const t of TABLES) {
    const [p] = await q(SOURCE, `SELECT has_table_privilege($1, $2, 'SELECT') s, has_table_privilege($1, $2, 'INSERT,UPDATE,DELETE,TRUNCATE') w`, [user, `public.${t}`]);
    assert.deepEqual(p, { s: true, w: false }, t);
  }
  // 새어 나간 접속 문자열로 붙어도 쓰기는 안 된다
  const c = new pg.Client({ connectionString: leaked.replace(/:\d+\//, `:${new URL(SOURCE.adminUrl).port}/`).replace(new URL(leaked).hostname, new URL(SOURCE.adminUrl).hostname) });
  await c.connect();
  await assert.rejects(c.query(`INSERT INTO customers(name) VALUES ('x')`), /permission denied/);
  await c.end();
});

test("정리(teardown)하면 전용 계정이 사라지고, 새어 나간 비밀번호로는 접속이 안 된다", { skip }, async () => {
  const r = await m.teardown();
  log("removed", r.removed.join(" "));
  assert.ok(r.removed.some((x) => x.endsWith(`role:${replUserOf(m.names.fwd)}`)));
  assert.deepEqual(await m.leftovers(), []);
  const c = new pg.Client({ connectionString: leaked.replace(new URL(leaked).hostname, new URL(SOURCE.adminUrl).hostname).replace(/:\d+\//, `:${new URL(SOURCE.adminUrl).port}/`) });
  await assert.rejects(c.connect(), /password authentication failed|does not exist/);
});
