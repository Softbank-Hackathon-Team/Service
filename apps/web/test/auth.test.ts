import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError, createAuth, EARLY_REFRESH_SEC, githubErrorText, githubStartUrl, takeGithubError, USER_DISABLED_NOTICE } from "../src/lib/auth";
import { createClient, HttpError } from "../src/lib/http";

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

test("쿠키 없음 → 로그인 화면, 로그인 성공 → 토큰·사용자", async () => {
  const s = server({ "POST /api/auth/refresh": [{ status: 401 }], "POST /api/auth/login": [{ status: 200, body: tok(1) }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  const st = await a.bootstrap();
  assert.equal(st.ready, true); assert.equal(st.user, null); assert.equal(st.notice, null);
  await a.login("demo@dev-company.test", "pw");
  assert.equal(a.get().user?.tenantId, USER.tenantId);
  assert.equal(await a.accessToken(), "t1");
  const login = s.calls.find((c) => c.url === "/api/auth/login")!;
  assert.equal(login.init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(String(login.init.body)), { email: "demo@dev-company.test", password: "pw" });
});

test("쿠키 살아 있음 → 로그인 화면 없이 들어감. 새로 고침 = bootstrap 한 번만", async () => {
  const s = server({ "POST /api/auth/refresh": [{ status: 200, body: tok(1) }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await Promise.all([a.bootstrap(), a.bootstrap()]); // StrictMode 두 번
  assert.equal(s.n("POST /api/auth/refresh"), 1);
  assert.equal(a.get().user?.id, USER.id);
});

test("로그인 실패 401 → 한국어 문구, 429 → 기다리라는 문구", async () => {
  const s = server({ "POST /api/auth/refresh": [{ status: 401 }],
    "POST /api/auth/login": [{ status: 401, body: { code: "INVALID_CREDENTIALS" } }, { status: 429, body: { code: "TOO_MANY_ATTEMPTS" } }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.bootstrap();
  await assert.rejects(a.login("x@y.z", "no"), (e: unknown) => e instanceof AuthError && e.code === "INVALID_CREDENTIALS" && /맞지 않습니다/.test(e.message));
  await assert.rejects(a.login("x@y.z", "no"), (e: unknown) => e instanceof AuthError && e.status === 429 && /잠시 뒤/.test(e.message));
  assert.equal(a.get().user, null);
});

test("만료 30초 전이면 요청 전에 미리 refresh", async () => {
  let t = 0;
  const s = server({ "POST /api/auth/refresh": [{ status: 200, body: tok(1, 900) }, { status: 200, body: tok(2, 900) }] });
  const a = createAuth({ base: "/api", fetch: s.f, now: () => t });
  await a.bootstrap();
  assert.equal(await a.accessToken(), "t1");
  t = (900 - EARLY_REFRESH_SEC + 1) * 1000;
  assert.equal(await a.accessToken(), "t2");
  assert.equal(s.n("POST /api/auth/refresh"), 2);
});

test("http: 토큰이 있으면 Bearer 만, x-dev-tenant 안 보냄. 401 → refresh 한 번 → 같은 키로 다시", async () => {
  const s = server({ "POST /api/auth/refresh": [{ status: 200, body: tok(1) }, { status: 200, body: tok(2) }],
    "POST /api/migrations": [{ status: 401, body: { code: "UNAUTHENTICATED" } }, { status: 201, body: { id: "m1" } }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.bootstrap();
  const c = createClient({ base: "/api", fetch: s.f, token: () => a.accessToken(), onUnauthorized: () => a.onUnauthorized(), newKey: () => "k1" });
  assert.deepEqual(await c.post("/migrations", { a: 1 }), { id: "m1" });
  const sent = s.calls.filter((x) => x.url === "/api/migrations");
  assert.equal(sent.length, 2);
  const h0 = sent[0]!.init.headers as Record<string, string>, h1 = sent[1]!.init.headers as Record<string, string>;
  assert.equal(h0.authorization, "Bearer t1"); assert.equal(h1.authorization, "Bearer t2");
  assert.equal(h0["x-dev-tenant"], undefined);
  assert.equal(h0["idempotency-key"], "k1"); assert.equal(h1["idempotency-key"], "k1");
});

test("http: refresh 도 실패하면 401 을 던지고 로그인 화면(세션 끝 안내)", async () => {
  const s = server({ "POST /api/auth/refresh": [{ status: 200, body: tok(1) }, { status: 401, body: { code: "REFRESH_INVALID" } }],
    "GET /api/migrations": [{ status: 401 }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.bootstrap();
  const c = createClient({ base: "/api", fetch: s.f, token: () => a.accessToken(), onUnauthorized: () => a.onUnauthorized() });
  await assert.rejects(c.get("/migrations"), (e: unknown) => e instanceof HttpError && e.status === 401);
  assert.equal(a.get().user, null);
  assert.match(a.get().notice ?? "", /다시 로그인/);
  assert.equal(s.calls.filter((x) => x.url === "/api/migrations").length, 1);
});

test("http: 토큰이 없으면 회사 헤더 없이 보낸다", async () => {
  const s = server({ "POST /api/auth/refresh": [{ status: 401 }], "GET /api/healthz": [{ status: 200, body: { ok: true } }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.bootstrap();
  const c = createClient({ base: "/api", fetch: s.f, token: () => a.accessToken(), onUnauthorized: () => a.onUnauthorized() });
  await c.get("/healthz");
  const h = s.calls.at(-1)!.init.headers as Record<string, string>;
  assert.equal(h["x-dev-tenant"], undefined); assert.equal(h.authorization, undefined);
});

test("로그아웃 → 서버에 logout, 토큰 지움, 로그인 화면", async () => {
  const s = server({ "POST /api/auth/refresh": [{ status: 200, body: tok(1) }], "POST /api/auth/logout": [{ status: 204 }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.bootstrap();
  await a.logout();
  assert.equal(s.n("POST /api/auth/logout"), 1);
  assert.equal(a.get().user, null);
});

test("서버에 닿지 못해도 로그인 화면이 나온다. 쓰던 중이면 세션을 유지한다", async () => {
  const down = createAuth({ base: "/api", fetch: (async () => { throw new TypeError("net"); }) as unknown as typeof fetch });
  const st = await down.bootstrap();
  assert.equal(st.ready, true); assert.equal(st.user, null);

  let up = true;
  const a = createAuth({ base: "/api", fetch: (async () => {
    if (!up) throw new TypeError("net");
    return new Response(JSON.stringify(tok(1)), { status: 200 });
  }) as unknown as typeof fetch });
  await a.bootstrap();
  up = false;
  assert.equal(await a.onUnauthorized(), false);
  assert.equal(a.get().user?.id, USER.id);
});

test("GitHub 로그인: 서버 설정은 인증 없이 읽고, 못 읽으면 null (버튼 없음)", async () => {
  const on = server({ "GET /api/auth/config": [{ status: 200, body: { devAuth: false, loginRequired: true, github: { enabled: true } } }] });
  assert.equal((await createAuth({ base: "/api", fetch: on.f }).config())?.github?.enabled, true);
  const call = on.calls[0]!;
  assert.equal((call.init.headers as Record<string, string> | undefined)?.authorization, undefined);
  const down = server({ "GET /api/auth/config": [{ status: 500 }] });
  assert.equal(await createAuth({ base: "/api", fetch: down.f }).config(), null);
  const broken = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.equal(await createAuth({ base: "/api", fetch: broken }).config(), null);
  assert.equal(githubStartUrl("/api"), "/api/auth/github/start");
});

test("GitHub 로그인: 돌아온 ?github_error 는 사람 말로, 주소에서는 그 칸만 지운다 (해시·다른 칸은 그대로)", () => {
  assert.deepEqual(takeGithubError("http://h/?github_error=GITHUB_ACCESS_DENIED#/"), { code: "GITHUB_ACCESS_DENIED", clean: "/#/" });
  assert.deepEqual(takeGithubError("http://h/app?x=1&github_error=GITHUB_UNAVAILABLE"), { code: "GITHUB_UNAVAILABLE", clean: "/app?x=1" });
  assert.deepEqual(takeGithubError("http://h/#/migrations"), { code: null, clean: "/#/migrations" });
  assert.match(githubErrorText("GITHUB_EMAIL_UNVERIFIED"), /이메일/);
  assert.match(githubErrorText("GITHUB_ACCOUNT_NOT_ALLOWED"), /관리자/);
  assert.equal(githubErrorText("GITHUB_SOMETHING_NEW"), "GitHub 로그인에 실패했습니다.");
});

test("쓰던 중 계정이 꺼지면(401 USER_DISABLED) refresh 하지 않고 로그인 화면으로, 이유를 말한다", async () => {
  const s = server({
    "POST /api/auth/login": [{ status: 200, body: tok(1) }],
    "GET /api/migrations": [{ status: 401, body: { status: 401, code: "USER_DISABLED", message: "", requestId: "r" } }],
    "POST /api/auth/refresh": [{ status: 200, body: tok(2) }],
  });
  const a = createAuth({ base: "/api", fetch: s.f });
  await a.login("demo@dev-company.test", "pw");
  const c = createClient({ base: "/api", fetch: s.f, token: () => a.accessToken(), onUnauthorized: (code) => a.onUnauthorized(code) });
  await assert.rejects(c.get("/migrations"), HttpError);
  assert.equal(s.n("POST /api/auth/refresh"), 0);
  assert.equal(a.get().user, null);
  assert.equal(a.get().notice, USER_DISABLED_NOTICE);
});
