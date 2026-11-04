// PF-E20 (FM-APP-hunt-deploy-db-01): 전용 복제 계정 비밀번호를 평문 대신 SCRAM 검증자로 넘긴다 → 서버 로그(log_statement=ddl)에 평문이 안 남고, 평문으로 접속은 된다
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { ensureReplUser, dropReplUser, replUserOf, withClient } from "../src/index.js";
import { scramVerifier } from "../src/repluser.js";
import { SOURCE, q, reachable } from "./harness.js";

const up = await reachable(SOURCE);
const skip = up ? false : "Postgres(55432) 없음";
const NAME = "repl_pfe20_fwd";
after(async () => { if (up) await withClient(SOURCE, (c) => dropReplUser(c, NAME)).catch(() => undefined); });

test("PF-E20 단위: 검증자 모양 (RFC 7677 시험 벡터)", () => {
  // RFC 7677 3절: 비밀번호 pencil, salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096회
  const v = scramVerifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"));
  assert.equal(v, "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=");
});

test("PF-E20: 만든 계정의 pg_authid 는 SCRAM, 돌려받은 평문으로 접속된다", { skip }, async () => {
  await q(SOURCE, `CREATE PUBLICATION ${NAME}`).catch(() => undefined);
  try {
    const { user, password } = await withClient(SOURCE, (c) => ensureReplUser(c, SOURCE, NAME));
    assert.equal(user, replUserOf(NAME));
    const [r] = await q(SOURCE, `SELECT rolpassword LIKE 'SCRAM-SHA-256$4096:%' ok FROM pg_authid WHERE rolname=$1`, [user]);
    assert.equal(r.ok, true);
    const u = new URL(SOURCE.adminUrl); u.username = user; u.password = password;
    const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
    try { assert.equal((await c.query("SELECT current_user u")).rows[0].u, user); } finally { await c.end(); }
  } finally { await q(SOURCE, `DROP PUBLICATION IF EXISTS ${NAME}`); }
});
