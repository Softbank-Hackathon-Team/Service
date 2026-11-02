import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { withTenant, DomainError } from "@svc/core";
import { ApiError, type GithubLoginError } from "@svc/contracts";
import { errors } from "./responses.js";
import { jwtSecret } from "../auth/jwt.js";
import { authSettings } from "../auth/settings.js";
import { isHttps, readCookie, setRefreshCookie } from "../auth/http.js";
import { findLoginUser, findGithubUser, insertSession, audit } from "../auth/store.js";
import {
  GH_COOKIE, GH_COOKIE_TTL_SEC, GithubError, checkOauthCookie, getGithubClient, githubSettings, newOauthStart, verifiedPrimaryEmail,
} from "../auth/github.js";

// GHLOGIN (Jeong 11/2 H-L1: 이메일 방식은 그대로 + GitHub 추가). 흐름
//   GET /auth/github/start     state·PKCE verifier 를 만들어 서명 쿠키(svc_gh_oauth, 10분)에 넣고 GitHub 로 302
//   GET /auth/github/callback  쿠키·state 검사 → code 교환 → GitHub /user → (계정 번호로 못 찾으면) /user/emails 의 검증된 기본 이메일
//                              → 사용자 찾기/연결/만들기 → 이메일 로그인과 같은 세션(auth_sessions, svc_refresh 쿠키) → 화면으로 302
//   화면은 열릴 때 /auth/refresh 를 한 번 부르므로(lib/auth.ts bootstrap) 쿠키만으로 로그인된다. 접근 토큰은 URL 에 안 싣는다
// 회사 연결 규칙(이메일 로그인과 같게): 사용자 ↔ 회사는 users 줄이 정한다. GitHub 은 "이 이메일 주인이다" 를 증명할 뿐
//   - 이미 연결된 GitHub 계정 번호 → 그 사용자
//   - 아니면 검증된 기본 이메일이 있는 사용자 → 그 사용자에 계정 번호를 처음 연결 (이미 다른 GitHub 계정이 붙어 있으면 409)
//   - 그런 사용자가 없으면: GITHUB_SIGNUP_TENANT_ID + GITHUB_SIGNUP_EMAIL_DOMAINS 가 있고 이메일 도메인이 목록에 있을 때만 그 회사의 새 사용자.
//     아니면 403 (초대받은 사용자만). DRAFT(ai): 열린 가입은 누구나 그 회사 데이터를 보게 되므로 기본 닫힘
// 실패: 브라우저 이동(Accept: text/html)이면 화면으로 302 + ?github_error=<코드>, 아니면 ApiError JSON
// TODO(human): 한 사람이 여러 회사에 속하는 경우(memberships)는 0019 결정대로 결선 뒤. 지금은 이메일 하나 = 회사 하나

const Q = z.object({ code: z.string().max(512).optional(), state: z.string().max(200).optional(),
  error: z.string().max(100).optional() });

function fail(status: number, code: GithubLoginError, message: string): never { throw new DomainError(status, code, message); }

