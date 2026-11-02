import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError, createAuth, EARLY_REFRESH_SEC } from "../legacy/src/auth";
import { createClient, HttpError } from "../legacy/src/http";

// Z96: 로그인 상태(auth.ts)와 http.ts 의 Bearer·401 처리를 브라우저 없이 확인한다

type Reply = { status: number; body?: unknown };
type Call = { url: string; init: RequestInit };
const USER = { id: "u1", email: "demo@dev-company.test", displayName: null, tenantId: "11111111-1111-4111-8111-111111111111", tenantName: "dev" };
const tok = (n: number, expiresIn = 900) => ({ accessToken: `t${n}`, tokenType: "Bearer", expiresIn, user: USER });

// 경로별 응답 줄. 줄이 비면 마지막 응답을 반복한다
function server(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const q = routes[key];
    if (!q) return new Response(null, { status: 404 });
    const r = q.length > 1 ? q.shift()! : q[0]!;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls, n: (key: string) => calls.filter((c) => `${c.init.method ?? "GET"} ${c.url}` === key).length };
}

test("옛 서버(/auth/config 404) → dev 모드, refresh 안 보냄", async () => {
  const s = server({});
  const a = createAuth({ base: "/api", fetch: s.f });
  const st = await a.bootstrap();
  assert.equal(st.mode, "dev");
  assert.equal(s.n("POST /api/auth/refresh"), 0);
  assert.equal(await a.accessToken(), null);
});

