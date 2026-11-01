import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// 접근 토큰 = JWT HS256 (Z93). 외부 패키지 없이 node:crypto HMAC.
// 출처: RFC 7519(JWT), RFC 8725(JWT BCP: alg 고정·"none" 거부·aud/iss 확인), OWASP JSON Web Token Cheat Sheet
//   - 헤더 alg 는 HS256 만 받는다 (alg 바꿔치기·none 공격 차단)
//   - 서명 비교는 timingSafeEqual
//   - iss·aud·typ·exp 확인, 시계 오차 30초까지
export const JWT_ISS = "svc-control-plane";
export const JWT_AUD = "svc-api";
const SKEW_SEC = 30;

export interface AccessClaims {
  sub: string;   // 사용자 번호
  tid: string;   // 회사 번호 → withTenant(RLS)
  sid: string;   // 로그인 세션 번호 (로그아웃·감사 연결용)
  fam: string;   // 로그인 묶음 번호 (auth_sessions.family_id). 갱신해도 그대로 → 로그아웃·재사용 감지 때 이 묶음 토큰을 모두 막는다 (z75-69)
  email: string;
  typ: "access";
  iss: string; aud: string; iat: number; exp: number;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const HEADER = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));

export function signAccess(c: Pick<AccessClaims, "sub" | "tid" | "sid" | "fam" | "email">, secret: Buffer, ttlSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const body: AccessClaims = { ...c, typ: "access", iss: JWT_ISS, aud: JWT_AUD, iat: nowSec, exp: nowSec + ttlSec };
  const data = `${HEADER}.${b64u(JSON.stringify(body))}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function verifyAccess(token: string, secret: Buffer, nowSec = Math.floor(Date.now() / 1000)): AccessClaims | null {
  if (token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; typ?: unknown }, body: Partial<AccessClaims>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    body = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch { return null; }
  if (header?.alg !== "HS256") return null;
  const want = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (body.typ !== "access" || body.iss !== JWT_ISS || body.aud !== JWT_AUD) return null;
  if (typeof body.exp !== "number" || body.exp + SKEW_SEC <= nowSec) return null;
  if (typeof body.iat !== "number" || body.iat - SKEW_SEC > nowSec) return null;
  if (!UUID.test(String(body.sub)) || !UUID.test(String(body.tid)) || !UUID.test(String(body.sid)) || !UUID.test(String(body.fam))) return null;
  return body as AccessClaims;
}

// 서명 비밀: .env JWT_SECRET (32자 이상). 운영(NODE_ENV=production)에서 없으면 main.ts 가 시작을 멈춘다.
// DRAFT(ai) Z93: 개발에서 없으면 프로세스마다 무작위 비밀을 만든다 → API 를 다시 띄우면 다시 로그인(리프레시 쿠키는 DB 라 그대로 살아서 화면이 알아서 새 토큰을 받는다)
let devSecret: Buffer | null = null;
export function jwtSecret(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const v = env.JWT_SECRET;
  if (v && v.length >= 32) return Buffer.from(v, "utf8");
  if (env.NODE_ENV === "production" || env.AUTH_MODE === "real") return null;
  devSecret ??= randomBytes(32);
  return devSecret;
}
export const jwtSecretProblem = (env: NodeJS.ProcessEnv = process.env): string | null =>
  env.JWT_SECRET && env.JWT_SECRET.length < 32 ? "JWT_SECRET must be at least 32 characters"
    : !env.JWT_SECRET && (env.NODE_ENV === "production" || env.AUTH_MODE === "real") ? "JWT_SECRET is required when NODE_ENV=production or AUTH_MODE=real"
      : null;