function redirectUri(req: FastifyRequest): string {
  const s = githubSettings();
  if (s.redirectUri) return s.redirectUri;
  const base = process.env.PUBLIC_API_URL?.trim().replace(/\/+$/, "") || `${req.protocol}://${req.host}`;
  return `${base}/api/v1/auth/github/callback`;
}
function ghCookie(req: FastifyRequest, value: string, maxAgeSec: number): string {
  // SameSite=Lax: GitHub 에서 돌아오는 건 다른 사이트에서 온 최상위 GET 이동이라 Strict 면 쿠키가 안 실린다
  return [`${GH_COOKIE}=${encodeURIComponent(value)}`, "Path=/api", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`, ...(isHttps(req) ? ["Secure"] : [])].join("; ");
}
const wantsHtml = (req: FastifyRequest) => String(req.headers.accept ?? "").includes("text/html");
const withQuery = (url: string, k: string, v: string) => `${url}${url.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}`;

export async function registerGithub(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const E = { ...errors(400, 401, 403, 404, 409, 500), 502: ApiError, 503: ApiError, 302: z.null() };

  r.get("/auth/github/start", { schema: { response: E } }, async (req, reply) => {
    const s = githubSettings();
    if (!s.enabled) fail(404, "GITHUB_LOGIN_DISABLED", "GitHub login is not enabled");
    const secret = jwtSecret();
    if (!secret) throw new DomainError(503, "AUTH_NOT_CONFIGURED", "JWT_SECRET is not set");
    const o = newOauthStart(secret);
    const u = new URL("https://github.com/login/oauth/authorize");
    u.search = new URLSearchParams({ client_id: s.clientId, redirect_uri: redirectUri(req), scope: "read:user user:email",
      state: o.state, code_challenge: o.challenge, code_challenge_method: "S256", allow_signup: "false" }).toString();
    reply.header("set-cookie", ghCookie(req, o.cookie, GH_COOKIE_TTL_SEC));
    reply.header("cache-control", "no-store");
    return reply.code(302).header("location", u.toString()).send(null);
  });

  r.get("/auth/github/callback", { schema: { querystring: Q, response: E } }, async (req, reply) => {
    const s = githubSettings();
    if (!s.enabled) fail(404, "GITHUB_LOGIN_DISABLED", "GitHub login is not enabled");
    const secret = jwtSecret();
    if (!secret) throw new DomainError(503, "AUTH_NOT_CONFIGURED", "JWT_SECRET is not set");
    // 성공이든 실패든 이 쿠키는 한 번만 쓴다
    reply.header("set-cookie", ghCookie(req, "", 0));
    reply.header("cache-control", "no-store");
    try {
      const verifier = checkOauthCookie(secret, readCookie(req, GH_COOKIE), req.query.state);
      if (!verifier) fail(400, "GITHUB_STATE_INVALID", "login session expired or state mismatch, start again");
      if (req.query.error) fail(401, "GITHUB_ACCESS_DENIED", "GitHub login was cancelled");
      if (!req.query.code) fail(400, "GITHUB_STATE_INVALID", "code is missing");
      const gh = getGithubClient();
      let token: string, ghUser: Awaited<ReturnType<typeof gh.user>>;
      try {
        token = await gh.exchange({ code: req.query.code, verifier, redirectUri: redirectUri(req) });
        ghUser = await gh.user(token);
      } catch (e) {
        if (e instanceof GithubError && e.kind === "code_invalid") fail(401, "GITHUB_CODE_INVALID", "GitHub rejected the login code");
        req.log.warn({ auth: "github_unavailable" }, "github call failed");   // 본문·토큰은 남기지 않는다
        fail(502, "GITHUB_UNAVAILABLE", "could not reach GitHub, try again");
      }
      const ghId = String(ghUser.id);
      let who = await findGithubUser(ghId);
      let created = false;
      if (!who) {
        let email: string | null;
        try { email = verifiedPrimaryEmail(await gh.emails(token)); }
        catch { req.log.warn({ auth: "github_unavailable" }, "github call failed"); return fail(502, "GITHUB_UNAVAILABLE", "could not reach GitHub, try again"); }
        if (!email) fail(403, "GITHUB_EMAIL_UNVERIFIED", "GitHub account has no verified primary email");
        const row = await findLoginUser(email);
        if (row) {
          if (row.disabled) { await audit(row.tenant_id, row.user_id, "auth.github_login", "denied", { reason: "disabled" }); fail(403, "GITHUB_ACCOUNT_NOT_ALLOWED", "this account cannot sign in"); }
          // 처음 연결: 이미 다른 GitHub 계정이 붙어 있으면 줄이 안 바뀐다(0 줄) → 거부. 같은 GitHub 계정이 동시에 다른 사용자에 붙으면 유일 인덱스(23505)가 막는다
          const linked = await withTenant(row.tenant_id, async (tx) => {
            try { return (await tx.query(`UPDATE users SET github_id = $1 WHERE id = $2 AND github_id IS NULL`, [ghId, row.user_id])).rowCount === 1; }
            catch (e) { if ((e as { code?: string }).code === "23505") return false; throw e; }
          });
          if (!linked) { await audit(row.tenant_id, row.user_id, "auth.github_login", "denied", { reason: "already_linked" }); fail(409, "GITHUB_ALREADY_LINKED", "this user is already linked to another GitHub account"); }
          who = { user_id: row.user_id, tenant_id: row.tenant_id, email: row.email, display_name: row.display_name, disabled: false };
        } else {
          const domain = email.split("@")[1]!;
          if (!s.signupTenantId || !s.signupDomains.includes(domain)) fail(403, "GITHUB_ACCOUNT_NOT_ALLOWED", "no account for this email (ask an admin to add you)");
          const id = randomUUID();
          try {
            await withTenant(s.signupTenantId, (tx) => tx.query(
              `INSERT INTO users (id, tenant_id, email, display_name, github_id) VALUES ($1, $2, $3, $4, $5)`,
              [id, s.signupTenantId, email, (ghUser.name || ghUser.login).slice(0, 200), ghId]));
          } catch (e) {
            const c = (e as { code?: string }).code;
            if (c === "23503") { req.log.warn({ auth: "github_signup_tenant_missing" }, "signup tenant does not exist"); fail(403, "GITHUB_ACCOUNT_NOT_ALLOWED", "no account for this email"); }
            if (c === "23505") fail(409, "GITHUB_ALREADY_LINKED", "this email or GitHub account is already in use, try again");
            throw e;
          }
          who = { user_id: id, tenant_id: s.signupTenantId, email, display_name: ghUser.name || ghUser.login, disabled: false };
          created = true;
        }
      }
      if (who.disabled) { await audit(who.tenant_id, who.user_id, "auth.github_login", "denied", { reason: "disabled" }); fail(403, "GITHUB_ACCOUNT_NOT_ALLOWED", "this account cannot sign in"); }
      // 이메일 로그인과 같은 세션: 새 묶음(family) 하나, 리프레시 토큰 하나
      const st = authSettings();
      const sess = await withTenant(who.tenant_id, (tx) => insertSession(tx, { tenantId: who!.tenant_id, userId: who!.user_id, familyId: randomUUID(),
        familyStartedAt: null, ttlSec: st.refreshTtlSec, maxSec: st.sessionMaxSec, userAgent: req.headers["user-agent"] }));
      await audit(who.tenant_id, who.user_id, "auth.github_login", "ok", { sid: sess.sid, created });
      setRefreshCookie(req, reply, sess.refresh, (sess.expiresAt.getTime() - Date.now()) / 1000);
      return reply.code(302).header("location", s.postLoginUrl).send(null);
    } catch (e) {
      // 브라우저 이동이면 JSON 대신 화면으로 보낸다 (코드만 실음). 그 밖은 errors 플러그인이 ApiError 로 낸다
      if (e instanceof DomainError && wantsHtml(req)) return sendBack(reply, githubSettings().postLoginUrl, e.code);
      throw e;
    }
  });
}

function sendBack(reply: FastifyReply, url: string, code: string) {
  return reply.code(302).header("location", withQuery(url, "github_error", code)).send(null);
}
