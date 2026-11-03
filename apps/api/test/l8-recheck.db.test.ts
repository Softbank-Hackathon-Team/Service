// L8: DB 까지 — 사용자를 끄면 받아 둔 토큰이 바로 401, 다른 회사 번호로는 사용자가 안 보여 거부, 로그아웃은 session_events 알림을 보낸다
// 표 주인 계정으로 시험 사용자를 넣는다. DB 없으면 건너뛴다
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { dbUserActive } from "../src/plugins/auth.js";
import { hashPassword } from "../src/auth/password.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const TA = "11111111-1111-4111-8111-111111111111";
const TB = "99999999-9999-4999-8999-0000000000b3";
const PW = "test-password-l8";
const email = `l8-${process.pid}@test.local`;

async function owner<T>(fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  try { await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]); return await fn(c); } finally { await c.end(); }
}

test("재확인: 사용자를 끄면 같은 토큰이 다음 요청부터 401, 다른 회사로는 안 보인다, 로그아웃이 알림을 보낸다", { skip }, async () => {
  const h = await hashPassword(PW, { N: 2 ** 14, r: 8, p: 1, keylen: 64 });
  const uid = await owner(async (c) => (await c.query(
    `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, disabled_at = NULL RETURNING id`, [TA, email, h])).rows[0].id as string);
  const { app } = await buildApp();
  const listener = new pg.Client({ connectionString: OWNER });
  await listener.connect();
  const got: string[] = [];
  listener.on("notification", (m) => got.push(m.payload ?? ""));
  await listener.query("LISTEN session_events");
  try {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    assert.equal(login.statusCode, 200);
    const auth = { authorization: `Bearer ${login.json().accessToken}` };
    assert.equal((await app.inject({ url: "/api/v1/environments", headers: auth })).statusCode, 200);
    assert.equal(await dbUserActive(TB, uid), false, "다른 회사 번호로는 사용자가 안 보인다");
    await owner((c) => c.query("UPDATE users SET disabled_at = now() WHERE id = $1", [uid]));
    const r = await app.inject({ url: "/api/v1/environments", headers: auth });
    assert.equal(r.statusCode, 401);
    // 다시 켜고 로그아웃 → 알림 {t,u,r:"logout"}
    await owner((c) => c.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [uid]));
    const l2 = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    const cookie = /svc_refresh=([^;]*)/.exec(String(l2.headers["set-cookie"]))?.[1] ?? "";
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: `svc_refresh=${cookie}` } });
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(got.map((g) => JSON.parse(g)), [{ t: TA, u: uid, r: "logout" }]);
  } finally {
    await listener.end();
    await owner((c) => c.query("DELETE FROM users WHERE email = $1", [email]));
    await app.close();
  }
});
