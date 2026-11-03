// VGHLOGIN DB 시험: GitHub 로그인 보안 점검 (state·PKCE 쿠키, 열린 리다이렉트, 이메일 연결, 꺼진 사용자, 반쪽 깃발, 로그 유출, 한도). 진짜 GitHub 호출 없음
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { setGithubClient, GithubError, newOauthStart, type GithubClient } from "../src/auth/github.js";
import { jwtSecret } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const TA = "11111111-1111-4111-8111-111111111111";
const TB = "99999999-9999-4999-8999-0000000000c5";
const run = randomUUID().slice(0, 8);
const mail = (n: string) => `vgh-${n}-${run}@test.local`;
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'vgh-other') ON CONFLICT (id) DO NOTHING", [TB]);
  setEnv({ GITHUB_CLIENT_ID: "test-client-id", GITHUB_CLIENT_SECRET: "test-client-secret-xyz", GITHUB_REDIRECT_URI: undefined, PUBLIC_API_URL: "http://localhost:3000",
    GITHUB_SIGNUP_TENANT_ID: undefined, GITHUB_SIGNUP_EMAIL_DOMAINS: undefined, GITHUB_POST_LOGIN_URL: undefined, AUTH_ROTATE_GRACE_MS: "0", RATE_LIMIT: "0" });
  ({ app } = await buildApp({ logStream: { write: (l) => { lines.push(l); } } }));
});
after(async () => {
  if (skip) return;
  setGithubClient(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await app.close(); await owner.end();
});


const okClient = (id: number, emails: Fake["emails"]) => fake({ id, emails });

test("다른 브라우저·없는·만료·다른 비밀로 서명한·잘린 쿠키 → 400 GITHUB_STATE_INVALID (GitHub 클라이언트는 부르지 않는다)", { skip }, async () => {
  let called = 0;
  const spy: GithubClient = { async exchange() { called++; return FAKE_TOKEN; }, async user() { called++; return { id: 1, login: "x", name: null }; }, async emails() { called++; return []; } };
  const secret = jwtSecret()!;
  const other = newOauthStart(secret);                       // 다른 브라우저가 시작한 흐름
  const expired = newOauthStart(secret, Date.now() - 11 * 60_000);
  const foreign = newOauthStart("another-secret-another-secret-0123456789");
  const cases: Array<[string, Parameters<typeof login>[1]]> = [
    ["쿠키 없음", { cookie: () => undefined }],
    ["다른 브라우저 쿠키(state 다름)", { cookie: () => other.cookie }],
    ["만료 쿠키(자기 state)", { cookie: () => expired.cookie, state: () => expired.state }],
    ["다른 비밀로 서명", { cookie: () => foreign.cookie, state: () => foreign.state }],
    ["쿠키 잘림", { cookie: (c) => c.slice(0, c.length - 4) }],
    ["서명 칸 비움", { cookie: (c) => c.split(".")[0] + "." }],
    ["점 없음", { cookie: (c) => c.replace(".", "") }],
    ["state 빈 값", { state: () => "" }],
    ["state 대소문자 바꿈", { state: (s) => s.toUpperCase() === s ? s.toLowerCase() : s.toUpperCase() }],
    ["state 한 글자 덧붙임", { state: (s) => s + "a" }],
    ["쿠키 600자 초과", { cookie: (c) => c + "x".repeat(600) }],
  ];
  for (const [name, o] of cases) {
    const { cb } = await login(spy, o);
    assert.equal(cb.statusCode, 400, `${name}: ${cb.body}`);
    assert.equal(cb.json().code, "GITHUB_STATE_INVALID", name);
  }
  assert.equal(called, 0, "state 검사를 통과 못 하면 GitHub 를 부르지 않는다");
});

test("쿠키는 한 번 쓰면 지워지라고 응답한다(Max-Age=0), 실패 응답에도 같다 / start 쿠키 속성 · 두 번 시작하면 state·verifier 가 다르다", { skip }, async () => {
  const a = (await app.inject({ url: `${P}/github/start` })) as unknown as Res, b = (await app.inject({ url: `${P}/github/start` })) as unknown as Res;
  const sa = new URL(String(a.headers.location)).searchParams, sb = new URL(String(b.headers.location)).searchParams;
  assert.notEqual(sa.get("state"), sb.get("state"));
  assert.notEqual(sa.get("code_challenge"), sb.get("code_challenge"));
  assert.equal(sa.get("code_challenge_method"), "S256");
  assert.equal(sa.get("allow_signup"), "false");
  const raw = ([] as string[]).concat(a.headers["set-cookie"] as string | string[])[0]!;
  for (const attr of ["HttpOnly", "SameSite=Lax", "Path=/api", "Max-Age=600"]) assert.ok(raw.includes(attr), `${attr} : ${raw}`);
  assert.ok(!raw.includes("Secure"), "http 에선 Secure 안 붙음");
  const https = (await app.inject({ url: `${P}/github/start`, headers: { "x-forwarded-proto": "https" } })) as unknown as Res;
  assert.ok(([] as string[]).concat(https.headers["set-cookie"] as string | string[])[0]!.includes("Secure"));
  // verifier 는 주소·응답 본문에 없다 (쿠키 안에만)
  const ck = cookieOf(a, "svc_gh_oauth")!;
  const verifier = JSON.parse(Buffer.from(ck.split(".")[0]!, "base64url").toString()).v as string;
  assert.ok(!String(a.headers.location).includes(verifier) && !a.body.includes(verifier));
  // 실패 callback 도 쿠키를 지우라고 한다
  const { cb } = await login(okClient(5, []), { state: () => "wrong" });
  assert.equal(cb.statusCode, 400);
  assert.match(([] as string[]).concat(cb.headers["set-cookie"] as string | string[]).join("|"), /svc_gh_oauth=;[^|]*Max-Age=0/);
});

test("열린 리다이렉트: GITHUB_POST_LOGIN_URL 이 //evil · /\\evil · https://evil · 제어문자 포함이면 \"/\" 로 간다 / 오류 이동은 코드만 싣고 공격자 쿼리를 되돌려 주지 않는다", { skip }, async () => {
  const bad = ["//evil.example", "/\\evil.example", "https://evil.example", "evil.example", "/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\u0000/evil.example"];
  for (const u of bad) {
    setEnv({ GITHUB_POST_LOGIN_URL: u });
    try {
      const { cb } = await login(okClient(7001, []), { accept: "text/html" });   // 이메일 없음 → 403 → html 이동
      const loc = String(cb.headers.location);
      assert.equal(cb.statusCode, 302, u);
      assert.ok(loc.startsWith("/?github_error="), `${JSON.stringify(u)} → ${loc}`);
    } finally { setEnv({ GITHUB_POST_LOGIN_URL: undefined }); }
  }
  setEnv({ GITHUB_POST_LOGIN_URL: "/console/home" });
  try {
    const { cb } = await login(okClient(7002, []), { accept: "text/html" });
    assert.equal(cb.headers.location, "/console/home?github_error=GITHUB_EMAIL_UNVERIFIED");
  } finally { setEnv({ GITHUB_POST_LOGIN_URL: undefined }); }
  // 공격자가 callback 쿼리에 심은 값(error·redirect·next)은 이동 주소에 안 들어간다
  const { cb } = await login(okClient(1, []), { accept: "text/html", query: "error=%2F%2Fevil.example&redirect=https://evil.example&next=//evil.example&state=zzz" });
  assert.equal(cb.statusCode, 302);
  assert.ok(!String(cb.headers.location).includes("evil"), String(cb.headers.location));
});

test("이메일: GitHub 이 대문자 섞어 줘도 기존 사용자에 연결(대소문자 무시) / 검증 안 됨·기본 아님은 연결 안 함(탈취 방지) / 꺼진 사용자는 연결도 안 되고 github_id 도 안 붙는다", { skip }, async () => {
  const em = mail("case");
  const uid = await seedUser(TA, em);
  const up = em.replace("vgh-", "VGH-").toUpperCase();
  const ok = await login(okClient(81001, [{ email: up, primary: true, verified: true }]));
  assert.equal(ok.cb.statusCode, 302, ok.cb.body);
  assert.equal((await userRow(TA, em)).github_id, "81001");
  assert.equal(await sessions(TA, uid), 1);
  // 검증 안 된 기본 + 검증된 비기본(내 주소) → 거부, 연결 안 됨
  const em2 = mail("unv"); await seedUser(TA, em2);
  const r1 = await login(okClient(81002, [{ email: em2, primary: true, verified: false }, { email: em2, primary: false, verified: true }]));
  assert.equal(r1.cb.statusCode, 403); assert.equal(r1.cb.json().code, "GITHUB_EMAIL_UNVERIFIED");
  assert.equal((await userRow(TA, em2)).github_id, null);
  // 꺼진 사용자
  const em3 = mail("off"); await seedUser(TA, em3, { disabled: true });
  const r2 = await login(okClient(81003, [{ email: em3, primary: true, verified: true }]));
  assert.equal(r2.cb.statusCode, 403); assert.equal(r2.cb.json().code, "GITHUB_ACCOUNT_NOT_ALLOWED");
  assert.equal((await userRow(TA, em3)).github_id, null, "꺼진 사용자에게 GitHub 계정이 붙으면 안 된다");
  // 이미 연결돼 있다가 꺼진 사용자 → 계정 번호로 찾아도 거부, 세션 0
  const em4 = mail("off2"); const u4 = await seedUser(TA, em4, { disabled: true, github: "81004" });
  const r3 = await login(okClient(81004, []));
  assert.equal(r3.cb.statusCode, 403);
  assert.equal(await sessions(TA, u4), 0);
});

test("다른 회사 사용자: 이메일이 TB 사용자와 같으면 TB 세션이 만들어지고 TA 에는 아무것도 안 생긴다 / 가입 설정은 허용 도메인 정확히 일치만(서브도메인·접미사 속임수 거부)", { skip }, async () => {
  const em = mail("tb"); const u = await seedUser(TB, em);
  const r = await login(okClient(82001, [{ email: em, primary: true, verified: true }]));
  assert.equal(r.cb.statusCode, 302, r.cb.body);
  assert.equal((await userRow(TB, em)).github_id, "82001");
  assert.equal(await sessions(TB, u), 1);
  assert.equal((await owner.query("SELECT 1 FROM users WHERE email=$1 AND tenant_id=$2", [em, TA])).rowCount, 0, "TA 에는 아무것도 안 생긴다");
  setEnv({ GITHUB_SIGNUP_TENANT_ID: TA, GITHUB_SIGNUP_EMAIL_DOMAINS: "corp-vgh.example" });
  try {
    for (const bad of [`x-${run}@corp-vgh.example.evil.io`, `x-${run}@evil.corp-vgh.example`, `x-${run}@xcorp-vgh.example`]) {
      const x = await login(okClient(82002, [{ email: bad, primary: true, verified: true }]));
      assert.equal(x.cb.statusCode, 403, bad); assert.equal(x.cb.json().code, "GITHUB_ACCOUNT_NOT_ALLOWED");
      assert.equal((await owner.query("SELECT 1 FROM users WHERE email=$1", [bad])).rowCount, 0);
    }
    const good = `New-${run}@Corp-VGH.example`;
    const g = await login(okClient(82003, [{ email: good, primary: true, verified: true }]));
    assert.equal(g.cb.statusCode, 302, g.cb.body);
    const made = await userRow(TA, good.toLowerCase());
    assert.equal(made.github_id, "82003");
    assert.equal(made.password_hash, null, "가입한 사용자는 비밀번호가 없다");
  } finally { setEnv({ GITHUB_SIGNUP_TENANT_ID: undefined, GITHUB_SIGNUP_EMAIL_DOMAINS: undefined }); }
});

test("GitHub 이 이상하게 답할 때: 예상 못 한 오류·응답은 502 로 닫고 세션을 안 만든다 (오류 문구에 토큰·code 없음)", { skip }, async () => {
  const boom: GithubClient = { async exchange() { return FAKE_TOKEN; }, async user() { throw new Error(`weird ${FAKE_TOKEN} ${FAKE_CODE}`); }, async emails() { return []; } };
  const r = await login(boom);
  assert.equal(r.cb.statusCode >= 500 || r.cb.statusCode === 502, true, String(r.cb.statusCode));
  assert.ok(!r.cb.body.includes(FAKE_TOKEN) && !r.cb.body.includes(FAKE_CODE));
  const slowEmails: GithubClient = { async exchange() { return FAKE_TOKEN; }, async user() { return { id: 83001, login: "o", name: null }; }, async emails() { throw new GithubError("unavailable"); } };
  const s = await login(slowEmails);
  assert.equal(s.cb.statusCode, 502); assert.equal(s.cb.json().code, "GITHUB_UNAVAILABLE");
});

test("반쪽 깃발: ID 만 · SECRET 만 · 공백뿐이면 start·callback 404, config enabled=false", { skip }, async () => {
  for (const env of [{ GITHUB_CLIENT_SECRET: undefined }, { GITHUB_CLIENT_ID: undefined }, { GITHUB_CLIENT_ID: "   " }, { GITHUB_CLIENT_SECRET: "\t" }]) {
    setEnv(env);
    try {
      assert.deepEqual((await app.inject({ url: `${P}/config` })).json().github, { enabled: false }, JSON.stringify(env));
      assert.equal((await app.inject({ url: `${P}/github/start` })).statusCode, 404);
      assert.equal((await app.inject({ url: `${P}/github/callback?code=a&state=b` })).statusCode, 404);
    } finally { setEnv({ GITHUB_CLIENT_ID: "test-client-id", GITHUB_CLIENT_SECRET: "test-client-secret-xyz" }); }
  }
});

test("입력 이상: 긴 code·state·중복 쿼리·POST 는 거부되고 값을 응답에 되돌려 주지 않는다", { skip }, async () => {
  const long = "A".repeat(700);
  const r1 = await app.inject({ url: `${P}/github/callback?code=${long}&state=x` });
  assert.equal(r1.statusCode, 400); assert.ok(!r1.body.includes(long));
  const r2 = await app.inject({ url: `${P}/github/callback?code=a&code=b&state=x` });
  assert.ok(r2.statusCode >= 400 && r2.statusCode < 500, String(r2.statusCode));
  const r3 = await app.inject({ method: "POST", url: `${P}/github/callback?code=a&state=x` });
  assert.ok(r3.statusCode === 404 || r3.statusCode === 405, String(r3.statusCode));
  const r4 = await app.inject({ url: `${P}/github/callback` });
  assert.equal(r4.statusCode, 400);
});

test("로그: 실패 경로(상태 불일치·교환 실패·GitHub 불통·취소)에서도 code·state·토큰·client secret 이 로그에 없다 (인코딩된 모양 포함)", { skip }, async () => {
  lines.length = 0;
  const SECRET_CODE = "CODE-LEAK-CHECK-71af", SECRET_STATE = "STATE-LEAK-CHECK-92be";
  const client = (f: Fake) => fake(f);
  await app.inject({ url: `${P}/github/callback?code=${SECRET_CODE}&state=${SECRET_STATE}` });               // 쿠키 없음
  await app.inject({ url: `${P}/github/callback?code=${encodeURIComponent(SECRET_CODE + "+/=")}&state=${encodeURIComponent(SECRET_STATE)}&error=access_denied` });
  await login(client({ id: 1, exchange: "code_invalid" }));
  await login(client({ id: 1, exchange: "unavailable" }));
  await login(client({ id: 1, emailsFail: true }));
  const text = lines.join("\n");
  for (const needle of [SECRET_CODE, SECRET_STATE, FAKE_CODE, FAKE_TOKEN, "test-client-secret-xyz", encodeURIComponent(SECRET_CODE + "+/=")])
    assert.ok(!text.includes(needle), `로그에 ${needle.slice(0, 12)}… 가 있다`);
  assert.ok(text.length > 0, "로그가 비어 있으면 시험이 아무것도 못 본 것");
});

test("한도: 기본 전역 한도(IP 기준)가 /auth/github/* 에도 걸린다 — 낮춘 한도에서 callback 반복은 429", { skip }, async () => {
  setEnv({ RATE_LIMIT: undefined, RATE_LIMIT_READ_PER_MIN: "5" });
  const { app: limited } = await buildApp({ logStream: { write: () => {} } });
  try {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await limited.inject({ url: `${P}/github/callback?code=a&state=b`, remoteAddress: "203.0.113.9" })).statusCode;
    assert.equal(last, 429);
    // 다른 IP 는 영향 없음
    assert.equal((await limited.inject({ url: `${P}/github/callback?code=a&state=b`, remoteAddress: "203.0.113.10" })).statusCode, 400);
  } finally { await limited.close(); setEnv({ RATE_LIMIT: "0", RATE_LIMIT_READ_PER_MIN: undefined }); }
});

