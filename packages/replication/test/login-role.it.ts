// 도착 앱 로그인 역할 (Cloud SQL API 사용자는 cloudsqlsuperuser 라 울타리가 안 먹음 → 워커가 SQL 로 일반 역할을 만든다)
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { ensureLoginRole } from "../src/index.js";
import { TARGET, q, reachable } from "./harness.js";

const up = await reachable(TARGET);
const skip = up ? false : "docker Postgres(55433)가 안 떠 있음: npm run db:up";
const login = async (user: string, pw: string) => {
  const u = new URL(TARGET.adminUrl); u.username = user; u.password = pw;
  const c = new pg.Client({ connectionString: u.toString() });
  try { await c.connect(); return (await c.query<{ u: string }>("SELECT current_user u")).rows[0]!.u; } finally { await c.end().catch(() => {}); }
};

before(async () => {
  if (!up) return;
  await q(TARGET, `DROP ROLE IF EXISTS lr_app; DROP ROLE IF EXISTS lr_priv; DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser') THEN CREATE ROLE cloudsqlsuperuser NOLOGIN; END IF; END $$;
    CREATE ROLE lr_priv LOGIN PASSWORD 'x'; GRANT cloudsqlsuperuser TO lr_priv`);
});
after(async () => { if (up) await q(TARGET, `DROP ROLE IF EXISTS lr_app; DROP ROLE IF EXISTS lr_priv`).catch(() => undefined); });

test("없으면 일반 LOGIN 역할로 만들고, 다시 부르면 비밀번호만 맞춘다 (관리자 역할 없음)", { skip }, async () => {
  const c = new pg.Client({ connectionString: TARGET.adminUrl }); await c.connect();
  try {
    assert.equal(await ensureLoginRole(c, "lr_app", "pw-1"), "created");
    assert.equal(await login("lr_app", "pw-1"), "lr_app");
    assert.equal(await ensureLoginRole(c, "lr_app", "pw-2"), "updated");
    assert.equal(await login("lr_app", "pw-2"), "lr_app");
    const r = (await c.query(`SELECT rolsuper, pg_has_role('lr_app', 'cloudsqlsuperuser', 'USAGE') csql FROM pg_roles WHERE rolname = 'lr_app'`)).rows[0];
    assert.deepEqual([r.rolsuper, r.csql], [false, false]);
  } finally { await c.end(); }
});

test("관리자 역할을 물려받은 계정은 손대지 않는다 (DB-08 이 막게)", { skip }, async () => {
  const c = new pg.Client({ connectionString: TARGET.adminUrl }); await c.connect();
  try {
    assert.equal(await ensureLoginRole(c, "lr_priv", "other"), "privileged");
    assert.equal(await login("lr_priv", "x"), "lr_priv");
  } finally { await c.end(); }
});
