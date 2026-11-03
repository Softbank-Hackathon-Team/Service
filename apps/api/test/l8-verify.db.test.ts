// 검증 L8: 끈 사용자의 로그인·갱신 거부, auth-seed --disable 끝까지(세션 끊김·알림·멱등·남의 회사), 실패한 로그아웃은 알림 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const TA = "11111111-1111-4111-8111-111111111111";
const TB = "99999999-9999-4999-8999-0000000000b3";
const PW = "test-password-l8v";
const email = `l8v-${process.pid}@test.local`;

async function owner<T>(fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  try { await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]); return await fn(c); } finally { await c.end(); }
}
const seed = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--env-file=.env", "--import", "tsx", "tools/auth-seed.ts", ...args],
  { encoding: "utf8", env: { ...process.env, ...env } });

test("--disable: 토큰 401·세션 끊김·알림 disabled·두 번 해도 같음, 남의 회사/없는 사용자는 실패, 로그인·갱신 거부", { skip }, async () => {
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
    const cookie = /svc_refresh=([^;]*)/.exec(String(login.headers["set-cookie"]))?.[1] ?? "";
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    // 거부: 남의 회사로는 사용자를 못 찾음 / 없는 사용자 (알림 0)
    // (표 주인이 RLS 를 우회하는 환경이면 성공할 수 있다 → 그때도 알림의 회사는 사용자의 진짜 회사여야 한다. 아래 알림 검사가 본다)
    const wrong = seed(["--disable", email, "--tenant", TB]);
    await owner((c) => c.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [uid]));
    const wrongNote = wrong.status === 0 ? 1 : 0;
    assert.notEqual(seed(["--disable", "nobody@test.local"]).status, 0);
    // 이메일 생략 + --tenant: 옵션 글자가 이메일로 읽히지 않는다 (없는 사용자 메시지에 "--tenant" 없음)
    assert.doesNotMatch(seed(["--disable", "--tenant", TB], { DEMO_USER_EMAIL: "nobody@test.local" }).stderr, /--tenant/);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(got.length, wrongNote);
    assert.ok(got.every((g) => JSON.parse(g).t === TA), "알림의 회사 번호는 늘 사용자의 진짜 회사");
    got.length = 0;
    await owner((c) => c.query("UPDATE auth_sessions SET revoked_at = NULL, revoked_reason = NULL WHERE user_id = $1", [uid]));

    // 정상 + 멱등
    const r1 = seed(["--disable", email]); assert.equal(r1.status, 0, r1.stderr);
    const r2 = seed(["--disable", email]); assert.equal(r2.status, 0, r2.stderr);
    await new Promise((res) => setTimeout(res, 300));
    assert.deepEqual(got.map((g) => JSON.parse(g)), [{ t: TA, u: uid, r: "disabled" }, { t: TA, u: uid, r: "disabled" }]);
    const live = await owner((c) => c.query("SELECT count(*)::int n FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL", [uid]));
    assert.equal(live.rows[0].n, 0, "살아 있는 세션 0");
    assert.equal((await app.inject({ url: "/api/v1/environments", headers: auth })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { cookie: `svc_refresh=${cookie}` } })).statusCode, 401);

    // 실패한 로그아웃(엉터리 쿠키)은 알림을 보내지 않는다
    got.length = 0;
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: "svc_refresh=garbage" } });
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(got.length, 0);
  } finally {
    await listener.end();
    await owner((c) => c.query("DELETE FROM users WHERE email = $1", [email]));
    await app.close();
  }
});
