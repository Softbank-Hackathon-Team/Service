// GHLOGIN 단위 시험(DB 없음): state·PKCE 쿠키, 설정, 이메일 고르기, 진짜 클라이언트(가짜 fetch)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  GithubError, checkOauthCookie, githubEnabled, githubSettings, newOauthStart, realGithubClient, verifiedPrimaryEmail,
} from "../src/auth/github.js";

const SECRET = "x".repeat(40);

test("state·PKCE: 시작 쿠키는 같은 state 로만 통과하고 verifier 를 돌려준다, challenge = S256(verifier)", () => {
  const o = newOauthStart(SECRET, 1_000);
  assert.equal(o.challenge, createHash("sha256").update(o.verifier).digest("base64url"));
  assert.equal(checkOauthCookie(SECRET, o.cookie, o.state, 2_000), o.verifier);
  assert.ok(o.state.length >= 43 && o.verifier.length >= 43);
});

test("거부: state 다름·쿠키 없음·서명 변조·다른 비밀키·만료·모양 깨짐", () => {
  const o = newOauthStart(SECRET, 1_000);
  assert.equal(checkOauthCookie(SECRET, o.cookie, "other", 2_000), null);
  assert.equal(checkOauthCookie(SECRET, undefined, o.state, 2_000), null);
  assert.equal(checkOauthCookie(SECRET, o.cookie, undefined, 2_000), null);
  const [p, sig] = o.cookie.split(".");
  assert.equal(checkOauthCookie(SECRET, `${p}.${sig!.slice(0, -2)}AA`, o.state, 2_000), null);
  // 본문을 바꾸면(공격자가 자기 state·verifier 로 갈아 끼움) 서명이 안 맞는다
  const forged = Buffer.from(JSON.stringify({ s: "evil", v: "v", e: 9e15 })).toString("base64url");
  assert.equal(checkOauthCookie(SECRET, `${forged}.${sig}`, "evil", 2_000), null);
  assert.equal(checkOauthCookie("y".repeat(40), o.cookie, o.state, 2_000), null);
  assert.equal(checkOauthCookie(SECRET, o.cookie, o.state, 1_000 + 601_000), null);   // 10분 뒤
  for (const bad of ["", "nodot", ".", "a.b", "x".repeat(700)]) assert.equal(checkOauthCookie(SECRET, bad, o.state, 2_000), null, bad);
});

test("설정: ID·비밀 둘 다 있어야 켜짐, 로그인 뒤 이동은 같은 출처 경로만, 가입 설정은 둘 다 있어야 의미", () => {
  assert.equal(githubEnabled({}), false);
  assert.equal(githubEnabled({ GITHUB_CLIENT_ID: "id" }), false);
  assert.equal(githubEnabled({ GITHUB_CLIENT_SECRET: "s" }), false);
  assert.equal(githubEnabled({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" }), true);
  for (const u of ["//evil.example", "https://evil.example", "/\\evil", "evil", ""]) assert.equal(githubSettings({ GITHUB_POST_LOGIN_URL: u }).postLoginUrl, "/", u);
  assert.equal(githubSettings({ GITHUB_POST_LOGIN_URL: "/console" }).postLoginUrl, "/console");
  const s = githubSettings({ GITHUB_SIGNUP_TENANT_ID: "not-a-uuid", GITHUB_SIGNUP_EMAIL_DOMAINS: " Acme.com, @corp.io ,," });
  assert.equal(s.signupTenantId, null);
  assert.deepEqual(s.signupDomains, ["acme.com", "corp.io"]);
});

test("이메일 고르기: 검증된 기본만 (검증 안 됨·기본 아님·모양 이상은 null), 소문자", () => {
  assert.equal(verifiedPrimaryEmail([{ email: "A@Test.Local", primary: true, verified: true }]), "a@test.local");
  assert.equal(verifiedPrimaryEmail([{ email: "a@test.local", primary: true, verified: false }]), null);
  assert.equal(verifiedPrimaryEmail([{ email: "a@test.local", primary: false, verified: true }]), null);
  assert.equal(verifiedPrimaryEmail([{ email: "no-at-sign", primary: true, verified: true }]), null);
  assert.equal(verifiedPrimaryEmail([]), null);
  assert.equal(verifiedPrimaryEmail([{ email: "x@y.z", primary: false, verified: true }, { email: "p@y.z", primary: true, verified: true }]), "p@y.z");
});

const ENV = { GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "super-secret-value" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("진짜 클라이언트: 교환은 폼 본문에 비밀·verifier·code, 성공하면 토큰, 비밀은 오류에 안 실림", async () => {
  let seen: { url: string; body: string } | null = null;
  const c = realGithubClient((async (url: string, init: RequestInit) => { seen = { url, body: String(init.body) }; return json({ access_token: "gho_tok" }); }) as unknown as typeof fetch, ENV);
  assert.equal(await c.exchange({ code: "CODE1", verifier: "VER1", redirectUri: "http://x/cb" }), "gho_tok");
  assert.equal(seen!.url, "https://github.com/login/oauth/access_token");
  const p = new URLSearchParams(seen!.body);
  assert.deepEqual([p.get("client_id"), p.get("client_secret"), p.get("code"), p.get("code_verifier"), p.get("redirect_uri")], ["cid", "super-secret-value", "CODE1", "VER1", "http://x/cb"]);
});

test("진짜 클라이언트 거부: 200+{error} = code_invalid, 5xx·네트워크·모양 이상 = unavailable", async () => {
  const run = async (f: unknown) => realGithubClient(f as typeof fetch, ENV).exchange({ code: "c", verifier: "v", redirectUri: "u" }).then(() => null, (e: unknown) => e);
  const e1 = await run(async () => json({ error: "bad_verification_code", error_description: "super-secret-value" }));
  assert.ok(e1 instanceof GithubError && e1.kind === "code_invalid");
  assert.ok(!String((e1 as Error).message).includes("super-secret-value"));
  const e2 = await run(async () => json({}, 503));
  assert.ok(e2 instanceof GithubError && e2.kind === "unavailable");
  const e3 = await run(async () => { throw new Error("connect ECONNREFUSED super-secret-value"); });
  assert.ok(e3 instanceof GithubError && e3.kind === "unavailable" && !String((e3 as Error).message).includes("super-secret-value"));
  const e4 = await run(async () => json({ nothing: 1 }));
  assert.ok(e4 instanceof GithubError && e4.kind === "unavailable");
});

test("진짜 클라이언트: /user·/user/emails 는 Bearer 로, 모양이 이상하면 unavailable", async () => {
  const calls: Array<[string, string]> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push([url, String((init.headers as Record<string, string>).authorization)]);
    return url.endsWith("/user") ? json({ id: 42, login: "octo", name: null, extra: "ignored" }) : json([{ email: "a@b.c", primary: true, verified: true }]);
  }) as unknown as typeof fetch;
  const c = realGithubClient(f, ENV);
  assert.deepEqual(await c.user("T"), { id: 42, login: "octo", name: null });
  assert.equal((await c.emails("T"))[0]!.email, "a@b.c");
  assert.deepEqual(calls.map((x) => x[1]), ["Bearer T", "Bearer T"]);
  const bad = realGithubClient((async () => json({ id: "not-a-number" })) as unknown as typeof fetch, ENV);
  await assert.rejects(bad.user("T"), (e: unknown) => e instanceof GithubError && e.kind === "unavailable");
});
