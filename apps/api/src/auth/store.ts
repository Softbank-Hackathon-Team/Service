import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pool, withTenant, writeAudit, type Tx } from "@svc/core";

// 로그인 DB 일 (Z93). 로그인 전에는 회사 번호를 모르므로 0018 의 SECURITY DEFINER 함수 2개로만 찾고,
// 회사 번호를 안 뒤의 쓰기(세션 만들기·바꾸기·끊기)는 전부 withTenant (회사 벽 RLS) 안에서 한다

export interface LoginRow { user_id: string; tenant_id: string; email: string; display_name: string | null; password_hash: string | null; disabled: boolean }
export interface SessionRow {
  tenant_id: string; user_id: string; family_id: string; family_started_at: Date; refresh_hash: string;
  expires_at: Date; revoked_at: Date | null; revoked_reason: string | null;
}
export interface AuthUser { id: string; email: string; displayName: string | null; tenantId: string; tenantName: string }

export async function findLoginUser(email: string): Promise<LoginRow | undefined> {
  const q = await pool.query("SELECT * FROM auth_login_lookup($1)", [email]);
  return q.rows[0];
}
// GHLOGIN: GitHub 계정 번호 → 사용자 한 명 (0034 auth_github_lookup). 없으면 undefined
export interface GithubLoginRow { user_id: string; tenant_id: string; email: string; display_name: string | null; disabled: boolean }
export async function findGithubUser(githubId: string): Promise<GithubLoginRow | undefined> {
  const q = await pool.query("SELECT * FROM auth_github_lookup($1)", [githubId]);
  return q.rows[0];
}
export async function findSession(id: string): Promise<SessionRow | undefined> {
  const q = await pool.query("SELECT * FROM auth_session_lookup($1)", [id]);
  return q.rows[0];
}

// 리프레시 토큰 = "<세션 번호>.<비밀 32바이트 base64url>". DB 에는 비밀의 sha256 만
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseRefresh(token: string | undefined): { sid: string; secret: string } | null {
  if (!token || token.length > 200) return null;
  const i = token.indexOf(".");
  const sid = token.slice(0, i), secret = token.slice(i + 1);
  return i > 0 && UUID.test(sid) && /^[A-Za-z0-9_-]{43}$/.test(secret) ? { sid, secret } : null;
}
export function refreshMatches(secret: string, storedHex: string): boolean {
  const a = Buffer.from(sha256hex(secret), "hex"), b = Buffer.from(storedHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function userView(tx: Tx, userId: string): Promise<(AuthUser & { disabled: boolean }) | undefined> {
  const q = await tx.query(
    `SELECT u.id, u.email, u.display_name AS "displayName", u.tenant_id AS "tenantId", t.name AS "tenantName",
            u.disabled_at IS NOT NULL AS disabled
       FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [userId]);
  return q.rows[0];
}

// 세션 한 줄 넣고 리프레시 토큰 원문을 돌려준다 (원문은 여기서만 존재)
export async function insertSession(tx: Tx, a: { tenantId: string; userId: string; familyId: string; familyStartedAt: Date | null; ttlSec: number; maxSec: number; userAgent?: string }) {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await tx.query(
    `INSERT INTO auth_sessions (id, tenant_id, user_id, family_id, family_started_at, refresh_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6,
             LEAST(now() + make_interval(secs => $7), COALESCE($5, now()) + make_interval(secs => $8)), $9)`,
    [id, a.tenantId, a.userId, a.familyId, a.familyStartedAt, sha256hex(secret), a.ttlSec, a.maxSec, a.userAgent?.slice(0, 200) ?? null]);
  const e = await tx.query(`SELECT expires_at FROM auth_sessions WHERE id = $1`, [id]);
  return { sid: id, refresh: `${id}.${secret}`, expiresAt: e.rows[0].expires_at as Date };
}

export async function audit(tenantId: string, userId: string, action: string, result: "ok" | "denied", detail?: Record<string, unknown>) {
  await withTenant(tenantId, (tx) => writeAudit(tx, tenantId, { actor: `user:${userId}`, action, target: `user:${userId}`, result, detail }));
}
