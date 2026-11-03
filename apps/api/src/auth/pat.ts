import { createHash, randomBytes } from "node:crypto";
import { pool } from "@svc/core";
import { PAT_PREFIX } from "@svc/contracts";

// L8b: CLI 개인 토큰. 원문 = "svc_pat_" + 무작위 32바이트(base64url). DB 에는 sha256 hex 만
export const hashPat = (token: string) => createHash("sha256").update(token).digest("hex");
export const newPat = () => `${PAT_PREFIX}${randomBytes(32).toString("base64url")}`;
export const isPatShape = (token: string) => token.startsWith(PAT_PREFIX) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(PAT_PREFIX.length));

export interface PatRow { tokenId: string; tenantId: string; userId: string; expiresAt: Date; revoked: boolean }
// 해시로 찾기. 인증 훅은 회사 번호를 모르므로 SECURITY DEFINER 함수(0028 auth_token_lookup)로만 찾는다
export type PatLookup = (hash: string) => Promise<PatRow | undefined>;
export const dbPatLookup: PatLookup = async (hash) => {
  const q = await pool.query("SELECT * FROM auth_token_lookup($1)", [hash]);
  const r = q.rows[0];
  return r ? { tokenId: r.token_id, tenantId: r.tenant_id, userId: r.user_id, expiresAt: new Date(r.expires_at), revoked: r.revoked_at !== null } : undefined;
};
