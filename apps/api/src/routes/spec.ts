import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AppSpec, MigrationSpecView, SpecPatchInput } from "@svc/contracts";
import { BadRequest, DomainError, SPEC_DRAFT_KEY, applySpecPatch, notifyMigration, saveSpecRevision, withTenant, writeAudit,
         type SpecMeta, type Tx } from "@svc/core";
import { errors } from "./responses.js";
import { IdParam, auditOk, found, isoUtc } from "./kit.js";

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

// 화면이 GET 으로 보는 판 = 받아들인 최신 판, 없으면 AI 초안 최신 판 (PATCH 의 baseVersion 도 이 판과 비교)
async function shownSpec(tx: Tx, migrationId: string): Promise<Row | undefined> {
  return (await tx.query(
    `SELECT version, ${isoUtc("created_at")} AS "createdAt", spec, field_meta AS "fieldMeta", (field_meta ? $2) AS draft
       FROM spec_versions WHERE migration_id = $1
      ORDER BY (field_meta ? $2), version DESC LIMIT 1`, [migrationId, SPEC_DRAFT_KEY])).rows[0] as Row | undefined;
}

export async function specRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/migrations/:id/spec", { schema: { params: IdParam,
    response: { 200: MigrationSpecView, ...errors(400, 401, 404, 409, 500) } } }, async (req) => {
    const row = found(await withTenant(req.tenantId, (tx) => shownSpec(tx, req.params.id)), "spec", req.params.id);
    return toSpecView(req.params.id, row);
  });

  // PA2 (계획 26 · A2 v1): PATCH /api/v1/migrations/:id/spec — 사람이 칸을 고치거나(changes) 봤다고 확인(confirm)하거나
  //   AI 초안 판을 받아들인다(acceptDraft). 결과는 언제나 새 판 하나(받아들인 판, _draft 없음). 200 + 새 판 보기
  //   - 상태 spec_review 에서만. 상태는 안 바꾸므로 advance() 를 안 부른다 → 이전 행 FOR UPDATE 를 먼저 잡아
  //     POST /plan(spec_review → prechecking) 과 줄을 세운다. 잠금 순서: 이전 행 → 명세 줄 → 감사(맨 끝)
  //   - 같은 Idempotency-Key 재전송 → 첫 응답 그대로(판 하나만 늘어남). req.idempotent 는 메서드를 안 가린다
  //   - 감사 spec.edited 에는 칸 이름만 (값은 비밀일 수 있어 안 남김). 본문 로그도 안 찍는다
  // TODO: v2 분기(I3 뒤, rebuildFromV2) — 기준 판에 spec_v2 가 있으면 v2 경로만 받고 rebuildFromV2 로 spec·spec_v2·field_meta 를 같이 씀
  r.patch("/migrations/:id/spec", { schema: { params: IdParam, body: SpecPatchInput,
    response: { 200: MigrationSpecView, ...errors(400, 401, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id, b = req.body;
    return req.idempotent(reply, async (tx) => {
      const m = found((await tx.query("SELECT status FROM migrations WHERE id = $1 FOR UPDATE", [id])).rows[0] as
        { status: string } | undefined, "migration", id);
      // DRAFT(ai): 상태가 다르면 409 INVALID_TRANSITION (CLAUDE.md 5-7 상태 규칙 위반 코드와 통일, 계획 26 3.3)
      if (m.status !== "spec_review")
        throw new DomainError(409, "INVALID_TRANSITION", `spec can be edited only in spec_review (now ${m.status})`);
      const current = found(await shownSpec(tx, id), "spec", id);
      if (b.baseVersion !== current.version)
        throw new DomainError(409, "SPEC_VERSION_CONFLICT", `base ${b.baseVersion} is not the latest shown version ${current.version}`);

      let base: Row = current;
      if (b.acceptDraft !== undefined) {
        const d = (await tx.query(
          `SELECT version, ${isoUtc("created_at")} AS "createdAt", spec, field_meta AS "fieldMeta", true AS draft
             FROM spec_versions WHERE migration_id = $1 AND version = $2 AND (field_meta ? $3)`,
          [id, b.acceptDraft, SPEC_DRAFT_KEY])).rows[0] as Row | undefined;
        // DRAFT(ai): 없는 초안 번호 → 400. 받아들인 판보다 옛 초안 → 409 (사람이 고친 판을 옛 AI 판으로 덮지 않게)
        if (!d) throw new BadRequest("SPEC_DRAFT_NOT_FOUND", `no AI draft version ${b.acceptDraft}`);
        if (!current.draft && d.version < current.version)
          throw new DomainError(409, "SPEC_DRAFT_STALE", `draft ${d.version} is older than accepted ${current.version}`);
        base = d;
      } else if (current.draft) {
        // DRAFT(ai): 받아들인 판이 없고 AI 초안만 있으면 acceptDraft 로 먼저 받아들여야 한다 (모르고 AI 값을 사람 판으로 굳히지 않게)
        throw new DomainError(409, "SPEC_DRAFT_NOT_ACCEPTED", `version ${current.version} is an AI draft; send acceptDraft`);
      }

      const next = applySpecPatch({ spec: base.spec, fieldMeta: base.fieldMeta as SpecMeta | null },
        { changes: b.changes, confirm: b.confirm });
      // 칸 모양 검사. 가져오기가 일부만 채운 판도 고칠 수 있게 partial (모자란 칸은 GET 의 complete=false, 계획 단계가 막음)
      const ok = AppSpec.partial().safeParse(next.spec);
      if (!ok.success)   // 값은 안 돌려줌 (비밀일 수 있음). 칸 이름과 이유만
        throw new BadRequest("SPEC_PATCH_INVALID",
          ok.error.issues.slice(0, 10).map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));

      const saved = await saveSpecRevision(tx, { tenantId: req.tenantId, migrationId: id, spec: ok.data, fieldMeta: next.fieldMeta });
      await writeAudit(tx, req.tenantId, auditOk(req, "spec.edited", id, {
        baseVersion: b.baseVersion, version: saved.version, changed: next.changed, confirmed: next.confirmed,
        ...(b.acceptDraft !== undefined ? { acceptedDraft: b.acceptDraft } : {}) }));
      await notifyMigration(tx, { t: req.tenantId, id, s: "spec_review" });
      return { status: 200, body: toSpecView(id, { version: saved.version, createdAt: saved.createdAt, spec: ok.data,
        fieldMeta: next.fieldMeta, draft: false }) };
    });
  });
}
