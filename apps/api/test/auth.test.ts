// Z93: 진짜 로그인 — DB 없이 도는 부분 (비밀번호 해시, JWT, 실패 횟수 제한, 인증 훅 순서)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { authPlugin } from "../src/plugins/auth.js";
import { hashPassword, verifyPassword, parseHash } from "../src/auth/password.js";
import { signAccess, verifyAccess, jwtSecretProblem } from "../src/auth/jwt.js";
import { LoginLimiter, LOGIN_MAX_PER_ID } from "../src/auth/limiter.js";
import { parseRefresh } from "../src/auth/store.js";

const T = "11111111-1111-4111-8111-111111111111";
const U = "66666666-6666-4666-8666-666666666666";
const S = "77777777-7777-4777-8777-777777777777";
const F = "88888888-8888-4888-8888-888888888888";
const SECRET = Buffer.from("x".repeat(40));
const FAST = { N: 2 ** 14, r: 8, p: 1, keylen: 64 };

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  return fn().finally(() => { for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
}

test("비밀번호: scrypt 해시 모양, 맞으면 true·틀리면 false, 같은 비밀번호도 소금이 달라 해시가 다르다", async () => {
  const h1 = await hashPassword("correct horse battery", FAST);
  const h2 = await hashPassword("correct horse battery", FAST);
  assert.match(h1, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  assert.notEqual(h1, h2);
  assert.equal(await verifyPassword("correct horse battery", h1), true);
  assert.equal(await verifyPassword("correct horse batterY", h1), false);
  assert.equal(await verifyPassword("whatever", null), false);          // 비밀번호 없는 계정 = 로그인 불가
  assert.equal(await verifyPassword("whatever", "plain-text"), false);  // 모양이 틀린 저장값
  assert.equal(parseHash("scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86)), null); // 터무니없는 N 은 거부(메모리 보호)
  await assert.rejects(hashPassword("short", FAST), RangeError);
});

test("JWT: 서명·만료·발급자·대상·alg 를 확인한다 (none·HS512·변조·만료·다른 비밀 거부)", () => {
  const now = 1_800_000_000;
  const tok = signAccess({ sub: U, tid: T, sid: S, fam: F, email: "a@b.c" }, SECRET, 900, now);
  const c = verifyAccess(tok, SECRET, now + 10);
  assert.equal(c?.tid, T);
  assert.equal(c?.sub, U);
  assert.equal(verifyAccess(tok, Buffer.from("y".repeat(40)), now), null, "다른 비밀");
  assert.equal(verifyAccess(tok, SECRET, now + 900 + 31), null, "만료(+시계 오차 30초)");
  const [h, p] = tok.split(".") as [string, string, string];
  const body = JSON.parse(Buffer.from(p, "base64url").toString());
  const forged = Buffer.from(JSON.stringify({ ...body, tid: "22222222-2222-4222-8222-222222222222" })).toString("base64url");
  assert.equal(verifyAccess(`${h}.${forged}.${tok.split(".")[2]}`, SECRET, now), null, "본문 변조(회사 바꾸기)");
  const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  assert.equal(verifyAccess(`${none}.${p}.`, SECRET, now), null, "alg none");
  const h512 = Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT" })).toString("base64url");
  const sig512 = createHmac("sha512", SECRET).update(`${h512}.${p}`).digest("base64url");
  assert.equal(verifyAccess(`${h512}.${p}.${sig512}`, SECRET, now), null, "alg 바꿔치기");
  const otherAud = Buffer.from(JSON.stringify({ ...body, aud: "other" })).toString("base64url");
  const sigAud = createHmac("sha256", SECRET).update(`${h}.${otherAud}`).digest("base64url");
  assert.equal(verifyAccess(`${h}.${otherAud}.${sigAud}`, SECRET, now), null, "다른 대상(aud)");
});

test("JWT_SECRET: 운영에서 없거나 짧으면 문제로 알린다 (main.ts 가 시작을 멈춤)", () => {
  assert.match(String(jwtSecretProblem({ NODE_ENV: "production" })), /required/);
  assert.match(String(jwtSecretProblem({ JWT_SECRET: "short" })), /32/);
  assert.equal(jwtSecretProblem({ NODE_ENV: "production", JWT_SECRET: "z".repeat(32) }), null);
  assert.equal(jwtSecretProblem({}), null); // 개발: 프로세스마다 무작위
});

test("실패 횟수 제한: 같은 IP+이메일 5번 실패하면 막히고, 15분 지나면 풀린다. 다른 이메일은 따로", () => {
  let now = 0;
  const l = new LoginLimiter(() => now);
  for (let i = 0; i < LOGIN_MAX_PER_ID; i++) { assert.equal(l.blockedFor("1.2.3.4", "a@b.c"), 0); l.fail("1.2.3.4", "a@b.c"); }
  assert.ok(l.blockedFor("1.2.3.4", "a@b.c") > 0);
  assert.equal(l.blockedFor("1.2.3.4", "x@b.c"), 0);
  now += 15 * 60_000;
  assert.equal(l.blockedFor("1.2.3.4", "a@b.c"), 0);
});

test("리프레시 토큰 모양: <세션 uuid>.<43자 base64url> 만 받는다", () => {
  assert.deepEqual(parseRefresh(`${S}.${"A".repeat(43)}`), { sid: S, secret: "A".repeat(43) });
  for (const bad of [undefined, "", S, `${S}.short`, `not-uuid.${"A".repeat(43)}`, `${S}.${"A".repeat(42)}!`]) assert.equal(parseRefresh(bad), null);
});

async function app() {
  const a = Fastify();
  await a.register(authPlugin);
  await a.register(async (r) => {
    r.get("/migrations", async (req) => ({ tenant: req.tenantId, actor: req.actor, sub: req.auth?.sub ?? null }));
    r.post("/auth/login", async () => ({ reached: true }));
  }, { prefix: "/api/v1" });
  return a;
}

test("인증 훅: Bearer 토큰이면 토큰의 회사 번호, 헤더 x-dev-tenant 는 무시", async () => {
  await withEnv({ JWT_SECRET: SECRET.toString(), DEV_AUTH: "1" }, async () => {
    const a = await app();
    const tok = signAccess({ sub: U, tid: T, sid: S, fam: F, email: "a@b.c" }, SECRET, 900);
    const r = await a.inject({ url: "/api/v1/migrations", headers: { authorization: `Bearer ${tok}`, "x-dev-tenant": "22222222-2222-4222-8222-222222222222" } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { tenant: T, actor: `user:${U}`, sub: U });
    const bad = await a.inject({ url: "/api/v1/migrations", headers: { authorization: `Bearer ${tok}x` } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().code, "UNAUTHENTICATED");
    await a.close();
  });
});

test("인증 훅: DEV_AUTH 없으면 x-dev-tenant 헤더는 401, DEV_AUTH=1 이면 예전처럼 통과, 운영이면 DEV_AUTH=1 이어도 401", async () => {
  for (const [env, want] of [
    [{ DEV_AUTH: undefined, NODE_ENV: undefined }, 401],
    [{ DEV_AUTH: "1", NODE_ENV: undefined }, 200],
    [{ DEV_AUTH: "1", NODE_ENV: "production" }, 401],
    [{ DEV_AUTH: "1", NODE_ENV: undefined, AUTH_MODE: "real" }, 401],
  ] as const) {
    await withEnv({ AUTH_MODE: undefined, ...env }, async () => {
      const a = await app();
      const r = await a.inject({ url: "/api/v1/migrations", headers: { "x-dev-tenant": T } });
      assert.equal(r.statusCode, want, JSON.stringify(env));
      await a.close();
    });
  }
});

test("인증 훅: /auth/login 은 토큰 없이 처리기까지 간다 (DEV_AUTH 없어도)", async () => {
  await withEnv({ DEV_AUTH: undefined }, async () => {
    const a = await app();
    const r = await a.inject({ method: "POST", url: "/api/v1/auth/login", payload: {} });
    assert.equal(r.statusCode, 200);
    await a.close();
  });
});

test("z75-69: 로그아웃한 로그인 묶음(fam)의 토큰은 만료 전이라도 401 TOKEN_REVOKED, 다른 묶음은 그대로, 기간 지나면 목록에서 빠짐", async () => {
  const { revokeFamily, isFamilyRevoked, revokedCount, pruneRevoked } = await import("../src/auth/revoked.js");
  await withEnv({ JWT_SECRET: SECRET.toString(), DEV_AUTH: "1" }, async () => {
    const a = await app();
    const F2 = "99999999-9999-4999-8999-999999999999";
    const mine = signAccess({ sub: U, tid: T, sid: S, fam: F, email: "a@b.c" }, SECRET, 900);
    const other = signAccess({ sub: U, tid: T, sid: S, fam: F2, email: "a@b.c" }, SECRET, 900);
    revokeFamily(F, 900);
    const r = await a.inject({ url: "/api/v1/migrations", headers: { authorization: `Bearer ${mine}` } });
    assert.equal(r.statusCode, 401); assert.equal(r.json().code, "TOKEN_REVOKED");
    assert.equal((await a.inject({ url: "/api/v1/migrations", headers: { authorization: `Bearer ${other}` } })).statusCode, 200);
    // fam 이 없는 예전 모양 토큰은 받지 않는다 (화면은 401 → 갱신으로 새 토큰)
    const [h, p] = other.split(".") as [string, string, string];
    const body = JSON.parse(Buffer.from(p, "base64url").toString()); delete body.fam;
    const data = `${h}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
    assert.equal(verifyAccess(`${data}.${createHmac("sha256", SECRET).update(data).digest("base64url")}`, SECRET), null);
    await a.close();
  });
  const now = Date.now();
  revokeFamily("fam-x", 1, now);
  assert.equal(isFamilyRevoked("fam-x", now + 999), true);
  assert.equal(isFamilyRevoked("fam-x", now + 1000), false);
  pruneRevoked(now + 10_000_000);
  assert.equal(revokedCount(), 0);
});

// 로그인 점검: 프록시 뒤 접속 IP. 켜면 그 헤더, 끄거나 이상한 값이면 req.ip
import { clientIp } from "../src/auth/http.js";
test("clientIp 정상: AUTH_CLIENT_IP_HEADER 가 켜지면 그 헤더의 IP 로 사용자마다 칸이 갈린다", () => {
  const req = { ip: "127.0.0.1", headers: { "cf-connecting-ip": "203.0.113.9" } } as never;
  assert.equal(clientIp(req, { AUTH_CLIENT_IP_HEADER: "CF-Connecting-IP" }), "203.0.113.9");
  assert.equal(clientIp({ ip: "127.0.0.1", headers: { "cf-connecting-ip": "2001:db8::1" } } as never, { AUTH_CLIENT_IP_HEADER: "cf-connecting-ip" }), "2001:db8::1");
});
test("clientIp 거부: 꺼져 있거나 헤더가 IP 가 아니거나 여러 개면 req.ip (헤더로 제한 피하기 막음)", () => {
  const mk = (v: string) => ({ ip: "127.0.0.1", headers: { "cf-connecting-ip": v } }) as never;
  assert.equal(clientIp(mk("203.0.113.9"), {}), "127.0.0.1");
  assert.equal(clientIp(mk("203.0.113.9, 10.0.0.1"), { AUTH_CLIENT_IP_HEADER: "cf-connecting-ip" }), "127.0.0.1");
  assert.equal(clientIp(mk("evil<script>"), { AUTH_CLIENT_IP_HEADER: "cf-connecting-ip" }), "127.0.0.1");
});
