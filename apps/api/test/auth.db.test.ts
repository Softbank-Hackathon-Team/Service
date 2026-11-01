// Z93: 진짜 로그인 — DB 까지 한 바퀴 (buildApp + inject). 로그인 → 토큰으로 업무 경로 → 갱신(회전) → 재사용 감지 → 로그아웃
// 시험 사용자는 주인 계정으로 직접 넣는다 (0018: 앱 계정은 사용자 만들기 권한 없음). DB 없으면 건너뛴다
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const TA = "11111111-1111-4111-8111-111111111111";   // 0002 개발 회사 (환경 3개 이상)
const TB = "99999999-9999-4999-8999-0000000000b3";   // 이 시험만 쓰는 두 번째 회사 (환경 0개)
const PW = "test-password-z93";
const FAST = { N: 2 ** 14, r: 8, p: 1, keylen: 64 };
const emailA = `z93-a-${process.pid}@test.local`, emailB = `z93-b-${process.pid}@test.local`, emailOff = `z93-off-${process.pid}@test.local`;

async function seed() {
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  try {
    const h = await hashPassword(PW, FAST);
    await c.query("INSERT INTO tenants (id, name) VALUES ($1, 'z93-other') ON CONFLICT (id) DO NOTHING", [TB]);
    for (const [t, e, off] of [[TA, emailA, false], [TB, emailB, false], [TA, emailOff, true]] as const) {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [t]);
      await c.query(`INSERT INTO users (tenant_id, email, password_hash, disabled_at) VALUES ($1, $2, $3, ${off ? "now()" : "NULL"})
                     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [t, e, h]);
    }
  } finally { await c.end(); }
}

const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const sc = String(r.headers["set-cookie"] ?? "");
  return { raw: sc, value: /svc_refresh=([^;]*)/.exec(sc)?.[1] ?? "" };
};

test("로그인 한 바퀴: 토큰의 회사만 보이고, 갱신은 회전·재사용 감지, 로그아웃 뒤 갱신 불가", { skip }, async () => {
  process.env.AUTH_ROTATE_GRACE_MS = "0";
  await seed();
  const { app } = await buildApp();
  try {
    // 설정: npm test·test:db 는 DEV_AUTH=1 로 돈다
    const cfg = await app.inject({ url: "/api/v1/auth/config" });
    assert.deepEqual(cfg.json(), { devAuth: process.env.DEV_AUTH === "1", loginRequired: process.env.DEV_AUTH !== "1" });

    // 틀린 비밀번호·없는 이메일·막힌 계정: 같은 401 INVALID_CREDENTIALS (계정 있는지 안 알려 줌)
    for (const body of [{ email: emailA, password: "wrong-password" }, { email: "nobody@test.local", password: PW }, { email: emailOff, password: PW }]) {
      const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: body });
      assert.equal(r.statusCode, 401, JSON.stringify(body));
      assert.equal(r.json().code, "INVALID_CREDENTIALS");
    }

    // 로그인 (대문자 이메일도 같은 계정)
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: emailA.toUpperCase(), password: PW } });
    assert.equal(login.statusCode, 200, login.body);
    const L = login.json();
    assert.equal(L.tokenType, "Bearer");
    assert.equal(L.user.tenantId, TA);
    assert.equal(L.user.tenantName, "dev-company");
    const ck = cookieOf(login);
    assert.match(ck.raw, /HttpOnly/);
    assert.match(ck.raw, /SameSite=Strict/);
    assert.match(ck.raw, /Path=\/api(;|$)/);
    assert.doesNotMatch(ck.raw, /Secure/);   // http 요청
    assert.equal(login.headers["cache-control"], "no-store");

    // 토큰으로 업무 경로: 회사 A 의 환경이 보인다
    const auth = { authorization: `Bearer ${L.accessToken}` };
    const envA = await app.inject({ url: "/api/v1/environments", headers: auth });
    assert.equal(envA.statusCode, 200);
    assert.ok(envA.json().items.length >= 3);
    const me = await app.inject({ url: "/api/v1/auth/me", headers: auth });
    assert.equal(me.json().email, emailA);

    // 회사 B 사용자 토큰으로는 회사 A 환경이 하나도 안 보인다 (RLS). x-dev-tenant 로 A 를 넣어도 토큰이 이긴다
    const lb = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: emailB, password: PW } });
    const envB = await app.inject({ url: "/api/v1/environments", headers: { authorization: `Bearer ${lb.json().accessToken}`, "x-dev-tenant": TA } });
    assert.deepEqual(envB.json().items, []);

    // 갱신: 새 쿠키·새 토큰. 옛 쿠키를 다시 쓰면 재사용 → 묶음 전체 끊김 → 새 쿠키도 401
    const r1 = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { cookie: `svc_refresh=${ck.value}` } });
    assert.equal(r1.statusCode, 200, r1.body);
    const ck2 = cookieOf(r1);
    assert.notEqual(ck2.value, ck.value);
    const reuse = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { cookie: `svc_refresh=${ck.value}` } });
    assert.equal(reuse.statusCode, 401);
    assert.equal(reuse.json().code, "REFRESH_INVALID");
    const afterReuse = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { cookie: `svc_refresh=${ck2.value}` } });
    assert.equal(afterReuse.statusCode, 401, "재사용 감지 뒤에는 같은 묶음의 새 토큰도 무효");

    // 로그아웃: 204 + 쿠키 지움, 그 쿠키로 갱신 불가
    const l2 = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: emailA, password: PW } });
    const ck3 = cookieOf(l2);
    // z75-69: 로그아웃 전에 한 번 갱신 → 회전 전 토큰(t0)과 회전 뒤 토큰(t1) 둘 다 로그아웃 뒤엔 막혀야 한다
    const t0 = { authorization: `Bearer ${l2.json().accessToken}` };
    const r2 = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { cookie: `svc_refresh=${ck3.value}` } });
    assert.equal(r2.statusCode, 200, r2.body);
    const t1 = { authorization: `Bearer ${r2.json().accessToken}` };
    assert.equal((await app.inject({ url: "/api/v1/environments", headers: t1 })).statusCode, 200);
    const ck4 = cookieOf(r2);
    const out = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: `svc_refresh=${ck4.value}` } });
    assert.equal(out.statusCode, 204);
    assert.match(cookieOf(out).raw, /Max-Age=0/);
    const r3 = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { cookie: `svc_refresh=${ck4.value}` } });
    assert.equal(r3.statusCode, 401);
    for (const [name, h] of [["회전 전 토큰", t0], ["로그아웃 직전 토큰", t1]] as const) {
      const g = await app.inject({ url: "/api/v1/environments", headers: h });
      assert.equal(g.statusCode, 401, name); assert.equal(g.json().code, "TOKEN_REVOKED", name);
    }
    // 재사용 감지로 끊긴 묶음(첫 로그인 L)의 접근 토큰도 막힌다. 다른 사용자(회사 B) 토큰은 그대로
    assert.equal((await app.inject({ url: "/api/v1/environments", headers: auth })).json().code, "TOKEN_REVOKED");
    assert.equal((await app.inject({ url: "/api/v1/environments", headers: { authorization: `Bearer ${lb.json().accessToken}` } })).statusCode, 200);

    // 감사 기록: 로그인 성공·실패·재사용·로그아웃이 회사 A 감사에 남는다
    const c = new pg.Client({ connectionString: OWNER });
    await c.connect();
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      const a = await c.query(`SELECT action, result FROM audit_events WHERE action LIKE 'auth.%' ORDER BY seq`);
      const seen = new Set(a.rows.map((x: { action: string; result: string }) => `${x.action}:${x.result}`));
      for (const k of ["auth.login:denied", "auth.login:ok", "auth.refresh_reuse:denied", "auth.logout:ok"]) assert.ok(seen.has(k), k);
    } finally { await c.end(); }
  } finally {
    delete process.env.AUTH_ROTATE_GRACE_MS;
    await app.close();
  }
});

test("로그인 실패 5번이면 429 TOO_MANY_ATTEMPTS + retry-after (맞는 비밀번호도 잠시 막힘)", { skip }, async () => {
  await seed();
  const { app } = await buildApp();
  try {
    const email = `z93-lock-${process.pid}@test.local`;
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "wrong-password" }, remoteAddress: "198.51.100.9" });
      assert.equal(r.statusCode, 401);
    }
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "wrong-password" }, remoteAddress: "198.51.100.9" });
    assert.equal(r.statusCode, 429);
    assert.equal(r.json().code, "TOO_MANY_ATTEMPTS");
    assert.ok(Number(r.headers["retry-after"]) > 0);
  } finally { await app.close(); }
});
