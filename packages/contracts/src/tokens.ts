import { z } from "zod";

// L8b: CLI 개인 토큰. 원문(token)은 만든 응답에서 한 번만 나간다. DB 에는 sha256 만
// DRAFT(ai) L8b: 최대 30일(IA 7.1), 범위는 "만든 사용자와 같음" 하나
export const PAT_PREFIX = "svc_pat_";
export const PAT_MAX_TTL_DAYS = 30;

export const CreateTokenBody = z.object({
  name: z.string().trim().min(1).max(64),
  ttlDays: z.number().int().min(1).max(PAT_MAX_TTL_DAYS).default(PAT_MAX_TTL_DAYS),
}).strict();
export type CreateTokenBody = z.infer<typeof CreateTokenBody>;

export const TokenView = z.object({
  id: z.uuid(), name: z.string(), createdAt: z.string(), expiresAt: z.string(), revoked: z.boolean(),
}).strict();
export type TokenView = z.infer<typeof TokenView>;
export const TokenCreated = TokenView.extend({ token: z.string() }).strict();
export type TokenCreated = z.infer<typeof TokenCreated>;
export const TokenList = z.object({ items: z.array(TokenView) }).strict();
