import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { withTenant } from "@svc/core";
import { NotifySession, SESSION_EVENTS_CHANNEL } from "@svc/contracts";
import { sendError } from "../plugins/errors.js";
import { errors } from "./responses.js";
import { signAccess, jwtSecret } from "../auth/jwt.js";
import { revokeFamily } from "../auth/revoked.js";
import { verifyPassword, PASSWORD_MAX } from "../auth/password.js";
import { LoginLimiter } from "../auth/limiter.js";
import { authSettings, devHeaderAuthEnabled, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from "../auth/settings.js";
import {
  findLoginUser, findSession, parseRefresh, refreshMatches, insertSession, userView, audit, type AuthUser as AuthUserRow,
} from "../auth/store.js";

// 진짜 로그인 경로 (Z93). 화면 계약은 Z96 과 맞춤:
//   GET  /auth/config   {devAuth, loginRequired}            인증 불필요. 화면이 로그인 화면을 띄울지 정한다
//   POST /auth/login    {email,password} → AuthTokenResponse  + Set-Cookie svc_refresh (HttpOnly, SameSite=Strict, Path=/api)
//   POST /auth/refresh  쿠키 → AuthTokenResponse (리프레시 토큰 회전: 쓴 토큰은 바로 무효)
//   POST /auth/logout   쿠키 → 204, 세션 끊고 쿠키 지움
//   GET  /auth/me       Bearer → AuthUser
// 접근 토큰은 본문으로만 준다 (화면 메모리에 보관, localStorage 안 씀). 리프레시 토큰은 HttpOnly 쿠키로만 (스크립트가 못 읽음)
// 출처: OWASP Session Management Cheat Sheet(쿠키 속성·회전·만료), OWASP Authentication Cheat Sheet(같은 오류 문구·시도 제한),
//       RFC 9700(OAuth 2.0 Security BCP 4.14: 리프레시 토큰 회전과 재사용 감지)
// CSRF: refresh·logout 은 쿠키만으로 인증되므로 SameSite=Strict 로 다른 사이트에서 온 요청에 쿠키가 안 실리게 한다.
//   login 은 본문 비밀번호가 필요해 CSRF 대상 아님. 다른 업무 경로는 Authorization 헤더라 CSRF 대상 아님

export const LoginBody = z.object({
  email: z.string().trim().toLowerCase().max(254).regex(/^[^@\s]+@[^@\s]+$/),
  password: z.string().min(1).max(PASSWORD_MAX),
}).strict();
export const AuthUser = z.object({
  id: z.uuid(), email: z.string(), displayName: z.string().nullable(), tenantId: z.uuid(), tenantName: z.string(),
}).strict();
export const AuthTokenResponse = z.object({
  accessToken: z.string(), tokenType: z.literal("Bearer"), expiresIn: z.number().int(), user: AuthUser,
}).strict();
export const AuthConfig = z.object({ devAuth: z.boolean(), loginRequired: z.boolean() }).strict();

const limiter = new LoginLimiter();

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}
function isHttps(req: FastifyRequest) {
  return authSettings().cookieSecure || req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
}
function setRefreshCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAgeSec: number) {
  const attrs = [`${REFRESH_COOKIE}=${encodeURIComponent(value)}`, `Path=${REFRESH_COOKIE_PATH}`, "HttpOnly", "SameSite=Strict", `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`];
  // DRAFT(ai) Z93: 데모는 http(localhost·터널 뒤)라 Secure 를 늘 켜면 쿠키가 안 저장된다 → https 로 들어왔을 때만
  if (isHttps(req)) attrs.push("Secure");
  reply.header("set-cookie", attrs.join("; "));
}
const clearRefreshCookie = (req: FastifyRequest, reply: FastifyReply) => setRefreshCookie(req, reply, "", 0);

async function issue(req: FastifyRequest, reply: FastifyReply, user: AuthUserRow, sid: string, fam: string, refresh: string, expiresAt: Date) {
  const secret = jwtSecret();
  if (!secret) return sendError(req, reply, 503, "AUTH_NOT_CONFIGURED", "JWT_SECRET is not set");
  const s = authSettings();
  const accessToken = signAccess({ sub: user.id, tid: user.tenantId, sid, fam, email: user.email }, secret, s.accessTtlSec);
  setRefreshCookie(req, reply, refresh, (expiresAt.getTime() - Date.now()) / 1000);
  reply.header("cache-control", "no-store");
  return { accessToken, tokenType: "Bearer" as const, expiresIn: s.accessTtlSec, user };
}

