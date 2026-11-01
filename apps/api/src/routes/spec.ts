import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AppSpec, MigrationSpecView } from "@svc/contracts";
import { DomainError, SPEC_DRAFT_KEY, withTenant } from "@svc/core";
import { errors } from "./responses.js";
import { IdParam, found, isoUtc } from "./kit.js";

// Z100 (Z101 요청, 기능 #10·#32 화면): GET /api/v1/migrations/:id/spec — 그 이전의 최신 명세 한 판 (읽기 전용)
//   1) 받아들인 판(field_meta 에 _draft 없음) 중 최신 → source "accepted" (계획·비용·적용이 쓰는 판과 같은 규칙, core latestAcceptedSpec)
//   2) 없으면 AI 초안 판 최신 → source "ai_draft"
//   3) 둘 다 없으면 404 (이전이 없어도 404 — 회사 벽 밖 이전은 RLS 로 안 보여서 같은 404)
//   저장된 spec 이 AppSpec 일부 모양도 안 맞으면 409 SPEC_INVALID (가짜 기본값으로 채우지 않는다)
type Row = { version: number; createdAt: string; spec: unknown; fieldMeta: Record<string, unknown> | null; draft: boolean };

export function toSpecView(migrationId: string, row: Row): MigrationSpecView {
  const full = AppSpec.safeParse(row.spec);
  const part = full.success ? full : AppSpec.partial().safeParse(row.spec);
  if (!part.success) throw new DomainError(409, "SPEC_INVALID", `spec version ${row.version} does not match AppSpec`);
  const needsReview = Object.entries(row.fieldMeta ?? {})
    .filter(([k, v]) => k !== SPEC_DRAFT_KEY && !!v && typeof v === "object" && (v as { needs_review?: unknown }).needs_review === true)
    .map(([k]) => k).sort();
  return { migrationId, version: row.version, createdAt: row.createdAt, source: row.draft ? "ai_draft" : "accepted",
           complete: full.success, spec: part.data, needsReview };
}

export async function specRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/migrations/:id/spec", { schema: { params: IdParam,
    response: { 200: MigrationSpecView, ...errors(400, 401, 404, 409, 500) } } }, async (req) => {
    const row = found(await withTenant(req.tenantId, async (tx) => (await tx.query(
      `SELECT version, ${isoUtc("created_at")} AS "createdAt", spec, field_meta AS "fieldMeta", (field_meta ? $2) AS draft
         FROM spec_versions WHERE migration_id = $1
        ORDER BY (field_meta ? $2), version DESC LIMIT 1`, [req.params.id, SPEC_DRAFT_KEY])).rows[0] as Row | undefined),
      "spec", req.params.id);
    return toSpecView(req.params.id, row);
  });
}
