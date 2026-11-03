import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { QUEUES, MigrationView, SourceScope } from "@svc/contracts";
import { withTenant, advance } from "@svc/core";
import { Accepted, MigrationList, errors } from "./responses.js";
import { IdParam, auditOk, found, isoUtc, nextJob } from "./kit.js";

const CreateMigration = z.object({
  sourceEnvId: z.uuid(),
  targetEnvId: z.uuid(),
  // K-1: 이 이전의 출발 범위 (클러스터·네임스페이스·앱 묶음·DB·앱 이름). 없으면 자동 고르기 + 검토 줄
  sourceScope: SourceScope.optional(),
}).strict().refine((b) => b.sourceEnvId !== b.targetEnvId, { message: "source and target must differ", path: ["targetEnvId"] });

export async function migrationRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // 이전 만들기 + 가져오기 시작 (T01). 202와 번호만 돌려준다
  r.post("/migrations", { schema: { body: CreateMigration,
    response: { 202: Accepted, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    // Idempotency-Key가 있으면 같은 키 두 번째 요청은 첫 응답(같은 id)을 그대로 돌려준다
    return req.idempotent(reply, async (tx) => {
      const ins = await tx.query(
        `INSERT INTO migrations (tenant_id, source_env_id, target_env_id, source_scope)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [req.tenantId, req.body.sourceEnvId, req.body.targetEnvId, req.body.sourceScope ?? {}]);
      const id: string = ins.rows[0].id;
      await advance(tx, { id, tenantId: req.tenantId }, "draft", "importing", {
        next: nextJob(req, QUEUES.import, id),
        audit: auditOk(req, "migration.importing", id),
      });
      return { status: 202, body: { id } };
    });
  });

  r.get("/migrations/:id", { schema: { params: IdParam, response: { 200: MigrationView, ...errors(400, 401, 404, 500) } } }, async (req) => {
    return withTenant(req.tenantId, async (tx) => {
      const q = await tx.query(
        `SELECT id, status, version, source_env_id AS "sourceEnvId",
                target_env_id AS "targetEnvId", paused_from AS "pausedFrom",
                failed_at_status AS "failedAtStatus", failure_code AS "failureCode",
                ${isoUtc("rollback_window_ends_at")} AS "rollbackWindowEndsAt",
                source_scope AS "sourceScope",
                ${isoUtc("updated_at")} AS "updatedAt"
           FROM migrations WHERE id=$1`, [req.params.id]);
      return found(q.rows[0], "migration", req.params.id);
    });
  });

  // 이전 목록 (최근 50개). 화면 목록용
  // DRAFT(ai): 페이지 나누기 없음, 50개 고정
  r.get("/migrations", { schema: { response: { 200: MigrationList, ...errors(401, 500) } } }, async (req) => {
    return withTenant(req.tenantId, async (tx) => {
      const q = await tx.query(
        `SELECT id, status, version, source_env_id AS "sourceEnvId",
                target_env_id AS "targetEnvId",
                -- Z17: 응답 스키마(updatedAt: string)에 맞게 DB에서 문자열로. Date의 JSON 모양과 같은 글자 (상세 조회와 같은 식)
                ${isoUtc("updated_at")} AS "updatedAt"
           FROM migrations ORDER BY updated_at DESC LIMIT 50`);
      return { items: q.rows };
    });
  });
}