export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/auth/config", { schema: { response: { 200: AuthConfig, ...errors(500) } } }, async () => {
    const dev = devHeaderAuthEnabled();
    return { devAuth: dev, loginRequired: !dev };
  });

  r.post("/auth/login", { schema: { body: LoginBody,
    response: { 200: AuthTokenResponse, ...errors(400, 401, 500) } } }, async (req, reply) => {
    const { email, password } = req.body;
    const wait = limiter.blockedFor(req.ip, email);
    if (wait > 0) {
      reply.header("retry-after", String(wait));
      return sendError(req, reply, 429, "TOO_MANY_ATTEMPTS", "too many failed logins, try again later");
    }
    const row = await findLoginUser(email);
    // 사용자가 없어도 같은 시간 계산(verifyPassword 가 가짜 해시로 돈다) + 같은 문구 (계정 있는지 알려 주지 않기)
    const ok = await verifyPassword(password, row?.password_hash);
    if (!row || !ok || row.disabled) {
      limiter.fail(req.ip, email);
      if (row) await audit(row.tenant_id, row.user_id, "auth.login", "denied", { reason: row.disabled ? "disabled" : "bad_password" });
      req.log.info({ auth: "login_failed" }, "login failed");
      return sendError(req, reply, 401, "INVALID_CREDENTIALS", "email or password is incorrect");
    }
    limiter.succeed(req.ip, email);
    const s = authSettings();
    const out = await withTenant(row.tenant_id, async (tx) => {
      const user = await userView(tx, row.user_id);
      const familyId = randomUUID();
      const sess = await insertSession(tx, { tenantId: row.tenant_id, userId: row.user_id, familyId, familyStartedAt: null,
        ttlSec: s.refreshTtlSec, maxSec: s.sessionMaxSec, userAgent: req.headers["user-agent"] });
      return { user: user!, sess, familyId };
    });
    await audit(row.tenant_id, row.user_id, "auth.login", "ok", { sid: out.sess.sid });
    const { disabled: _d, ...user } = out.user;
    return issue(req, reply, user, out.sess.sid, out.familyId, out.sess.refresh, out.sess.expiresAt);
  });

  r.post("/auth/refresh", { schema: { response: { 200: AuthTokenResponse, ...errors(401, 500) } } }, async (req, reply) => {
    const deny = () => { clearRefreshCookie(req, reply); return sendError(req, reply, 401, "REFRESH_INVALID", "login again"); };
    const tok = parseRefresh(readCookie(req, REFRESH_COOKIE));
    if (!tok) return deny();
    const row = await findSession(tok.sid);
    if (!row || !refreshMatches(tok.secret, row.refresh_hash)) return deny();
    if (row.revoked_at) {
      // 이미 바꾼 토큰이 다시 왔다 = 토큰이 새어 나갔을 수 있다 → 그 로그인 묶음 전체를 끊는다 (RFC 9700 4.14.2)
      if (row.revoked_reason === "rotated" && Date.now() - new Date(row.revoked_at).getTime() >= authSettings().rotateGraceMs) {
        await withTenant(row.tenant_id, (tx) => tx.query(
          `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'reuse' WHERE family_id = $1 AND revoked_at IS NULL`, [row.family_id]));
        revokeFamily(row.family_id, authSettings().accessTtlSec);   // 이 묶음의 접근 토큰도 즉시 무효 (z75-69)
        await audit(row.tenant_id, row.user_id, "auth.refresh_reuse", "denied", { family: row.family_id });
      }
      return deny();
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) return deny();
    const s = authSettings();
    const out = await withTenant(row.tenant_id, async (tx) => {
      // 동시에 두 번 오면 한 쪽만 이긴다 (revoked_at IS NULL 조건)
      const u = await tx.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1 AND revoked_at IS NULL`, [tok.sid]);
      if (u.rowCount !== 1) return null;
      const user = await userView(tx, row.user_id);
      if (!user || user.disabled) return null;
      const sess = await insertSession(tx, { tenantId: row.tenant_id, userId: row.user_id, familyId: row.family_id,
        familyStartedAt: new Date(row.family_started_at), ttlSec: s.refreshTtlSec, maxSec: s.sessionMaxSec, userAgent: req.headers["user-agent"] });
      return { user, sess };
    });
    if (!out) return deny();
    const { disabled: _d, ...user } = out.user;
    return issue(req, reply, user, out.sess.sid, row.family_id, out.sess.refresh, out.sess.expiresAt);
  });

  r.post("/auth/logout", { schema: { response: { 204: z.null(), ...errors(500) } } }, async (req, reply) => {
    const tok = parseRefresh(readCookie(req, REFRESH_COOKIE));
    if (tok) {
      const row = await findSession(tok.sid);
      if (row && !row.revoked_at && refreshMatches(tok.secret, row.refresh_hash)) {
        await withTenant(row.tenant_id, async (tx) => {
          await tx.query(
            `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`, [tok.sid]);
          // L8: 같은 트랜잭션에서 알림 → 커밋돼야 나간다. 모든 API 서버 허브가 이 사용자 연결을 닫는다
          // TODO: #62 머지 뒤 SSE 허브가 session_events 를 LISTEN 해서 연결 닫기 (허브 쪽은 이 묶음에서 안 함)
          const note = NotifySession.parse({ t: row.tenant_id, u: row.user_id, r: "logout" });
          await tx.query(`SELECT pg_notify($1, $2)`, [SESSION_EVENTS_CHANNEL, JSON.stringify(note)]);
        });
        revokeFamily(row.family_id, authSettings().accessTtlSec);   // 로그아웃 전에 받은 접근 토큰(앞 회전 것 포함)도 즉시 무효 (z75-69)
        await audit(row.tenant_id, row.user_id, "auth.logout", "ok", { sid: tok.sid });
      }
    }
    clearRefreshCookie(req, reply);
    return reply.code(204).send(null);
  });

  r.get("/auth/me", { schema: { response: { 200: AuthUser, ...errors(401, 500) } } }, async (req, reply) => {
    if (!req.auth) return sendError(req, reply, 401, "UNAUTHENTICATED", "no login session (dev header auth has no user)");
    const u = await withTenant(req.tenantId, (tx) => userView(tx, req.auth!.sub));
    if (!u || u.disabled) return sendError(req, reply, 401, "UNAUTHENTICATED", "user not found or disabled");
    const { disabled: _d, ...user } = u;
    return user;
  });
}
