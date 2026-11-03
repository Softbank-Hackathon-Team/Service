import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GithubEmails, GithubUser, type GithubEmail } from "@svc/contracts";

// GHLOGIN: GitHub OAuth (Authorization Code + PKCE). 비밀(client secret·code·access token)은 환경 변수와 메모리에만 있고
//   로그·오류 메시지·응답 어디에도 넣지 않는다 (오류는 코드 이름만 남긴다).
// 출처: GitHub Docs "Authorizing OAuth apps" (authorize·access_token·state·PKCE code_challenge), RFC 7636, RFC 9700
// 환경 변수
//   GITHUB_CLIENT_ID · GITHUB_CLIENT_SECRET   둘 다 있어야 켜짐 (없으면 /auth/github/* 는 404, /auth/config github.enabled=false)
//   GITHUB_REDIRECT_URI                       GitHub 앱에 등록한 콜백 주소. 비우면 PUBLIC_API_URL(없으면 요청 주소) + /api/v1/auth/github/callback
//   GITHUB_POST_LOGIN_URL                     로그인 뒤 이동할 곳. 기본 "/" (같은 출처 경로만)
//   GITHUB_SIGNUP_TENANT_ID + GITHUB_SIGNUP_EMAIL_DOMAINS   둘 다 있어야 모르는 이메일을 그 회사의 새 사용자로 만든다 (없으면 가입 닫힘)
export interface GithubSettings {
  enabled: boolean; clientId: string; clientSecret: string; redirectUri: string | null; postLoginUrl: string;
  signupTenantId: string | null; signupDomains: string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function githubSettings(env: NodeJS.ProcessEnv = process.env): GithubSettings {
  const clientId = (env.GITHUB_CLIENT_ID ?? "").trim(), clientSecret = (env.GITHUB_CLIENT_SECRET ?? "").trim();
  const post = (env.GITHUB_POST_LOGIN_URL ?? "").trim();
  const tenant = (env.GITHUB_SIGNUP_TENANT_ID ?? "").trim();
  return {
    enabled: clientId !== "" && clientSecret !== "", clientId, clientSecret,
    redirectUri: (env.GITHUB_REDIRECT_URI ?? "").trim() || null,
    // 열린 리다이렉트 방지: "/" 로 시작하고 "//"·"/\" 가 아닌 같은 출처 경로만
    postLoginUrl: /^\/(?![/\\])/.test(post) ? post : "/",
    signupTenantId: UUID.test(tenant) ? tenant : null,
    signupDomains: (env.GITHUB_SIGNUP_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
  };
}
export const githubEnabled = (env: NodeJS.ProcessEnv = process.env) => githubSettings(env).enabled;

/** GitHub 쪽 실패. kind 만 안다 (본문·토큰은 담지 않음) */
export class GithubError extends Error {
  constructor(public kind: "code_invalid" | "unavailable") { super(kind); }
}

/** 주입 가능한 GitHub 클라이언트. 시험은 가짜를 넣는다 */
export interface GithubClient {
  /** code → access token. 실패는 GithubError */
  exchange(a: { code: string; verifier: string; redirectUri: string }): Promise<string>;
  user(token: string): Promise<GithubUser>;
  emails(token: string): Promise<GithubEmail[]>;
}

const TIMEOUT_MS = 8_000;
const UA = "kross-console-login";
export function realGithubClient(f: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): GithubClient {
  const s = githubSettings(env);
  async function call(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try { res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
    catch { throw new GithubError("unavailable"); }
    if (res.status === 401 || res.status === 403) throw new GithubError("code_invalid");
    if (!res.ok) throw new GithubError("unavailable");
    try { return await res.json(); } catch { throw new GithubError("unavailable"); }
  }
  const api = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": UA, "x-github-api-version": "2022-11-28" });
  return {
    async exchange({ code, verifier, redirectUri }) {
      const body = new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier });
      const j = await call("https://github.com/login/oauth/access_token", {
        method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": UA }, body });
      // GitHub 는 code 가 틀려도 200 + {error} 로 답한다
      const t = (j as { access_token?: unknown; error?: unknown } | null);
      if (t && typeof t.access_token === "string" && t.access_token) return t.access_token;
      throw new GithubError(t && typeof t.error === "string" ? "code_invalid" : "unavailable");
    },
    async user(token) {
      const r = GithubUser.safeParse(await call("https://api.github.com/user", { headers: api(token) }));
      if (!r.success) throw new GithubError("unavailable");
      return r.data;
    },
    async emails(token) {
      const r = GithubEmails.safeParse(await call("https://api.github.com/user/emails", { headers: api(token) }));
      if (!r.success) throw new GithubError("unavailable");
      return r.data;
    },
  };
}
let client: GithubClient | null = null;
export const getGithubClient = (): GithubClient => (client ??= realGithubClient());
/** 시험용: 가짜를 넣는다. null 이면 진짜로 되돌림 */
export const setGithubClient = (c: GithubClient | null) => { client = c; };

/** 검증된 기본 이메일 하나 (소문자). 없으면 null. 검증 안 된 주소·기본 아닌 주소는 로그인 근거로 쓰지 않는다 */
export function verifiedPrimaryEmail(list: GithubEmail[]): string | null {
  const e = list.find((x) => x.primary && x.verified)?.email.trim().toLowerCase();
  return e && e.length <= 254 && /^[^@\s]+@[^@\s]+$/.test(e) ? e : null;
}

// ---- state·PKCE 서명 쿠키. 서버에 저장하지 않는다 (API 서버가 여럿이어도 됨). HMAC 키 = JWT_SECRET
export const GH_COOKIE = "svc_gh_oauth";
export const GH_COOKIE_TTL_SEC = 600;
const b64u = (b: Buffer) => b.toString("base64url");
const sign = (secret: string | Buffer, payload: string) => b64u(createHmac("sha256", secret).update(`gh-oauth:${payload}`).digest());
export interface OauthStart { state: string; verifier: string; challenge: string; cookie: string }
export function newOauthStart(secret: string | Buffer, now = Date.now()): OauthStart {
  const state = b64u(randomBytes(32)), verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const payload = b64u(Buffer.from(JSON.stringify({ s: state, v: verifier, e: now + GH_COOKIE_TTL_SEC * 1000 })));
  return { state, verifier, challenge, cookie: `${payload}.${sign(secret, payload)}` };
}
/** 쿠키 검사 + 쿼리 state 와 같은지. 통과하면 verifier */
export function checkOauthCookie(secret: string | Buffer, cookie: string | undefined, queryState: string | undefined, now = Date.now()): string | null {
  if (!cookie || !queryState || cookie.length > 600) return null;
  const i = cookie.indexOf(".");
  if (i <= 0) return null;
  const payload = cookie.slice(0, i);
  const a = Buffer.from(cookie.slice(i + 1)), b = Buffer.from(sign(secret, payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let p: { s?: unknown; v?: unknown; e?: unknown };
  try { p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (typeof p.s !== "string" || typeof p.v !== "string" || typeof p.e !== "number" || p.e < now) return null;
  const x = Buffer.from(p.s), y = Buffer.from(queryState);
  return x.length === y.length && timingSafeEqual(x, y) ? p.v : null;
}
