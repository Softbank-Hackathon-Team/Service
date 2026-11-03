import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AppSpec, AppSpecV2, ImportResultV2, type FieldMeta, MigrationSpecViewV2, SpecPatchInput, SpecV2ConfirmPath, SpecV2FieldPath, checkV2 } from "@svc/contracts";
import { rebuildFromV2 } from "@svc/adapters";
import { BadRequest, DomainError, SPEC_DRAFT_KEY, applySpecPatch, applySpecV2Patch, notifyMigration, saveSpecRevision, withTenant, writeAudit,
         type SpecMeta, type Tx } from "@svc/core";
import { errors } from "./responses.js";
import { IdParam, auditOk, found, isoUtc } from "./kit.js";

// Z100 (Z101 요청, 기능 #10·#32 화면): GET /api/v1/migrations/:id/spec — 그 이전의 최신 명세 한 판 (읽기 전용)
//   1) 받아들인 판(field_meta 에 _draft 없음) 중 최신 → source "accepted" (계획·비용·적용이 쓰는 판과 같은 규칙, core latestAcceptedSpec)
//   2) 없으면 AI 초안 판 최신 → source "ai_draft"
//   3) 둘 다 없으면 404 (이전이 없어도 404 — 회사 벽 밖 이전은 RLS 로 안 보여서 같은 404)
//   저장된 spec 이 AppSpec 일부 모양도 안 맞으면 409 SPEC_INVALID (가짜 기본값으로 채우지 않는다)
// PA2v2: specV2 = spec_v2 칸 {spec, fieldMeta, unmapped, ids, environment?} (0023). 가져오기 v2 판에만 있고 나머지는 NULL
type Row = { version: number; createdAt: string; spec: unknown; fieldMeta: Record<string, unknown> | null; draft: boolean; specV2?: unknown };

const reviewKeys = (meta: unknown, skip?: string) => Object.entries((meta ?? {}) as Record<string, unknown>)
  .filter(([k, v]) => k !== skip && !!v && typeof v === "object" && (v as { needs_review?: unknown }).needs_review === true)
  .map(([k]) => k).sort();

export function toSpecView(migrationId: string, row: Row): MigrationSpecViewV2 {
  const full = AppSpec.safeParse(row.spec);
  const part = full.success ? full : AppSpec.partial().safeParse(row.spec);
  if (!part.success) throw new DomainError(409, "SPEC_INVALID", `spec version ${row.version} does not match AppSpec`);
  const needsReview = reviewKeys(row.fieldMeta, SPEC_DRAFT_KEY);
  // PA2v2: v2 판이면 v2 검토 키도 (화면이 confirm 에 그대로 보냄). v1 판은 키 자체가 없음 → 응답 글자 그대로
  const v2 = row.specV2 && typeof row.specV2 === "object" ? (row.specV2 as { fieldMeta?: unknown }) : undefined;
  return { migrationId, version: row.version, createdAt: row.createdAt, source: row.draft ? "ai_draft" : "accepted",
           complete: full.success, spec: part.data, needsReview, ...(v2 ? { needsReviewV2: reviewKeys(v2.fieldMeta) } : {}) };
}

// 화면이 GET 으로 보는 판 = 받아들인 최신 판, 없으면 AI 초안 최신 판 (PATCH 의 baseVersion 도 이 판과 비교)
async function shownSpec(tx: Tx, migrationId: string): Promise<Row | undefined> {
  return (await tx.query(
    `SELECT version, ${isoUtc("created_at")} AS "createdAt", spec, field_meta AS "fieldMeta", (field_meta ? $2) AS draft,
            to_jsonb(sv)->'spec_v2' AS "specV2"
       FROM spec_versions sv WHERE migration_id = $1
      ORDER BY (field_meta ? $2), version DESC LIMIT 1`, [migrationId, SPEC_DRAFT_KEY])).rows[0] as Row | undefined;
}

