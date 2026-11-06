import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { ApiError, SignupBody, SignupConfig, type SignupError, type TeamRegistry } from "@svc/contracts";
import { withTenant, writeAudit } from "@svc/core";
import { sendError } from "../plugins/errors.js";
import { errors } from "./responses.js";
import { AuthTokenResponse, issue } from "./auth.js";
import { insertEnvironment, presetGcpProjects } from "./environments.js";
import { jwtSecret } from "../auth/jwt.js";
import { hashPassword } from "../auth/password.js";
import { LoginLimiter } from "../auth/limiter.js";
import { authSettings } from "../auth/settings.js";
import { clientIp } from "../auth/http.js";
import { findLoginUser, insertSession, userView } from "../auth/store.js";
import { loadTeamRegistry, matchSlot, signupOpen } from "../auth/team-registry.js";

// 팀 가입 (명부 = docs/team-env/registry.yaml, auth/team-registry.ts). 인증 불필요 (plugins/auth.ts isPublicAuthPath)
//   GET  /auth/signup/config  {enabled}  명부를 읽었고 열린 자리가 하나라도 있으면 true. 화면이 가입 칸을 띄울지 정한다
//   POST /auth/signup         {login, code, password} → 201 AuthTokenResponse + Set-Cookie svc_refresh (POST /auth/login 과 같은 모양)
//     자리 닫힘·모르는 로그인·코드 틀림 → 모두 같은 403 SIGNUP_NOT_ALLOWED (있는 로그인을 알려 주지 않기, OWASP Authentication Cheat Sheet)
//     코드가 맞고 그 로그인 사용자가 이미 있음 → 409 SIGNUP_EXISTS (코드를 아는 사람에게만 알려 줌)
//     성공 → 한 트랜잭션(명부의 회사, RLS): 사용자(진짜 비밀번호 해시) + 이름이 없는 환경만 만들기(draft) + 감사 + 로그인 세션
//            이미 있는 같은 이름 환경은 건드리지 않는다. 연결 상태는 draft 그대로 → 사용자가 연결 링크 → 확인을 직접 한다
// 시도 제한: 로그인과 같은 LoginLimiter (접속 IP + 로그인 15분 5번, IP 15분 50번 → 429 TOO_MANY_ATTEMPTS). 칸은 로그인과 따로 센다
// 사용자 만들기 권한: 앱 계정은 users 에 (id, tenant_id, email, display_name, github_id) 만 넣을 수 있고 password_hash 는 UPDATE 만 된다 (0019·0034)
//   → GitHub 가입과 같은 INSERT 다음 같은 트랜잭션에서 UPDATE password_hash. 새 마이그레이션 없음
// 로그·감사에는 비밀번호·초대 코드·해시를 남기지 않는다 (자리 번호와 환경 이름만)

const limiter = new LoginLimiter();

// 가입 실패 응답 (코드는 contracts SIGNUP_ERRORS 안에서만)
const deny = (req: FastifyRequest, reply: FastifyReply, status: number, code: SignupError, message: string) => sendError(req, reply, status, code, message);
const notAllowed = (req: FastifyRequest, reply: FastifyReply) => deny(req, reply, 403, "SIGNUP_NOT_ALLOWED", "login or invite code is not valid");
const exists = (req: FastifyRequest, reply: FastifyReply) => deny(req, reply, 409, "SIGNUP_EXISTS", "this login already has an account, sign in instead");

