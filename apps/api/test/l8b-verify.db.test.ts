// 검증 L8b: 원문은 응답에 한 번뿐·DB 엔 해시만, 만료·삭제·끈 사용자 401, 남의 회사·남의 사용자 토큰 DELETE 404, ttlDays 경계, 모양 틀린 토큰,
// auth_token_lookup(SECURITY DEFINER) 의 search_path·PUBLIC 회수·주인 (db-lint D7 과 같은 기준)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const TA = "11111111-1111-4111-8111-111111111111";
const TB = "99999999-9999-4999-8999-0000000000c8";
const PW = "test-password-l8bv";
const FAST = { N: 2 ** 14, r: 8, p: 1, keylen: 64 };
const sfx = `${process.pid}`;
const eA1 = `l8bv-a1-${sfx}@test.local`, eA2 = `l8bv-a2-${sfx}@test.local`, eB = `l8bv-b-${sfx}@test.local`;

async function owner<T>(t: string, fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  try { await c.query("SELECT set_config('app.tenant_id', $1, false)", [t]); return await fn(c); } finally { await c.end(); }
}

test("토큰 수명·권한 경계 전부", { skip }, async () => {
  const h = await hashPassword(PW, FAST);
  await owner(TA, (c) => c.query("INSERT INTO tenants (id, name) VALUES ($1, 'l8bv-other') ON CONFLICT (id) DO NOTHING", [TB]));
  for (const [t, e] of [[TA, eA1], [TA, eA2], [TB, eB]] as const)
    await owner(t, (c) => c.query(`INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, disabled_at = NULL`, [t, e, h]));
  const { app } = await buildApp();
  const login = async (email: string) => ({ authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } })).json().accessToken}` });
  type Res = { statusCode: number; body: string; headers: Record<string, unknown>; json(): any };
  const mk = (hd: object, payload: object) => app.inject({ method: "POST", url: "/api/v1/tokens", headers: hd as Record<string, string>, payload: payload as Record<string, unknown> }) as unknown as Promise<Res>;
  const envs = (hd: object) => app.inject({ url: "/api/v1/environments", headers: hd as Record<string, string> }) as unknown as Promise<Res>;
  const rows = (t: string) => owner(t, (c) => c.query("SELECT id, token_hash, expires_at, created_at FROM personal_tokens WHERE tenant_id = $1", [t]));
  try {
    const a1 = await login(eA1), a2 = await login(eA2), b = await login(eB);

    // ttlDays 경계: 0·31·소수·글자·음수 400 / 1·30·생략(=30) 201. 이름 0자·65자 400
    for (const bad of [{ name: "x", ttlDays: 0 }, { name: "x", ttlDays: 31 }, { name: "x", ttlDays: 1.5 }, { name: "x", ttlDays: "7" },
      { name: "x", ttlDays: -1 }, { name: "", ttlDays: 7 }, { name: " ", ttlDays: 7 }, { name: "n".repeat(65), ttlDays: 7 }, { ttlDays: 7 }, { name: "x", ttlDays: 7, extra: 1 }])
      assert.equal((await mk(a1, bad)).statusCode, 400, JSON.stringify(bad));
    assert.equal((await rows(TA)).rowCount, 0, "거부된 요청은 줄을 안 만듦");
    const ttl = async (payload: object) => {
      const r = await mk(a1, payload); assert.equal(r.statusCode, 201, r.body);
      const x = (await rows(TA)).rows.find((q) => q.id === r.json().id)!;
      return { r, days: (x.expires_at.getTime() - x.created_at.getTime()) / 86400000 };
    };
    assert.ok(Math.abs((await ttl({ name: "one", ttlDays: 1 })).days - 1) < 0.01);
    const d30 = await ttl({ name: "thirty", ttlDays: 30 });
    assert.ok(Math.abs(d30.days - 30) < 0.01);
    assert.ok(Math.abs((await ttl({ name: "default" })).days - 30) < 0.01, "생략하면 30일");

    // 원문은 한 번: 응답에만, 같은 값은 GET·DB·감사 어디에도 없다. 응답은 no-store
    const c = await mk(a1, { name: "cli", ttlDays: 7 });
    assert.equal(c.statusCode, 201);
    assert.match(String(c.headers["cache-control"]), /no-store/);
    const { id, token } = c.json();
    const hash = createHash("sha256").update(token).digest("hex");
    assert.equal((await rows(TA)).rows.find((q) => q.id === id)!.token_hash, hash);
    const list = await app.inject({ url: "/api/v1/tokens", headers: a1 });
    assert.ok(!list.body.includes(token) && !list.body.includes(hash), "목록에 원문·해시 없음");
    const dump = await owner(TA, (cl) => cl.query("SELECT (SELECT string_agg(detail::text, ' ') FROM audit_events WHERE tenant_id=$1) a, (SELECT string_agg(t::text, ' ') FROM personal_tokens t) p", [TA]));
    assert.ok(!String(dump.rows[0].a).includes(token), "감사에 원문 없음");
    assert.ok(!String(dump.rows[0].p).includes(token), "표에 원문 없음");

    // 그 토큰으로 업무 경로. 모양이 틀린 것(길이·글자)은 401
    const pat = { authorization: `Bearer ${token}` };
    assert.equal((await envs(pat)).statusCode, 200);
    for (const bad of [token.slice(0, -1), token + "A", "svc_pat_", "svc_pat_" + "!".repeat(43), "svc_pat_" + "A".repeat(43), token.toUpperCase()])
      assert.equal((await envs({ authorization: `Bearer ${bad}` })).statusCode, 401, bad.slice(0, 20));

    // 남의 사용자(같은 회사) 토큰 DELETE 404, 남의 회사 404, 없는 id 404, 형식 틀린 id 400. 그 뒤에도 토큰은 산다
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/tokens/${id}`, headers: a2 })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/tokens/${id}`, headers: b })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/tokens/11111111-1111-4111-8111-aaaaaaaaaaaa`, headers: a1 })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/tokens/not-a-uuid`, headers: a1 })).statusCode, 400);
    assert.equal((await envs(pat)).statusCode, 200, "거부된 삭제는 토큰을 안 끊음");
    assert.equal((await app.inject({ url: "/api/v1/tokens", headers: a2 })).json().items.length, 0, "남의 목록에 안 보임");
    // 다른 회사에서 같은 토큰 원문을 써도 자기 회사 자원만 (토큰의 회사 = TA)
    assert.equal((await app.inject({ url: "/api/v1/tokens", headers: pat })).statusCode, 401, "토큰으로 토큰 목록도 불가");

    // 만료: 정확히 지금(<=) 401, 1초 뒤면 200
    await owner(TA, (cl) => cl.query("UPDATE personal_tokens SET expires_at = now() WHERE id = $1", [id]));
    assert.equal((await envs(pat)).statusCode, 401, "만료 시각 = 지금 → 401");
    await owner(TA, (cl) => cl.query("UPDATE personal_tokens SET expires_at = now() + interval '5 seconds' WHERE id = $1", [id]));
    assert.equal((await envs(pat)).statusCode, 200);

    // 끈 사용자: 토큰이 살아 있어도 401 USER_DISABLED
    await owner(TA, (cl) => cl.query("UPDATE users SET disabled_at = now() WHERE email = $1", [eA1]));
    const off = await envs(pat);
    assert.equal(off.statusCode, 401); assert.match(off.body, /USER_DISABLED/);
    await owner(TA, (cl) => cl.query("UPDATE users SET disabled_at = NULL WHERE email = $1", [eA1]));

    // DELETE: 204 → 이후 401, 두 번째 DELETE 404, 목록엔 revoked=true, 감사에 token.revoke
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/tokens/${id}`, headers: a1 })).statusCode, 204);
    assert.equal((await envs(pat)).statusCode, 401);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/tokens/${id}`, headers: a1 })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/v1/tokens", headers: a1 })).json().items.find((i: { id: string }) => i.id === id).revoked, true);
    const au = await owner(TA, (cl) => cl.query("SELECT action FROM audit_events WHERE tenant_id=$1 AND target=$2 ORDER BY seq", [TA, `token:${id}`]));
    assert.deepEqual(au.rows.map((r) => r.action), ["token.create", "token.revoke"]);

    // 사용자를 지우면(FK CASCADE) 토큰도 사라져 401
    const c2 = await mk(a2, { name: "gone", ttlDays: 2 });
    const pat2 = { authorization: `Bearer ${c2.json().token}` };
    assert.equal((await envs(pat2)).statusCode, 200);
    await owner(TA, (cl) => cl.query("DELETE FROM users WHERE email = $1", [eA2]));
    assert.equal((await envs(pat2)).statusCode, 401);
  } finally {
    for (const [t, e] of [[TA, eA1], [TA, eA2], [TB, eB]] as const) await owner(t, (cl) => cl.query("DELETE FROM users WHERE email = $1", [e]));
    await app.close();
  }
});

test("auth_token_lookup: SECURITY DEFINER · search_path 고정 · PUBLIC 실행 권한 없음 · 주인이 슈퍼유저 아님 (db-lint D7 기준)", { skip }, async () => {
  const r = await owner(TA, (c) => c.query(`
    SELECT p.prosecdef, p.proconfig, r.rolname, r.rolsuper, r.rolbypassrls,
           NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS no_public,
           has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_ok
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.proname = 'auth_token_lookup' AND p.pronamespace = 'public'::regnamespace`));
  assert.equal(r.rowCount, 1);
  const x = r.rows[0];
  assert.equal(x.prosecdef, true);
  assert.ok((x.proconfig as string[]).some((s) => /^search_path=pg_catalog, pg_temp$/.test(s)), `search_path: ${x.proconfig}`);
  assert.equal(x.no_public, true, "PUBLIC 실행 권한 없음");
  assert.equal(x.rolsuper, false); assert.equal(x.rolbypassrls, false);
  assert.equal(x.app_ok, true);
  // 앱 계정은 표를 직접 못 훑는다(RLS): 회사 번호 없이는 0줄. 함수로는 해시 하나로만 1줄
  const app = new pg.Client({ connectionString: DB }); await app.connect();
  try {
    assert.equal((await app.query("SELECT count(*)::int n FROM personal_tokens")).rows[0].n, 0, "회사 번호 없는 앱 계정은 표가 비어 보임");
    assert.equal((await app.query("SELECT * FROM auth_token_lookup($1)", ["0".repeat(64)])).rowCount, 0);
    await assert.rejects(app.query("UPDATE personal_tokens SET name = 'x'"), /permission denied/, "revoked_at 외 칸은 못 고침");
    await assert.rejects(app.query("DELETE FROM personal_tokens"), /permission denied/);
  } finally { await app.end(); }
});
