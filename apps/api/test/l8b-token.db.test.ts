// L8b: DB 까지 — 만들기 → 그 토큰으로 업무 경로 → 목록(원문 없음, DB엔 해시만) → 만료 → 남의 회사 404 → DELETE 뒤 401 → 토큰으로 토큰 만들기 불가
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const TA = "11111111-1111-4111-8111-111111111111";
const TB = "99999999-9999-4999-8999-0000000000b8";
const PW = "test-password-l8b";
const FAST = { N: 2 ** 14, r: 8, p: 1, keylen: 64 };
const eA = `l8b-a-${process.pid}@test.local`, eB = `l8b-b-${process.pid}@test.local`;

async function owner<T>(t: string, fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  try { await c.query("SELECT set_config('app.tenant_id', $1, false)", [t]); return await fn(c); } finally { await c.end(); }
}

test("개인 토큰 한 바퀴", { skip }, async () => {
  const h = await hashPassword(PW, FAST);
  await owner(TA, (c) => c.query("INSERT INTO tenants (id, name) VALUES ($1, 'l8b-other') ON CONFLICT (id) DO NOTHING", [TB]));
  for (const [t, e] of [[TA, eA], [TB, eB]] as const)
    await owner(t, (c) => c.query(`INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, disabled_at = NULL`, [t, e, h]));
  const { app } = await buildApp();
  const login = async (email: string) => ({ authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } })).json().accessToken}` });
  try {
    const a = await login(eA), b = await login(eB);
    const c = await app.inject({ method: "POST", url: "/api/v1/tokens", headers: a, payload: { name: "cli", ttlDays: 7 } });
    assert.equal(c.statusCode, 201);
    const { id, token } = c.json();
    assert.match(token, /^svc_pat_[A-Za-z0-9_-]{43}$/);
    const stored = await owner(TA, (cl) => cl.query("SELECT token_hash FROM personal_tokens WHERE id = $1", [id]));
    assert.match(stored.rows[0].token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.rows[0].token_hash, token);
    const pat = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ url: "/api/v1/environments", headers: pat })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/tokens", headers: pat, payload: { name: "x" } })).statusCode, 401, "토큰으로 토큰 못 만듦");
    const list = (await app.inject({ url: "/api/v1/tokens", headers: a })).json();
    assert.equal(list.items.length, 1);
    assert.equal(JSON.stringify(list).includes(token), false);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/tokens/${id}`, headers: b })).statusCode, 404, "남의 회사 토큰");
    // 만료
    await owner(TA, (cl) => cl.query("UPDATE personal_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [id]));
    assert.equal((await app.inject({ url: "/api/v1/environments", headers: pat })).statusCode, 401, "만료");
    await owner(TA, (cl) => cl.query("UPDATE personal_tokens SET expires_at = now() + interval '1 day' WHERE id = $1", [id]));
    assert.equal((await app.inject({ url: "/api/v1/environments", headers: pat })).statusCode, 200);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/tokens/${id}`, headers: a })).statusCode, 204);
    assert.equal((await app.inject({ url: "/api/v1/environments", headers: pat })).statusCode, 401, "끊은 뒤");
  } finally {
    await owner(TA, (cl) => cl.query("DELETE FROM users WHERE email = $1", [eA]));
    await owner(TB, (cl) => cl.query("DELETE FROM users WHERE email = $1", [eB]));
    await app.close();
  }
});