export async function specRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/migrations/:id/spec", { schema: { params: IdParam,
    response: { 200: MigrationSpecViewV2, ...errors(400, 401, 404, 409, 500) } } }, async (req) => {
    const row = found(await withTenant(req.tenantId, (tx) => shownSpec(tx, req.params.id)), "spec", req.params.id);
    return toSpecView(req.params.id, row);
  });

  // PA2 (계획 26 · A2 v1): PATCH /api/v1/migrations/:id/spec — 사람이 칸을 고치거나(changes) 봤다고 확인(confirm)하거나
  //   AI 초안 판을 받아들인다(acceptDraft). 결과는 언제나 새 판 하나(받아들인 판, _draft 없음). 200 + 새 판 보기
  //   - 상태 spec_review 에서만. 상태는 안 바꾸므로 advance() 를 안 부른다 → 이전 행 FOR UPDATE 를 먼저 잡아
  //     POST /plan(spec_review → prechecking) 과 줄을 세운다. 잠금 순서: 이전 행 → 명세 줄 → 감사(맨 끝)
  //   - 같은 Idempotency-Key 재전송 → 첫 응답 그대로(판 하나만 늘어남). req.idempotent 는 메서드를 안 가린다
  //   - 감사 spec.edited 에는 칸 이름만 (값은 비밀일 수 있어 안 남김). 본문 로그도 안 찍는다
  //   - PA2v2: 기준 판(acceptDraft 면 그 초안 판)에 spec_v2 가 있으면 v2 경로만 받는다(v1 키 → 400 SPEC_PATH_IR_MISMATCH).
  //     v2 를 고친 뒤 AppSpecV2 + checkV2 errors 로 검사하고 rebuildFromV2 로 v1 spec·field_meta 를 다시 뽑아 세 칸을 한 줄에 같이 쓴다.
  //     spec_v2 가 NULL 인 판에 v2 경로 → 같은 400. 감사 detail 에 ir:"v2" (v1 판 감사 줄은 지금 글자 그대로)
  r.patch("/migrations/:id/spec", { schema: { params: IdParam, body: SpecPatchInput,
    response: { 200: MigrationSpecViewV2, ...errors(400, 401, 404, 409, 500) } } }, async (req, reply) => {
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
      // DRAFT(ai): AI 초안 판은 spec_v2 가 없다. 그냥 받아들이면 새 판도 spec_v2 NULL 이라 v2 검토 칸(평문 비밀 env 등)이 사라져 /plan 이 통과한다(VPA2v2).
      //   → 초안에 spec_v2 가 없으면 직전 받아들인 판의 spec_v2 를 그대로 이어받는다(검토 칸 유지). 초안의 v1 값은 그대로 받아들이고,
      //   v2 칸은 사람이 이어서 PATCH(v2 경로)로 확인·수정한다. 다음 v2 PATCH 는 v1 을 v2 에서 다시 뽑으므로 초안의 v1 값이 v2 와 다르면 v2 쪽이 이긴다
      let inheritedV2: Record<string, unknown> | undefined;
      if (b.acceptDraft !== undefined) {
        const d = (await tx.query(
          `SELECT version, ${isoUtc("created_at")} AS "createdAt", spec, field_meta AS "fieldMeta", true AS draft,
                  to_jsonb(sv)->'spec_v2' AS "specV2"
             FROM spec_versions sv WHERE migration_id = $1 AND version = $2 AND (field_meta ? $3)`,
          [id, b.acceptDraft, SPEC_DRAFT_KEY])).rows[0] as Row | undefined;
        // DRAFT(ai): 없는 초안 번호 → 400. 받아들인 판보다 옛 초안 → 409 (사람이 고친 판을 옛 AI 판으로 덮지 않게)
        if (!d) throw new BadRequest("SPEC_DRAFT_NOT_FOUND", `no AI draft version ${b.acceptDraft}`);
        if (!current.draft && d.version < current.version)
          throw new DomainError(409, "SPEC_DRAFT_STALE", `draft ${d.version} is older than accepted ${current.version}`);
        base = d;
        if (!(d.specV2 && typeof d.specV2 === "object")) {
          const prev = (await tx.query(
            `SELECT to_jsonb(sv)->'spec_v2' AS "specV2" FROM spec_versions sv
              WHERE migration_id = $1 AND NOT (field_meta ? $2) ORDER BY version DESC LIMIT 20`, [id, SPEC_DRAFT_KEY])).rows as Array<{ specV2: unknown }>;
          const found2 = prev.find((x) => x.specV2 && typeof x.specV2 === "object");
          if (found2) inheritedV2 = found2.specV2 as Record<string, unknown>;
        }
      } else if (current.draft) {
        // DRAFT(ai): 받아들인 판이 없고 AI 초안만 있으면 acceptDraft 로 먼저 받아들여야 한다 (모르고 AI 값을 사람 판으로 굳히지 않게)
        throw new DomainError(409, "SPEC_DRAFT_NOT_ACCEPTED", `version ${current.version} is an AI draft; send acceptDraft`);
      }

      const v2Base = base.specV2 && typeof base.specV2 === "object" ? base.specV2 as Record<string, unknown> : undefined;
      const paths = [...(b.changes ?? []).map((c) => ({ p: c.path, v2: SpecV2FieldPath.safeParse(c.path).success })),
                     ...(b.confirm ?? []).map((p) => ({ p, v2: SpecV2ConfirmPath.safeParse(p).success }))];
      const wrong = paths.filter((x) => x.v2 !== !!v2Base).map((x) => x.p);
      if (wrong.length)
        throw new BadRequest("SPEC_PATH_IR_MISMATCH", `version ${base.version} is ${v2Base ? "v2: send components./links/entry/check. paths" : "v1: v2 paths not allowed"} (${wrong.slice(0, 5).join(", ")})`);
      if (v2Base) return patchV2(tx, req, id, b, base, v2Base);

      const next = applySpecPatch({ spec: base.spec, fieldMeta: base.fieldMeta as SpecMeta | null },
        { changes: b.changes, confirm: b.confirm });
      // 칸 모양 검사. 가져오기가 일부만 채운 판도 고칠 수 있게 partial (모자란 칸은 GET 의 complete=false, 계획 단계가 막음)
      const ok = AppSpec.partial().safeParse(next.spec);
      if (!ok.success)   // 값은 안 돌려줌 (비밀일 수 있음). 칸 이름과 이유만
        throw new BadRequest("SPEC_PATCH_INVALID",
          ok.error.issues.slice(0, 10).map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));

      const saved = await saveSpecRevision(tx, { tenantId: req.tenantId, migrationId: id, spec: ok.data, fieldMeta: next.fieldMeta,
        ...(inheritedV2 ? { specV2: inheritedV2 } : {}) });
      await writeAudit(tx, req.tenantId, auditOk(req, "spec.edited", id, {
        baseVersion: b.baseVersion, version: saved.version, changed: next.changed, confirmed: next.confirmed,
        ...(b.acceptDraft !== undefined ? { acceptedDraft: b.acceptDraft } : {}), ...(inheritedV2 ? { inheritedV2: true } : {}) }));
      await notifyMigration(tx, { t: req.tenantId, id, s: "spec_review" });
      return { status: 200, body: toSpecView(id, { version: saved.version, createdAt: saved.createdAt, spec: ok.data,
        fieldMeta: next.fieldMeta, draft: false, ...(inheritedV2 ? { specV2: inheritedV2 } : {}) }) };
    });
  });
}

