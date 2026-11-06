import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sendError } from "./errors.js";
import { verifyAccess, jwtSecret, type AccessClaims } from "../auth/jwt.js";
import { devHeaderAuthEnabled } from "../auth/settings.js";
import { isFamilyRevoked } from "../auth/revoked.js";
import { withTenant } from "@svc/core";
import { PAT_PREFIX } from "@svc/contracts";
import { hashPat, isPatShape, type PatLookup } from "../auth/pat.js";

declare module "fastify" {
  // auth = 진짜 로그인(Bearer JWT)일 때만 채워진다. 개발용 헤더 인증이면 null (Z93)
  interface FastifyRequest { tenantId: string; actor: string; auth: AccessClaims | null }
  // L10: Agent 경로가 "서명 검증을 붙였다"고 스스로 밝히는 표시. 아래 onRoute 검사가 본다
  interface FastifyContextConfig { agentSignature?: true }
}

// 사람 세션 인증을 건너뛰는 경로 (Agent 키 서명으로 인증)
export const isAgentPath = (url: string) => url.startsWith("/agent/") || url.startsWith("/api/v1/agent/");

// 인증 (Z93): 순서대로
//   1) Authorization: Bearer <JWT> → 서명·만료 확인 → 토큰의 회사 번호(tid)로 req.tenantId (이 값으로 withTenant → RLS)
//   2) 그게 없고 DEV_AUTH=1(시험 전용, 운영에서는 절대 안 켜짐)이면 예전 개발용 x-dev-tenant 헤더
//   3) 둘 다 아니면 401 UNAUTHENTICATED
// 로그인·갱신·로그아웃·설정 경로(/auth/login 등)는 자기가 인증을 처리하므로 여기서 건너뛴다 (routes/auth.ts)
// 이메일+비밀번호가 기본이고(외부 앱 등록이 필요 없어 데모 기기 어디서나 돈다), GHLOGIN 으로 GitHub OAuth 를 더했다:
//   /auth/github/start·callback 이 같은 세션 표(auth_sessions)에 줄을 넣고 같은 svc_refresh 쿠키를 준다
// 온프레 설치 한 줄이 받는 스크립트·묶음 파일 (routes/onprem-install.ts). 회사 데이터·비밀이 없다 (비밀은 등록 응답으로만)
export const isPublicInstallPath = (url: string) => /^\/api\/v1\/install\/onprem(\.sh|\/[A-Za-z0-9._\/-]+)(\?|$)/.test(url);
// 팀 가입(routes/signup.ts): POST /auth/signup 은 초대 코드로, GET /auth/signup/config 는 회사 데이터 없음
export const isPublicAuthPath = (url: string) => /^\/api\/v1\/auth\/(login|refresh|logout|config|signup|signup\/config|github\/(start|callback))(\?|$)/.test(url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const isViaCloudflare = (req: FastifyRequest) =>
  req.headers["cf-connecting-ip"] !== undefined || req.headers["cf-ray"] !== undefined;

// L8: 요청마다 사용자 재확인 (IA 4.1 5단계). 토큰이 멀쩡해도 그 사이 사용자가 꺼졌거나 지워졌으면 거부한다.
//   캐시 없이 요청당 DB 1번 (IA 10 "비용 = DB 조회 1번"). true = 계속 써도 됨, false = 거부(401 USER_DISABLED).
//   함수는 주입한다: 옵션을 안 주면 확인을 건너뛰어(지금 동작 그대로) DB 없는 시험이 안 깨진다. 진짜 앱(app.ts)이 dbUserActive 를 넣는다
// DRAFT(ai) L8: 회사 번호는 토큰(tid)에서만 온다(withTenant → RLS). 다른 회사 사용자 번호면 줄이 안 보여 false
export type UserRecheck = (tenantId: string, userId: string) => Promise<boolean>;
// L8b: lookupPat = 개인 토큰(svc_pat_…) 해시로 찾기. 옵션이 없으면 개인 토큰은 전부 401 (DB 없는 시험용)
export interface AuthPluginOptions { recheckUser?: UserRecheck; lookupPat?: PatLookup }
export const dbUserActive: UserRecheck = (tenantId, userId) =>
  withTenant(tenantId, async (tx) => {
    const q = await tx.query(`SELECT disabled_at IS NULL AS active FROM users WHERE id = $1`, [userId]);
    return q.rows[0]?.active === true;
  });

async function authPluginImpl(app: FastifyInstance, opts: AuthPluginOptions) {
  const recheckUser = opts.recheckUser;
  const lookupPat = opts.lookupPat;
  app.decorateRequest("tenantId", "");
  app.decorateRequest("actor", "");
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    // 쿠버네티스 프로브(살아 있음·준비됨)는 헤더 없이 부른다
    if (req.url === "/healthz" || req.url === "/readyz") return;
    // 온프레 Agent 보고(/agent/...)는 사람 세션이 아니라 Agent 키 서명으로 인증한다.
    // 그 경로의 처리기(acceptAgentReport)가 원본 본문으로 서명을 검증하고 회사 번호를 정한다
    if (isAgentPath(req.url)) return;
    // API 문서(OpenAPI·Swagger UI)는 회사 데이터가 없는 읽기 전용이라 운영 모드에서도 공개 (Z30)
    // DRAFT(ai) Z30: 운영 기본 = 공개. 닫으려면 DOCS_PUBLIC=false (그러면 다른 경로처럼 로그인 필요)
    if (/^\/api\/v1\/docs(\/|\?|$)/.test(req.url) && process.env.DOCS_PUBLIC !== "false") return;
    if (isPublicAuthPath(req.url)) return;
    if (isPublicInstallPath(req.url)) return;
    const authz = req.headers.authorization;
    if (typeof authz === "string" && /^Bearer /i.test(authz)) {
      const raw = authz.slice(7).trim();
      // L8b: CLI 개인 토큰. JWT 가 아니라 해시로 DB 에서 찾는다. 회사·사용자는 찾은 줄에서만 정한다(요청 값 무시)
      //   req.auth 는 비워 둔다 → 개인 토큰으로는 /auth/me·토큰 만들기·지우기 불가 (사람 로그인 전용)
      if (raw.startsWith(PAT_PREFIX)) {
        const row = lookupPat && isPatShape(raw) ? await lookupPat(hashPat(raw)) : undefined;
        if (!row || row.revoked || row.expiresAt.getTime() <= Date.now())
          return sendError(req, reply, 401, "UNAUTHENTICATED", "invalid or expired token");
        if (recheckUser && !(await recheckUser(row.tenantId, row.userId)))
          return sendError(req, reply, 401, "USER_DISABLED", "user is disabled or removed");
        req.tenantId = row.tenantId;
        req.actor = `user:${row.userId}`;
        return;
      }
      const secret = jwtSecret();
      const claims = secret ? verifyAccess(raw, secret) : null;
      if (!claims) return sendError(req, reply, 401, "UNAUTHENTICATED", "invalid or expired token");
      // z75-69: 로그아웃·재사용 감지로 끊긴 로그인 묶음의 토큰 (만료 전이라도)
      if (isFamilyRevoked(claims.fam)) return sendError(req, reply, 401, "TOKEN_REVOKED", "this login was signed out");
      // L8: 끄거나 지운 사용자는 만료 전 토큰이라도 거부. 확인 자체가 실패하면(DB 오류) 던져서 500 — 열어 주지 않는다
      if (recheckUser && !(await recheckUser(claims.tid, claims.sub)))
        return sendError(req, reply, 401, "USER_DISABLED", "user is disabled or removed");
      req.tenantId = claims.tid;
      req.actor = `user:${claims.sub}`;
      req.auth = claims;
      return;
    }
    // 개발용 헤더 인증은 DEV_AUTH=1 일 때만, 운영 모드에서는 절대 안 켠다 (위협 모델: 헤더만 바꾸면 남의 회사가 된다)
    if (!devHeaderAuthEnabled())
      return sendError(req, reply, 401, "UNAUTHENTICATED", "login required");
    const t = req.headers["x-dev-tenant"];
    if (typeof t !== "string" || !UUID.test(t)) return sendError(req, reply, 401, "UNAUTHENTICATED", "no session");
    // Z47: 개발용 헤더 인증이 켜진 채 Cloudflare 터널(런북 4-6 임시 터널)로 들어온 요청은 읽기만 허용한다.
    //   터널 주소를 아는 사람은 시드 회사 번호(문서에 있음)만 넣으면 남의 회사로 이전을 시작할 수 있기 때문.
    //   Cloudflare 는 터널로 넘기는 요청마다 cf-connecting-ip 를 붙인다【사실, Cloudflare HTTP 요청 헤더 문서】. 로컬 요청에는 없다.
    // DRAFT(ai): 터널로도 쓰기가 필요하면 DEV_TUNNEL_WRITE=1 (진짜 로그인 붙기 전에는 권하지 않음)
    if (isViaCloudflare(req) && !SAFE_METHODS.has(req.method) && process.env.DEV_TUNNEL_WRITE !== "1")
      return sendError(req, reply, 403, "TUNNEL_READ_ONLY", "dev header auth over a public tunnel is read-only");
    req.tenantId = t;
    req.actor = isViaCloudflare(req) ? "user:dev-tunnel" : "user:dev";
  });
  // L10: 위에서 Agent 경로는 인증을 건너뛴다. 그래서 Agent 경로를 붙일 때 서명 검증을 빠뜨리면
  // 회사 번호가 ""인 채(RLS가 다 막지만 무인증) 처리기가 돈다. 경로를 등록하는 순간 막는다:
  // config.agentSignature = true + preHandler(서명 검증) 둘 다 있어야 등록된다. 없으면 서버가 안 뜬다(app.ready 실패)
  // DRAFT(ai): preHandler가 "정말 서명을 보는지"는 여기서 알 수 없다. 표시는 리뷰에서 눈에 띄게 하려는 장치다
  app.addHook("onRoute", (r) => {
    if (!isAgentPath(r.url)) return;
    const hasPre = Array.isArray(r.preHandler) ? r.preHandler.length > 0 : typeof r.preHandler === "function";
    if (r.config?.agentSignature !== true || !hasPre)
      throw new Error(`agent route ${r.method} ${r.url} must set config.agentSignature=true and a signature-verifying preHandler`);
  });
}

// fp로 감싸야 훅·오류 처리가 모든 경로에 걸린다 (안 감싸면 이 플러그인 안에만 적용)
// Z81: name·dependencies 는 fastify-plugin 이 등록할 때 확인한다. 순서가 틀리면 서버가 뜨기 전에(app.ready) 멈춘다. 순서가 맞으면 동작은 같다
export const authPlugin = fp(authPluginImpl, { name: "svc-auth", fastify: "5.x" });