test("한도: callback 은 전역 한도(3000)보다 조여서 IP 당 분당 30번 — 31번째는 429, 다른 IP·start 는 영향 없음", { skip }, async () => {
  setEnv({ RATE_LIMIT: undefined, RATE_LIMIT_READ_PER_MIN: undefined });
  const { app: limited } = await buildApp({ logStream: { write: () => {} } });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await limited.inject({ url: `${P}/github/callback?code=a&state=b`, remoteAddress: "203.0.113.20" })).statusCode);
    assert.ok(codes.slice(0, 30).every((c) => c === 400), codes.join(","));
    assert.equal(codes[30], 429);
    assert.equal((await limited.inject({ url: `${P}/github/callback?code=a&state=b`, remoteAddress: "203.0.113.21" })).statusCode, 400);
    assert.equal((await limited.inject({ url: `${P}/github/start`, remoteAddress: "203.0.113.20" })).statusCode, 302);
    // 다른 읽기 경로를 많이 불러도 callback 칸을 먹지 않는다(전역 한도는 따로 3000)
    const other = await limited.inject({ url: `${P}/config`, remoteAddress: "203.0.113.22" });
    assert.equal(other.statusCode, 200);
  } finally { await limited.close(); setEnv({ RATE_LIMIT: "0" }); }
});