// ---- PA2v2: v2 판 고치기 (계획 26 A2 v2 분기·함정 표) ----
type Req = { tenantId: string } & Parameters<typeof auditOk>[0];
const badV2 = (msg: string) => new BadRequest("SPEC_PATCH_INVALID", msg);

async function patchV2(tx: Tx, req: Req, id: string, b: SpecPatchInput, base: Row, v2Base: Record<string, unknown>) {
  const prevV1 = AppSpec.safeParse(base.spec);
  // DRAFT(ai): v2 판인데 v1 이 전체 모양이 아니면 rebuildFromV2 재료(env·secretRefs)가 없음 → 409 SPEC_INVALID (가짜 값으로 안 채움)
  if (!prevV1.success) throw new DomainError(409, "SPEC_INVALID", `spec version ${base.version} v1 part does not match AppSpec`);
  const next = applySpecV2Patch({ spec: v2Base.spec, fieldMeta: (v2Base.fieldMeta ?? {}) as SpecMeta }, { changes: b.changes, confirm: b.confirm });
  const v2 = AppSpecV2.safeParse(next.spec);
  if (!v2.success)   // 값은 안 돌려줌 (비밀일 수 있음). 칸 이름과 이유만
    throw badV2(v2.error.issues.slice(0, 10).map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));
  const errs = checkV2(v2.data).errors;
  if (errs.length) throw badV2(errs.slice(0, 10).join("; "));
  // DRAFT(ai): checkV2 reviews 는 다시 세지 않는다 (가져오기 때 붙인 check.reviews[i] 키를 그대로 두고 사람이 confirm). 다시 세면 번호가 밀려 확인한 줄이 되살아남
  const result = ImportResultV2.safeParse({ ...v2Base, spec: v2.data, fieldMeta: next.fieldMeta });
  if (!result.success) throw badV2(result.error.issues.slice(0, 10).map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));
  let v1;
  // v1 field_meta 는 rebuildFromV2 한 번으로 (v2 쪽 바꿈·확인이 v1 검토 표시에도 남게 — 함정 표)
  try { v1 = rebuildFromV2(result.data, prevV1.data, { confirmed: [...next.changed, ...(b.confirm ?? [])], prevMeta: (base.fieldMeta ?? {}) as FieldMeta }); }
  catch (e) { throw badV2(e instanceof Error ? e.message : String(e)); }   // SPEC_V2_INVALID·PG_VERSION_UNSUPPORTED 등 → 400
  const ok = AppSpec.partial().safeParse(v1.spec);
  if (!ok.success) throw badV2(ok.error.issues.slice(0, 10).map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));

  const saved = await saveSpecRevision(tx, { tenantId: req.tenantId, migrationId: id, spec: ok.data, fieldMeta: v1.fieldMeta, specV2: result.data });
  await writeAudit(tx, req.tenantId, auditOk(req, "spec.edited", id, {
    baseVersion: b.baseVersion, version: saved.version, changed: next.changed, confirmed: next.confirmed, ir: "v2",
    ...(b.acceptDraft !== undefined ? { acceptedDraft: b.acceptDraft } : {}) }));
  await notifyMigration(tx, { t: req.tenantId, id, s: "spec_review" });
  return { status: 200, body: toSpecView(id, { version: saved.version, createdAt: saved.createdAt, spec: ok.data,
    fieldMeta: v1.fieldMeta, draft: false, specV2: result.data }) };
}
