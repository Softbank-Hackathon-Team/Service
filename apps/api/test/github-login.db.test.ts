// GHLOGIN DB 시험: buildApp + 가짜 GitHub 클라이언트. 정상(기존 이메일 연결·다시 로그인·가입 설정 시 새 사용자) + 거부 + 로그에 code·토큰 없음
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { setGithubClient, GithubError, type GithubClient } from "../src/auth/github.js";
import { hashPassword } from "../src/auth/password.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const TA = "11111111-1111-4111-8111-111111111111";   // 0002 개발 회사
const TB = "99999999-9999-4999-8999-0000000000c4";   // 이 시험 전용 두 번째 회사
const run = randomUUID().slice(0, 8);
const mail = (n: string) => `gh-${n}-${run}@test.local`;
const P = "/api/v1/auth";
const FAKE_CODE = "FAKE-CODE-9f8e7d", FAKE_TOKEN = "gho_FAKE_TOKEN_1a2b3c";

const saved: Record<string, string | undefined> = {};
const setEnv = (e: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(e)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

interface Fake { id: number; login?: string; name?: string | null; emails?: Array<{ email: string; primary: boolean; verified: boolean }>; exchange?: "ok" | "code_invalid" | "unavailable"; emailsFail?: boolean }
function fake(f: Fake): GithubClient {
  return {
    async exchange({ code }) {
      assert.equal(code, FAKE_CODE);
      if (f.exchange === "code_invalid") throw new GithubError("code_invalid");
      if (f.exchange === "unavailable") throw new GithubError("unavailable");
      return FAKE_TOKEN;
    },
    async user(t) { assert.equal(t, FAKE_TOKEN); return { id: f.id, login: f.login ?? "octo", name: f.name ?? null }; },
    async emails() { if (f.emailsFail) throw new GithubError("unavailable"); return f.emails ?? []; },
  };
}

let owner: pg.Client;
const lines: string[] = [];
let app: Awaited<ReturnType<typeof buildApp>>["app"];

async function seedUser(tenant: string, email: string, opts: { disabled?: boolean; github?: string } = {}) {
  await owner.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
  const id = randomUUID();
  await owner.query(`INSERT INTO users (id, tenant_id, email, password_hash, disabled_at, github_id) VALUES ($1,$2,$3,$4,${opts.disabled ? "now()" : "NULL"},$5)`,
    [id, tenant, email, await hashPassword("pw-" + run + "-xx", { N: 2 ** 14, r: 8, p: 1, keylen: 64 }), opts.github ?? null]);
  return id;
}
async function userRow(tenant: string, email: string) {
  await owner.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
  return (await owner.query("SELECT id, tenant_id, github_id, password_hash FROM users WHERE email = $1", [email])).rows[0];
}
async function sessions(tenant: string, userId: string) {
  await owner.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
  return (await owner.query("SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1", [userId])).rows[0].n as number;
}

type Res = { statusCode: number; headers: Record<string, unknown>; json: () => any; body: string };
const cookieOf = (r: Res, name: string) => {
  const sc = ([] as string[]).concat(r.headers["set-cookie"] as string | string[] ?? []);
  const m = sc.map((c) => new RegExp(`^${name}=([^;]*)`).exec(c)).find(Boolean);
  return m ? decodeURIComponent(m[1]!) : undefined;
};
/** start → state·쿠키. 그다음 callback(code, 옵션) */
async function login(client: GithubClient, o: { state?: (s: string) => string; cookie?: (c: string) => string | undefined; code?: string; accept?: string; query?: string } = {}) {
  setGithubClient(client);
  const st = (await app.inject({ url: `${P}/github/start` })) as unknown as Res;
  assert.equal(st.statusCode, 302, st.body);
  const loc = new URL(String(st.headers.location));
  const state = loc.searchParams.get("state")!;
  const cookie = cookieOf(st, "svc_gh_oauth")!;
  const ck = o.cookie ? o.cookie(cookie) : cookie;
  const q = o.query ?? `code=${o.code ?? FAKE_CODE}&state=${encodeURIComponent(o.state ? o.state(state) : state)}`;
  const cb = (await app.inject({ url: `${P}/github/callback?${q}`,
    headers: { ...(ck ? { cookie: `svc_gh_oauth=${encodeURIComponent(ck)}` } : {}), ...(o.accept ? { accept: o.accept } : {}) } })) as unknown as Res;
  return { st, cb, loc };
}

before(async () => {
  if (skip) return;
  process.env.LOG_LEVEL = "debug";
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'gh-other') ON CONFLICT (id) DO NOTHING", [TB]);
  setEnv({ GITHUB_CLIENT_ID: "test-client-id", GITHUB_CLIENT_SECRET: "test-client-secret-xyz", GITHUB_REDIRECT_URI: undefined, PUBLIC_API_URL: "http://localhost:3000",
    GITHUB_SIGNUP_TENANT_ID: undefined, GITHUB_SIGNUP_EMAIL_DOMAINS: undefined, GITHUB_POST_LOGIN_URL: undefined, AUTH_ROTATE_GRACE_MS: "0" });
  ({ app } = await buildApp({ logStream: { write: (l) => { lines.push(l); } } }));
});
after(async () => {
  if (skip) return;
  setGithubClient(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await app.close(); await owner.end();
});

test("깃발 없음: config github.enabled=false, start·callback 은 404 GITHUB_LOGIN_DISABLED", { skip }, async () => {
  setEnv({ GITHUB_CLIENT_ID: undefined });
  try {
    const cfg = (await app.inject({ url: `${P}/config` })).json();
    assert.deepEqual(cfg.github, { enabled: false });
    for (const u of ["start", "callback?code=x&state=y"]) {
      const r = await app.inject({ url: `${P}/github/${u}` });
      assert.equal(r.statusCode, 404, u);
      assert.equal(r.json().code, "GITHUB_LOGIN_DISABLED");
    }
  } finally { setEnv({ GITHUB_CLIENT_ID: "test-client-id" }); }
});

test("start: GitHub 로 302 (client_id·redirect_uri·state·S256 challenge·scope), 서명 쿠키 HttpOnly·Lax, client secret 은 주소에 없음", { skip }, async () => {
  assert.deepEqual((await app.inject({ url: `${P}/config` })).json().github, { enabled: true });
  const st = (await app.inject({ url: `${P}/github/start` })) as unknown as Res;
  assert.equal(st.statusCode, 302);
  const u = new URL(String(st.headers.location));
  assert.equal(u.origin + u.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(u.searchParams.get("client_id"), "test-client-id");
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:3000/api/v1/auth/github/callback");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(u.searchParams.get("state")!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(u.searchParams.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!String(st.headers.location).includes("test-client-secret-xyz"));
  const raw = ([] as string[]).concat(st.headers["set-cookie"] as string | string[]).find((c) => c.startsWith("svc_gh_oauth="))!;
  assert.match(raw, /HttpOnly/); assert.match(raw, /SameSite=Lax/); assert.match(raw, /Path=\/api/);
});

test("정상 1: 기존 이메일 사용자에 GitHub 연결 → 같은 세션(svc_refresh) → /auth/refresh 로 로그인, 다음엔 계정 번호로", { skip }, async () => {
  const email = mail("link"), uid = await seedUser(TA, email);
  const { cb } = await login(fake({ id: 1001, emails: [{ email: email.toUpperCase(), primary: true, verified: true }] }));
  assert.equal(cb.statusCode, 302, cb.body);
  assert.equal(cb.headers.location, "/");
  const refresh = cookieOf(cb, "svc_refresh");
  assert.ok(refresh && refresh.length > 40, "리프레시 쿠키");
  assert.equal(cookieOf(cb, "svc_gh_oauth"), "");   // 한 번 쓴 state 쿠키는 지움
  assert.equal((await userRow(TA, email)).github_id, "1001");
  assert.equal(await sessions(TA, uid), 1);
  // 화면이 하는 것: 쿠키로 refresh
  const rf = await app.inject({ method: "POST", url: `${P}/refresh`, headers: { cookie: `svc_refresh=${encodeURIComponent(refresh)}` } });
  assert.equal(rf.statusCode, 200, rf.body);
  assert.equal(rf.json().user.email, email); assert.equal(rf.json().user.tenantId, TA);
  const me = await app.inject({ url: `${P}/me`, headers: { authorization: `Bearer ${rf.json().accessToken}` } });
  assert.equal(me.statusCode, 200);
  // 두 번째: 이메일을 못 줘도(emails 가 비어도) 계정 번호로 찾는다
  const again = await login(fake({ id: 1001, emails: [] }));
  assert.equal(again.cb.statusCode, 302);
  assert.ok(cookieOf(again.cb, "svc_refresh"));
  assert.equal(await sessions(TA, uid), 3);   // 로그인 1 + refresh 회전 1 + 두 번째 로그인 1
});

test("정상 2: 가입 설정(회사+도메인)이 있으면 모르는 이메일은 그 회사의 새 사용자, 비밀번호 없음, 그 회사만 보임", { skip }, async () => {
  setEnv({ GITHUB_SIGNUP_TENANT_ID: TB, GITHUB_SIGNUP_EMAIL_DOMAINS: "test.local" });
  try {
    const email = mail("new");
    const { cb } = await login(fake({ id: 2002, login: "newbie", name: "새 사람", emails: [{ email, primary: true, verified: true }] }));
    assert.equal(cb.statusCode, 302, cb.body);
    const u = await userRow(TB, email);
    assert.equal(u.tenant_id, TB); assert.equal(u.github_id, "2002"); assert.equal(u.password_hash, null);
    const rf = await app.inject({ method: "POST", url: `${P}/refresh`, headers: { cookie: `svc_refresh=${encodeURIComponent(cookieOf(cb, "svc_refresh")!)}` } });
    assert.equal(rf.json().user.tenantId, TB); assert.equal(rf.json().user.displayName, "새 사람");
    // 이메일+비밀번호 로그인은 안 된다 (비밀번호가 없음)
    const pw = await app.inject({ method: "POST", url: `${P}/login`, payload: { email, password: "anything-long-enough" } });
    assert.equal(pw.statusCode, 401);
  } finally { setEnv({ GITHUB_SIGNUP_TENANT_ID: undefined, GITHUB_SIGNUP_EMAIL_DOMAINS: undefined }); }
});

test("거부: 가입 설정 없음·도메인 밖 → 403 GITHUB_ACCOUNT_NOT_ALLOWED, 사용자 안 만듦", { skip }, async () => {
  const e1 = mail("closed");
  const r1 = (await login(fake({ id: 3001, emails: [{ email: e1, primary: true, verified: true }] }))).cb;
  assert.equal(r1.statusCode, 403); assert.equal(r1.json().code, "GITHUB_ACCOUNT_NOT_ALLOWED");
  assert.equal(await userRow(TA, e1), undefined);
  setEnv({ GITHUB_SIGNUP_TENANT_ID: TB, GITHUB_SIGNUP_EMAIL_DOMAINS: "corp.example" });
  try {
    const e2 = mail("domain");
    const r2 = (await login(fake({ id: 3002, emails: [{ email: e2, primary: true, verified: true }] }))).cb;
    assert.equal(r2.statusCode, 403);
    assert.equal(await userRow(TB, e2), undefined);
  } finally { setEnv({ GITHUB_SIGNUP_TENANT_ID: undefined, GITHUB_SIGNUP_EMAIL_DOMAINS: undefined }); }
});

test("거부: 이메일 검증 안 됨·기본 아님·이메일 없음 → 403 GITHUB_EMAIL_UNVERIFIED, 기존 사용자에 연결도 안 됨(탈취 방지)", { skip }, async () => {
  const email = mail("victim"), uid = await seedUser(TA, email);
  for (const emails of [[{ email, primary: true, verified: false }], [{ email, primary: false, verified: true }], []]) {
    const r = (await login(fake({ id: 4001, emails }))).cb;
    assert.equal(r.statusCode, 403); assert.equal(r.json().code, "GITHUB_EMAIL_UNVERIFIED");
  }
  assert.equal((await userRow(TA, email)).github_id, null);
  assert.equal(await sessions(TA, uid), 0);
});

test("거부: state 다름·쿠키 없음·쿠키 변조·code 없음 → 400 GITHUB_STATE_INVALID (GitHub 호출 전)", { skip }, async () => {
  let called = 0;
  const spy: GithubClient = { async exchange() { called++; return FAKE_TOKEN; }, async user() { called++; return { id: 1, login: "x" }; }, async emails() { called++; return []; } };
  for (const o of [{ state: () => "wrong-state" }, { cookie: () => undefined }, { cookie: (c: string) => c.slice(0, -3) + "AAA" }, { query: "state=whatever" }]) {
    const r = (await login(spy, o)).cb;
    assert.equal(r.statusCode, 400, JSON.stringify(Object.keys(o))); assert.equal(r.json().code, "GITHUB_STATE_INVALID");
  }
  assert.equal(called, 0);
});

test("거부: code 교환 실패 401 · GitHub 불통 502 · 사용자가 취소 401 · 교환 후 이메일 조회 불통 502, 세션 0", { skip }, async () => {
  const email = mail("fails"), uid = await seedUser(TA, email);
  const ok = [{ email, primary: true, verified: true }];
  const a = (await login(fake({ id: 5001, emails: ok, exchange: "code_invalid" }))).cb;
  assert.equal(a.statusCode, 401); assert.equal(a.json().code, "GITHUB_CODE_INVALID");
  const b = (await login(fake({ id: 5001, emails: ok, exchange: "unavailable" }))).cb;
  assert.equal(b.statusCode, 502); assert.equal(b.json().code, "GITHUB_UNAVAILABLE");
  const c = (await login(fake({ id: 5001, emails: ok }), { query: "error=access_denied&state=x" })).cb;   // state 도 틀리니 state 검사가 먼저
  assert.equal(c.statusCode, 400);
  const d = (await login(fake({ id: 5001, emails: ok, emailsFail: true }))).cb;
  assert.equal(d.statusCode, 502);
  assert.equal(await sessions(TA, uid), 0);
  assert.equal((await userRow(TA, email)).github_id, null);
});

test("거부: 사용자 취소(error=access_denied + 맞는 state) → 401 GITHUB_ACCESS_DENIED", { skip }, async () => {
  setGithubClient(fake({ id: 1 }));
  const st = (await app.inject({ url: `${P}/github/start` })) as unknown as Res;
  const state = new URL(String(st.headers.location)).searchParams.get("state")!;
  const r = await app.inject({ url: `${P}/github/callback?error=access_denied&state=${state}`, headers: { cookie: `svc_gh_oauth=${encodeURIComponent(cookieOf(st, "svc_gh_oauth")!)}` } });
  assert.equal(r.statusCode, 401); assert.equal(r.json().code, "GITHUB_ACCESS_DENIED");
});

test("거부: 이미 다른 GitHub 계정에 연결된 사용자 → 409, 꺼진 사용자 → 403 (계정 번호로도 이메일로도)", { skip }, async () => {
  const e1 = mail("taken"); await seedUser(TA, e1, { github: "6001" });
  const r1 = (await login(fake({ id: 6002, emails: [{ email: e1, primary: true, verified: true }] }))).cb;
  assert.equal(r1.statusCode, 409); assert.equal(r1.json().code, "GITHUB_ALREADY_LINKED");
  assert.equal((await userRow(TA, e1)).github_id, "6001");
  const e2 = mail("off"), uid2 = await seedUser(TA, e2, { disabled: true });
  const r2 = (await login(fake({ id: 6003, emails: [{ email: e2, primary: true, verified: true }] }))).cb;
  assert.equal(r2.statusCode, 403); assert.equal(r2.json().code, "GITHUB_ACCOUNT_NOT_ALLOWED");
  const e3 = mail("off2"); const uid3 = await seedUser(TA, e3, { disabled: true, github: "6004" });
  const r3 = (await login(fake({ id: 6004, emails: [] }))).cb;
  assert.equal(r3.statusCode, 403);
  assert.equal(await sessions(TA, uid2), 0); assert.equal(await sessions(TA, uid3), 0);
});

test("같은 GitHub 계정은 사용자 한 명에만: 다른 사용자의 이메일로 로그인하려 해도 계정 번호가 먼저라 그 한 명으로만 들어간다", { skip }, async () => {
  const a = mail("one"), b = mail("two");
  await seedUser(TA, a); await seedUser(TA, b);
  await login(fake({ id: 7001, emails: [{ email: a, primary: true, verified: true }] }));
  const r = (await login(fake({ id: 7001, emails: [{ email: b, primary: true, verified: true }] }))).cb;   // 이메일이 바뀌어도
  assert.equal(r.statusCode, 302);
  const rf = await app.inject({ method: "POST", url: `${P}/refresh`, headers: { cookie: `svc_refresh=${encodeURIComponent(cookieOf(r, "svc_refresh")!)}` } });
  assert.equal(rf.json().user.email, a);
  assert.equal((await userRow(TA, b)).github_id, null);
});

test("브라우저 이동(Accept: text/html)이면 오류를 화면으로 302 + ?github_error=코드, 열린 리다이렉트 아님", { skip }, async () => {
  const r = (await login(fake({ id: 8001, emails: [] }), { accept: "text/html", state: () => "bad" })).cb;
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, "/?github_error=GITHUB_STATE_INVALID");
  setEnv({ GITHUB_POST_LOGIN_URL: "//evil.example" });
  try {
    const r2 = (await login(fake({ id: 8001, emails: [] }), { accept: "text/html", state: () => "bad" })).cb;
    assert.equal(r2.headers.location, "/?github_error=GITHUB_STATE_INVALID");
  } finally { setEnv({ GITHUB_POST_LOGIN_URL: undefined }); }
});

test("감사 기록: 성공·거부가 auth.github_login 으로 남는다", { skip }, async () => {
  const email = mail("audit"), uid = await seedUser(TA, email);
  await login(fake({ id: 9001, emails: [{ email, primary: true, verified: true }] }));
  await owner.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
  const q = await owner.query("SELECT result FROM audit_events WHERE action = 'auth.github_login' AND target = $1", [`user:${uid}`]);
  assert.ok(q.rows.some((x) => x.result === "ok"));
});

test("로그에 code·state·토큰·client secret 이 없다 (debug 로그 전체)", { skip }, async () => {
  const all = lines.join("\n");
  assert.ok(lines.length > 20);
  for (const s of [FAKE_CODE, FAKE_TOKEN, "test-client-secret-xyz"]) assert.ok(!all.includes(s), `로그에 ${s.slice(0, 8)}…`);
  assert.ok(/github\/callback\?code=\[redacted\]/.test(all), "요청 주소의 code 가 가려져 찍힘");
});
