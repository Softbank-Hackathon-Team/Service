import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { CreateTokenBody, TokenCreated, TokenList } from "@svc/contracts";
import { withTenant, writeAudit } from "@svc/core";
import { z } from "zod";
import { sendError } from "../plugins/errors.js";
import { newPat, hashPat } from "../auth/pat.js";
import { errors } from "./responses.js";
import { IdParam, found, isoUtc, auditOk } from "./kit.js";

// L8b: CLI 개인 토큰 (IA 7.1 MUST 최소)
//   POST   /tokens      {name, ttlDays≤30} → 201 원문 한 번 (DB 에는 sha256 만)
//   GET    /tokens      내 토큰 목록 (원문 없음)
//   DELETE /tokens/:id  끊기 → 204. 남의 회사·남의 토큰은 404
// 사람 로그인(Bearer JWT)으로만 만들고 지운다 — 개인 토큰으로 개인 토큰을 만들 수 없다(훅이 req.auth 를 비워 둔다)
const COLS = `id, name, ${isoUtc("created_at")} AS "createdAt", ${isoUtc("expires_at")} AS "expiresAt", revoked_at IS NOT NULL AS revoked`;

export async function tokenRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/tokens", { schema: { body: CreateTokenBody, response: { 201: TokenCreated, ...errors(400, 401, 403, 500) } } }, async (req, reply) => {
    if (!req.auth) return sendError(req, reply, 401, "UNAUTHENTICATED", "login required to create a token");
    const token = newPat();
    const row = await withTenant(req.tenantId, async (tx) => {
      const q = await tx.query(
        `INSERT INTO personal_tokens (tenant_id, user_id, name, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING ${COLS}`,
        [req.tenantId, req.auth!.sub, req.body.name, hashPat(token), req.body.ttlDays]);
      await writeAudit(tx, req.tenantId, auditOk(req, "token.create", `token:${q.rows[0].id}`, { name: req.body.name }));
      return q.rows[0];
    });
    reply.header("cache-control", "no-store");
    return reply.code(201).send({ ...row, token });
  });

  r.get("/tokens", { schema: { response: { 200: TokenList, ...errors(401, 500) } } }, async (req, reply) => {
    if (!req.auth) return sendError(req, reply, 401, "UNAUTHENTICATED", "login required");
    const items = await withTenant(req.tenantId, async (tx) => (await tx.query(
      `SELECT ${COLS} FROM personal_tokens WHERE user_id = $1 ORDER BY created_at DESC`, [req.auth!.sub])).rows);
    return { items };
  });

  r.delete("/tokens/:id", { schema: { params: IdParam, response: { 204: z.null(), ...errors(400, 401, 404, 500) } } }, async (req, reply) => {
    if (!req.auth) return sendError(req, reply, 401, "UNAUTHENTICATED", "login required");
    await withTenant(req.tenantId, async (tx) => {
      const q = await tx.query(
        `UPDATE personal_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
        [req.params.id, req.auth!.sub]);
      found(q.rows[0], "token", req.params.id);
      await writeAudit(tx, req.tenantId, auditOk(req, "token.revoke", `token:${req.params.id}`));
    });
    return reply.code(204).send(null);
  });
}