test("devAuth 서버 + 쿠키 없음 → dev 모드(로그인 없이 계속), 로그인 버튼으로 jwt 화면", async () => {
  const s = server({ "GET /api/auth/config": [{ status: 200, body: { devAuth: true, loginRequired: false } }],
    "POST /api/auth/refresh": [{ status: 401, body: { code: "REFRESH_INVALID" } }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  const st = await a.bootstrap();
  assert.equal(st.mode, "dev"); assert.equal(st.devAuth, true);
  a.askLogin();
  assert.equal(a.get().needLogin, true);
  a.continueDev();
  assert.equal(a.get().mode, "dev");
});

test("로그인 필수 + 쿠키 없음 → 로그인 화면, 로그인 성공 → 토큰·사용자", async () => {
  const s = server({ "GET /api/auth/config": [{ status: 200, body: { devAuth: false, loginRequired: true } }],
    "POST /api/auth/refresh": [{ status: 401 }], "POST /api/auth/login": [{ status: 200, body: tok(1) }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  const st = await a.bootstrap();
  assert.equal(st.mode, "jwt"); assert.equal(st.needLogin, true); assert.equal(st.notice, null);
  await a.login("demo@dev-company.test", "pw");
  assert.equal(a.get().needLogin, false);
  assert.equal(a.get().user?.tenantId, USER.tenantId);
  assert.equal(await a.accessToken(), "t1");
  const login = s.calls.find((c) => c.url === "/api/auth/login")!;
  assert.equal(login.init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(String(login.init.body)), { email: "demo@dev-company.test", password: "pw" });
});

test("쿠키 살아 있음 → 로그인 화면 없이 들어감. 새로 고침 = bootstrap 한 번만", async () => {
  const s = server({ "GET /api/auth/config": [{ status: 200, body: { devAuth: false, loginRequired: true } }],
    "POST /api/auth/refresh": [{ status: 200, body: tok(1) }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await Promise.all([a.bootstrap(), a.bootstrap()]); // StrictMode 두 번
  assert.equal(s.n("POST /api/auth/refresh"), 1);
  assert.equal(a.get().needLogin, false);
});

test("로그인 실패 401 → 한국어 문구, 429 → 기다리라는 문구", async () => {
  const s = server({ "GET /api/auth/config": [{ status: 200, body: { devAuth: false, loginRequired: true } }],
    "POST /api/auth/refresh": [{ status: 401 }],
    "POST /api/auth/login": [{ status: 401, body: { code: "INVALID_CREDENTIALS" } }, { status: 429, body: { code: "TOO_MANY_ATTEMPTS" } }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.bootstrap();
  await assert.rejects(a.login("x@y.z", "no"), (e: unknown) => e instanceof AuthError && e.code === "INVALID_CREDENTIALS" && /맞지 않아/.test(e.message));
  await assert.rejects(a.login("x@y.z", "no"), (e: unknown) => e instanceof AuthError && e.status === 429 && /잠시 뒤/.test(e.message));
  assert.equal(a.get().needLogin, true);
});

test("만료 30초 전이면 요청 전에 미리 refresh", async () => {
  let t = 0;
  const s = server({ "GET /api/auth/config": [{ status: 200, body: { devAuth: false, loginRequired: true } }],
    "POST /api/auth/refresh": [{ status: 200, body: tok(1, 900) }, { status: 200, body: tok(2, 900) }] });
  const a = createAuth({ base: "/api", fetch: s.f, now: () => t });
  await a.bootstrap();
  assert.equal(await a.accessToken(), "t1");
  t = (900 - EARLY_REFRESH_SEC + 1) * 1000;
  assert.equal(await a.accessToken(), "t2");
  assert.equal(s.n("POST /api/auth/refresh"), 2);
});

test("http: 토큰이 있으면 Bearer 만, x-dev-tenant 안 보냄. 401 → refresh 한 번 → 같은 키로 다시", async () => {
  const s = server({ "GET /api/auth/config": [{ status: 200, body: { devAuth: false, loginRequired: true } }],
    "POST /api/auth/refresh": [{ status: 200, body: tok(1) }, { status: 200, body: tok(2) }],
    "POST /api/migrations": [{ status: 401, body: { code: "UNAUTHENTICATED" } }, { status: 201, body: { id: "m1" } }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.bootstrap();
  const c = createClient({ base: "/api", tenant: () => "dev-tenant", fetch: s.f, token: () => a.accessToken(), onUnauthorized: () => a.onUnauthorized(), newKey: () => "k1" });
  assert.deepEqual(await c.post("/migrations", { a: 1 }), { id: "m1" });
  const sent = s.calls.filter((x) => x.url === "/api/migrations");
  assert.equal(sent.length, 2);
  const h0 = sent[0]!.init.headers as Record<string, string>, h1 = sent[1]!.init.headers as Record<string, string>;
  assert.equal(h0.authorization, "Bearer t1"); assert.equal(h1.authorization, "Bearer t2");
  assert.equal(h0["x-dev-tenant"], undefined);
  assert.equal(h0["idempotency-key"], "k1"); assert.equal(h1["idempotency-key"], "k1");
});

test("http: refresh 도 실패하면 401 을 던지고 로그인 화면(세션 끝 안내)", async () => {
  const s = server({ "GET /api/auth/config": [{ status: 200, body: { devAuth: false, loginRequired: true } }],
    "POST /api/auth/refresh": [{ status: 200, body: tok(1) }, { status: 401, body: { code: "REFRESH_INVALID" } }],
    "GET /api/migrations": [{ status: 401 }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.bootstrap();
  const c = createClient({ base: "/api", tenant: () => "x", fetch: s.f, token: () => a.accessToken(), onUnauthorized: () => a.onUnauthorized() });
  await assert.rejects(c.get("/migrations"), (e: unknown) => e instanceof HttpError && e.status === 401);
  assert.equal(a.get().needLogin, true);
  assert.match(a.get().notice ?? "", /다시 로그인/);
  assert.equal(s.calls.filter((x) => x.url === "/api/migrations").length, 1);
});

test("dev 모드: 예전처럼 x-dev-tenant, Authorization 없음", async () => {
  const s = server({ "GET /api/healthz": [{ status: 200, body: { ok: true } }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.bootstrap();
  const c = createClient({ base: "/api", tenant: () => "tenant-1", fetch: s.f, token: () => a.accessToken(), onUnauthorized: () => a.onUnauthorized() });
  await c.get("/healthz");
  const h = s.calls.at(-1)!.init.headers as Record<string, string>;
  assert.equal(h["x-dev-tenant"], "tenant-1"); assert.equal(h.authorization, undefined);
});

test("로그아웃 → 서버에 logout, 토큰 지움, 로그인 화면", async () => {
  const s = server({ "GET /api/auth/config": [{ status: 200, body: { devAuth: false, loginRequired: true } }],
    "POST /api/auth/refresh": [{ status: 200, body: tok(1) }], "POST /api/auth/logout": [{ status: 204 }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.bootstrap();
  await a.logout();
  assert.equal(s.n("POST /api/auth/logout"), 1);
  assert.equal(a.get().needLogin, true); assert.equal(a.get().user, null);
});

test("config 401(옛 모의 API)·네트워크 오류 → dev. dev 인데 보호 경로 401 → 로그인 화면", async () => {
  const s = server({ "GET /api/auth/config": [{ status: 401 }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  assert.equal((await a.bootstrap()).mode, "dev");
  assert.equal(await a.onUnauthorized(), false);
  assert.equal(a.get().mode, "jwt"); assert.equal(a.get().needLogin, true);
  const b = createAuth({ base: "/api", fetch: (async () => { throw new TypeError("net"); }) as unknown as typeof fetch });
  assert.equal((await b.bootstrap()).mode, "dev");
});