export async function signupRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // 뜰 때 한 번 읽고 들고 있는다. 없거나 틀리면 가입만 꺼진다 (경고 한 줄)
  const load = loadTeamRegistry();
  const registry: TeamRegistry | null = load.ok ? load.registry : null;
  if (!load.ok) app.log.warn({ signup: "registry_unavailable", path: load.path, reason: load.reason, issues: load.issues }, "team signup disabled: registry not loaded");

  r.get("/auth/signup/config", { schema: { response: { 200: SignupConfig, ...errors(500) } } }, async () => ({ enabled: signupOpen(registry) }));

  r.post("/auth/signup", { schema: { body: SignupBody,
    response: { 201: AuthTokenResponse, ...errors(400, 403, 404, 409, 500), 503: ApiError } } }, async (req, reply) => {
    if (!registry || !signupOpen(registry)) return deny(req, reply, 404, "SIGNUP_DISABLED", "team signup is not enabled");
    const { login, code, password } = req.body;
    const ip = clientIp(req);   // 프록시 뒤면 AUTH_CLIENT_IP_HEADER (auth/http.ts)
    const wait = limiter.blockedFor(ip, login);
    if (wait > 0) {
      reply.header("retry-after", String(wait));
      return sendError(req, reply, 429, "TOO_MANY_ATTEMPTS", "too many failed attempts, try again later");
    }
    const slot = matchSlot(registry, login, code);
    if (!slot) {
      limiter.fail(ip, login);
      req.log.info({ signup: "denied" }, "signup denied");
      return notAllowed(req, reply);
    }
    limiter.succeed(ip, login);
    // 세션을 못 주는 서버면 사용자를 만들기 전에 멈춘다 (만들고 503 이면 다시 가입할 수 없다)
    if (!jwtSecret()) return sendError(req, reply, 503, "AUTH_NOT_CONFIGURED", "JWT_SECRET is not set");
    if (await findLoginUser(slot.login)) return exists(req, reply);

    const tenant = registry.tenant;
    const userId = randomUUID(), actor = `user:${userId}`;
    const passwordHash = await hashPassword(password);
    const s = authSettings();
    let out;
    try {
      out = await withTenant(tenant, async (tx) => {
        // 같은 로그인 두 요청이 동시에 와도 하나만 (두 번째는 users_email_uq 에 걸려 409)
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('signup:' || $1))", [slot.login]);
        await tx.query(`INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)`,
          [userId, tenant, slot.login, slot.login.split("@")[0]!.slice(0, 200)]);
        await tx.query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [userId, passwordHash]);
        const created: string[] = [], kept: string[] = [];
        for (const e of slot.environments) {
          const view = await insertEnvironment(tx, tenant, actor,
            { provider: e.provider, name: e.name, region: e.region, clusterName: e.cluster },
            { ifExists: "skip", auditDetail: { via: "signup", slot: slot.id } });
          if (!view) { kept.push(e.name); continue; }
          if (e.gcp) await presetGcpProjects(tx, view.id, e.gcp.original_project, e.gcp.dedicated_project);
          created.push(e.name);
        }
        await writeAudit(tx, tenant, { actor, action: "auth.signup", target: actor, result: "ok",
          detail: { slot: slot.id, environmentsCreated: created, environmentsKept: kept } });
        const user = await userView(tx, userId);
        const familyId = randomUUID();
        const sess = await insertSession(tx, { tenantId: tenant, userId, familyId, familyStartedAt: null,
          ttlSec: s.refreshTtlSec, maxSec: s.sessionMaxSec, userAgent: req.headers["user-agent"] });
        return { user: user!, sess, familyId, created: created.length };
      });
    } catch (e) {
      const pe = e as { code?: string; constraint?: string; table?: string };
      if (pe.code === "23505" && pe.constraint === "users_email_uq") return exists(req, reply);
      if (pe.code === "23503" && pe.table === "users") {
        req.log.warn({ signup: "tenant_missing" }, "team signup: registry tenant does not exist");
        return deny(req, reply, 503, "SIGNUP_NOT_CONFIGURED", "team signup is not configured on this server");
      }
      throw e;
    }
    req.log.info({ signup: "ok", slot: slot.id, environmentsCreated: out.created }, "team signup");
    const { disabled: _d, ...user } = out.user;
    reply.code(201);
    return issue(req, reply, user, out.sess.sid, out.familyId, out.sess.refresh, out.sess.expiresAt);
  });
}
