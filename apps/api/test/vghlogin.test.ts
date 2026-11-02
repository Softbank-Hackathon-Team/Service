// VGHLOGIN 단위 시험(DB 없음): 진짜 GitHub 클라이언트를 가짜 fetch 로 — 이상한 응답·한도·비밀이 주소에 안 실림 / 쿠키·이메일·설정 경계값
import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubError, checkOauthCookie, githubSettings, newOauthStart, realGithubClient, verifiedPrimaryEmail } from "../src/auth/github.js";

const ENV = { GITHUB_CLIENT_ID: "cid-123", GITHUB_CLIENT_SECRET: "csecret-xyz" } as NodeJS.ProcessEnv;
type Call = { url: string; init: RequestInit };
const j = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
function client(res: Response | (() => Response) | Error) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); if (res instanceof Error) throw res; return typeof res === "function" ? res() : res.clone(); }) as unknown as typeof fetch;
  return { c: realGithubClient(f, ENV), calls };
}
const kind = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof GithubError ? e.kind : `other:${(e as Error).message}`; } };
const A = { code: "the-code", verifier: "the-verifier", redirectUri: "http://x/cb" };

test("교환: GitHub 이 200 + {error} · 200 + 빈 객체 · 깨진 JSON · 5xx · 네트워크 오류 · 한도 초과(403 remaining 0, 429)를 어떻게 답해도 GithubError 로만 닫힌다", async () => {
  assert.equal(await kind(client(j({ error: "bad_verification_code" })).c.exchange(A)), "code_invalid");
  assert.equal(await kind(client(j({})).c.exchange(A)), "unavailable");
  assert.equal(await kind(client(j({ access_token: "" })).c.exchange(A)), "unavailable");
  assert.equal(await kind(client(j({ access_token: 123 })).c.exchange(A)), "unavailable");
  assert.equal(await kind(client(j("not json {")).c.exchange(A)), "unavailable");
  assert.equal(await kind(client(j("null")).c.exchange(A)), "unavailable");
  assert.equal(await kind(client(j({}, 500)).c.exchange(A)), "unavailable");
  assert.equal(await kind(client(new Error("ECONNRESET")).c.exchange(A)), "unavailable");
  assert.equal(await kind(client(j({}, 401)).c.exchange(A)), "code_invalid");
  assert.equal(await kind(client(j({}, 403)).c.exchange(A)), "code_invalid");
  // 한도 초과는 code 가 틀린 게 아니다 (예전엔 403 이라 code_invalid 로 잘못 말했다)
  assert.equal(await kind(client(j({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" })).c.exchange(A)), "unavailable");
  assert.equal(await kind(client(j({}, 429)).c.exchange(A)), "unavailable");
  assert.equal(await kind(client(j({ access_token: "gho_ok" })).c.exchange(A)), "ok");
});

test("user·emails: 모양이 틀린 JSON(null·배열·문자열 id·0·음수·소수·빈 login·verified 없음)은 전부 unavailable", async () => {
  for (const bad of [null, [], "x", { id: "123", login: "a" }, { id: 0, login: "a" }, { id: -5, login: "a" }, { id: 1.5, login: "a" }, { id: 7, login: "" }, { login: "a" }, { id: 7, login: "a".repeat(101) }])
    assert.equal(await kind(client(j(bad)).c.user("t")), "unavailable", JSON.stringify(bad));
  assert.equal(await kind(client(j({ id: 7, login: "octo", name: null })).c.user("t")), "ok");
  for (const bad of [null, {}, "x", [{ email: "a@b.c", primary: true }], [{ email: "a@b.c", primary: "yes", verified: true }], [{ email: "a".repeat(300) + "@b.c", primary: true, verified: true }]])
    assert.equal(await kind(client(j(bad)).c.emails("t")), "unavailable", JSON.stringify(bad));
});

test("비밀은 주소·쿼리에 안 실린다: 교환은 POST 본문, 사용자·이메일은 Authorization 헤더. 모든 호출에 시간 제한 신호가 있다", async () => {
  const x = client(j({ access_token: "gho_tok" }));
  await x.c.exchange(A);
  const e = client(j({ id: 1, login: "o" })); await e.c.user("gho_tok");
  const m = client(j([])); await m.c.emails("gho_tok");
  for (const { url, init } of [...x.calls, ...e.calls, ...m.calls]) {
    assert.ok(url.startsWith("https://github.com/") || url.startsWith("https://api.github.com/"), url);
    for (const s of ["the-code", "csecret-xyz", "gho_tok", "the-verifier"]) assert.ok(!url.includes(s), `${s} 가 주소에 있다: ${url}`);
    assert.ok(init.signal instanceof AbortSignal, "시간 제한(AbortSignal) 없음");
  }
  const body = String(x.calls[0]!.init.body);
  assert.match(body, /client_secret=csecret-xyz/); assert.match(body, /code_verifier=the-verifier/); assert.equal(x.calls[0]!.init.method, "POST");
  assert.equal((e.calls[0]!.init.headers as Record<string, string>).authorization, "Bearer gho_tok");
});

test("이메일 고르기: 대소문자·공백 정리, 검증된 기본만, 기본이 둘이면 앞의 검증된 것, @ 둘·공백 든 주소는 거부", () => {
  const E = (email: string, primary = true, verified = true) => ({ email, primary, verified });
  assert.equal(verifiedPrimaryEmail([E("  Alice@Corp.COM ")]), "alice@corp.com");
  assert.equal(verifiedPrimaryEmail([E("a@b.c", true, false), E("d@e.f", false, true)]), null);
  assert.equal(verifiedPrimaryEmail([E("a@b.c", true, false), E("g@h.i", true, true)]), "g@h.i");
  assert.equal(verifiedPrimaryEmail([E("a@b@c.d")]), null);
  assert.equal(verifiedPrimaryEmail([E("a b@c.d")]), null);
  assert.equal(verifiedPrimaryEmail([E("@c.d")]), null);
  assert.equal(verifiedPrimaryEmail([E("a@")]), null);
  assert.equal(verifiedPrimaryEmail([]), null);
});

test("설정: 로그인 뒤 이동 주소는 같은 출처 경로만 (열린 리다이렉트 모양 전부 \"/\" 로)", () => {
  const post = (v: string | undefined) => githubSettings({ ...ENV, GITHUB_POST_LOGIN_URL: v }).postLoginUrl;
  for (const ok of ["/", "/app", "/app/home?tab=1", "/%2f/x", "/a/b#frag"]) assert.equal(post(ok), ok, ok);
  for (const bad of [undefined, "", "//evil.example", "/\\evil.example", "/\\\\evil", "https://evil.example", "http://evil", "evil.example", "javascript:alert(1)", "/\t/evil", "/\n/evil", "/\r/evil", "/ /evil", "/\u0000/evil", "/\u007f/evil", " //evil"])
    assert.equal(post(bad), "/", JSON.stringify(bad));
});

test("가입 도메인 설정: 대소문자·@ 접두·빈 항목 정리, 회사 번호는 UUID 모양만", () => {
  const s = githubSettings({ ...ENV, GITHUB_SIGNUP_EMAIL_DOMAINS: " @Corp.com, ,B.io ", GITHUB_SIGNUP_TENANT_ID: "not-a-uuid" });
  assert.deepEqual(s.signupDomains, ["corp.com", "b.io"]);
  assert.equal(s.signupTenantId, null);
  assert.equal(githubSettings({ ...ENV, GITHUB_SIGNUP_TENANT_ID: "11111111-1111-4111-8111-111111111111" }).signupTenantId, "11111111-1111-4111-8111-111111111111");
});

test("쿠키: payload 가 JSON 이 아니거나 칸 타입이 틀려도(서명은 맞게 만든 경우 포함) 통과하지 못한다 / 같은 쿠키는 만료 직전까지만", () => {
  const SECRET = "k".repeat(40);
  const o = newOauthStart(SECRET, 10_000);
  assert.equal(checkOauthCookie(SECRET, o.cookie, o.state, 10_000 + 599_000), o.verifier);
  assert.equal(checkOauthCookie(SECRET, o.cookie, o.state, 10_000 + 600_001), null);
  for (const bad of ["a.b.c", `${o.cookie}.extra`, o.cookie.toUpperCase(), ` ${o.cookie}`]) assert.equal(checkOauthCookie(SECRET, bad, o.state, 11_000), null, bad.slice(0, 20));
});
