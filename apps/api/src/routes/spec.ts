import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppSpecV2, FieldMetaV2, ImportAccuracy, OutOfBoundaryV2, ImportResultV2, MigrationSpecView, SpecPatchInput, checkV2, checkV2Reviews, reviewLabels, specIssueLines, syncCheckReviews,
         type ApprovalRowV2, type Provider } from "@svc/contracts";
import { applyInclude, IncludeError, targetBuilderFor } from "@svc/adapters";
import { BadRequest, DomainError, SPEC_DRAFT_KEY, applySpecV2Patch, notifyMigration, saveSpecRevision, withTenant, writeAudit,
         type SpecMeta, type Tx } from "@svc/core";
import { errors } from "./responses.js";
import { IdParam, auditOk, found, isoUtc } from "./kit.js";

// Z100 (Z101 요청, 기능 #10·#32 화면): GET /api/v1/migrations/:id/spec — 그 이전의 최신 명세 한 판 (읽기 전용)
//   1) 받아들인 판(field_meta 에 _draft 없음) 중 최신 → source "accepted" (계획·비용·적용이 쓰는 판과 같은 규칙, core latestAcceptedSpecV2)
//   2) 없으면 AI 초안 판 최신 → source "ai_draft"
//   3) 둘 다 없으면 404 (이전이 없어도 404 — 회사 벽 밖 이전은 RLS 로 안 보여서 같은 404)
//   명세 = spec_v2 칸 {spec, fieldMeta, unmapped, ids, …}. 칸이 없거나(예전 형식 판) 모양이 안 맞으면 409 SPEC_INVALID (가짜 기본값으로 채우지 않는다)
type Row = { version: number; createdAt: string; draft: boolean; specV2: unknown };

const reviewKeys = (meta: unknown) => Object.entries((meta ?? {}) as Record<string, unknown>)
  .filter(([, v]) => !!v && typeof v === "object" && (v as { needs_review?: unknown }).needs_review === true)
  .map(([k]) => k).sort();

const specInvalid = (version: number, why: string) => new DomainError(409, "SPEC_INVALID", `spec version ${version} ${why}`);

// 명세 검토 화면의 상품 대체 미리보기. 계획 확인 항목과 같은 계산(도착 Builder substitutionsV2)이고 저장·계획 지문·승인과 상관없다.
//   계산이 실패해도 명세 보기는 막지 않는다 (빈 배열)
type Ends = { source: Provider; target: Provider };
export function specSubstitutions(spec: AppSpecV2, ends: Ends | undefined): ApprovalRowV2[] {
  if (!ends) return [];
  try { return targetBuilderFor(ends.target).substitutionsV2?.(spec, ends.source) ?? []; }
  catch { return []; }
}

export function toSpecView(migrationId: string, row: Row, ends?: Ends): MigrationSpecView {
  if (!row.specV2 || typeof row.specV2 !== "object") throw specInvalid(row.version, "has no spec (예전 형식 판, 다시 가져와야 함)");
  const v = row.specV2 as { spec?: unknown; fieldMeta?: unknown; outOfBoundary?: unknown };
  // I8api: AppSpec·FieldMeta 모양이 아니면 409 SPEC_INVALID (응답 직렬화 500 대신, 가짜 값으로 안 채움)
  const spec = AppSpecV2.safeParse(v.spec);
  const meta = FieldMetaV2.safeParse(v.fieldMeta ?? {});
  if (!spec.success || !meta.success) throw specInvalid(row.version, "does not match AppSpec");
  // BOUNDVIEW DRAFT(ai): 경계 밖 목록은 판에 있을 때만 싣는다. 모양이 안 맞으면 키를 뺀다(ACCVIEW 와 같은 규칙: 화면이 안 깨지게, 명세 본체는 막지 않음)
  const oob = v.outOfBoundary !== undefined ? z.array(OutOfBoundaryV2).safeParse(v.outOfBoundary) : undefined;
  const needsReview = reviewKeys(meta.data);
  // DRAFT(ai): complete = 구조 검증(checkV2 errors) 통과. 화면이 "계획을 만들 수 있는 판인가"를 본다
  return { migrationId, version: row.version, createdAt: row.createdAt, source: row.draft ? "ai_draft" : "accepted",
           complete: checkV2(spec.data).errors.length === 0, spec: spec.data, fieldMeta: meta.data, needsReview, reviewLabels: reviewLabels(needsReview),
           ...(oob?.success ? { outOfBoundary: oob.data } : {}), substitutions: specSubstitutions(spec.data, ends),
           specV2: spec.data, fieldMetaV2: meta.data, needsReviewV2: needsReview };
}

// 화면이 GET 으로 보는 판 = 받아들인 최신 판, 없으면 AI 초안 최신 판 (PATCH 의 baseVersion 도 이 판과 비교)
async function shownSpec(tx: Tx, migrationId: string): Promise<Row | undefined> {
  return (await tx.query(
    `SELECT version, ${isoUtc("created_at")} AS "createdAt", (field_meta ? $2) AS draft, spec_v2 AS "specV2"
       FROM spec_versions sv WHERE migration_id = $1
      ORDER BY (field_meta ? $2), version DESC LIMIT 1`, [migrationId, SPEC_DRAFT_KEY])).rows[0] as Row | undefined;
}

// 이전의 출발·도착 환경 종류 (worker plan.ts 가 계획 때 읽는 두 환경 줄과 같은 출처)
async function endsOf(tx: Tx, migrationId: string): Promise<Ends | undefined> {
  return (await tx.query(
    `SELECT s.provider AS source, t.provider AS target FROM migrations m
       JOIN environments s ON s.id = m.source_env_id JOIN environments t ON t.id = m.target_env_id WHERE m.id = $1`, [migrationId])).rows[0] as Ends | undefined;
}

// ACCVIEW DRAFT(ai): 가장 최근 가져오기 감사(migration.spec_review)의 detail.accuracy. 없거나 모양이 안 맞으면 undefined (키를 뺀다, 화면 안 깨짐)
async function importAccuracyOf(tx: Tx, migrationId: string): Promise<ImportAccuracy | undefined> {
  const d = (await tx.query(
    `SELECT detail->'accuracy' AS a FROM audit_events WHERE target = $1 AND action = 'migration.spec_review' ORDER BY seq DESC LIMIT 1`, [migrationId])).rows[0] as { a: unknown } | undefined;
  const p = d?.a == null ? undefined : ImportAccuracy.safeParse(d.a);
  return p?.success ? p.data : undefined;
}

export async function specRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/migrations/:id/spec", { schema: { params: IdParam,
    response: { 200: MigrationSpecView, ...errors(400, 401, 404, 409, 500) } } }, async (req) => {
    const { row, accuracy, ends } = await withTenant(req.tenantId, async (tx) => {
      const found0 = await shownSpec(tx, req.params.id);
      return { row: found0, accuracy: found0 ? await importAccuracyOf(tx, req.params.id) : undefined,
               ends: found0 ? await endsOf(tx, req.params.id) : undefined };
    });
    return { ...toSpecView(req.params.id, found(row, "spec", req.params.id), ends), ...(accuracy ? { accuracy } : {}) };
  });

  // PA2 (계획 26 · A2 v1): PATCH /api/v1/migrations/:id/spec — 사람이 칸을 고치거나(changes) 봤다고 확인(confirm)하거나
  //   AI 초안 판을 받아들인다(acceptDraft). 결과는 언제나 새 판 하나(받아들인 판, _draft 없음). 200 + 새 판 보기
  //   - 상태 spec_review 에서만. 상태는 안 바꾸므로 advance() 를 안 부른다 → 이전 행 FOR UPDATE 를 먼저 잡아
  //     POST /plan(spec_review → prechecking) 과 줄을 세운다. 잠금 순서: 이전 행 → 명세 줄 → 감사(맨 끝)
  //   - 같은 Idempotency-Key 재전송 → 첫 응답 그대로(판 하나만 늘어남). req.idempotent 는 메서드를 안 가린다
  //   - 감사 spec.edited 에는 칸 이름만 (값은 비밀일 수 있어 안 남김). 본문 로그도 안 찍는다
  //   - PA2v2: 기준 판(acceptDraft 면 그 초안 판)의 spec_v2 를 고친 뒤 AppSpec + checkV2 errors 로 검사해 새 판 spec_v2 로 쓴다.
  //     기준 판에 명세가 없으면(예전 형식 판) 409 SPEC_INVALID
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
          `SELECT version, ${isoUtc("created_at")} AS "createdAt", true AS draft, spec_v2 AS "specV2",
                  field_meta->$3->'baseVersion' AS "draftBase"
             FROM spec_versions sv WHERE migration_id = $1 AND version = $2 AND (field_meta ? $3)`,
          [id, b.acceptDraft, SPEC_DRAFT_KEY])).rows[0] as (Row & { draftBase: unknown }) | undefined;
        // DRAFT(ai): 없는 초안 번호 → 400. 받아들인 판보다 옛 초안 → 409 (사람이 고친 판을 옛 AI 판으로 덮지 않게)
        if (!d) throw new BadRequest("SPEC_DRAFT_NOT_FOUND", `no AI draft version ${b.acceptDraft}`);
        const stale = draftStale(current.draft ? null : current.version, d.version, d.draftBase);
        if (stale) throw new DomainError(409, "SPEC_DRAFT_STALE", stale);
        base = { version: d.version, createdAt: d.createdAt, draft: true, specV2: d.specV2 };
      } else if (current.draft) {
        // DRAFT(ai): 받아들인 판이 없고 AI 초안만 있으면 acceptDraft 로 먼저 받아들여야 한다 (모르고 AI 값을 사람 판으로 굳히지 않게)
        throw new DomainError(409, "SPEC_DRAFT_NOT_ACCEPTED", `version ${current.version} is an AI draft; send acceptDraft`);
      }
      if (!base.specV2 || typeof base.specV2 !== "object") throw specInvalid(base.version, "has no spec (예전 형식 판, 다시 가져와야 함)");
      return patchSpec(tx, req, id, b, base, base.specV2 as Record<string, unknown>);
    });
  });
}

/**
 * G5-2 DRAFT(ai): 초안을 받아들여도 되나. 안 되면 이유 글, 되면 null (순수 함수).
 *   accepted = 지금 받아들인 최신 판 번호(없으면 null), draftBase = 초안 표시의 baseVersion(초안이 기준으로 읽은 판).
 *   기준 판이 있으면 "기준 판 = 지금 받아들인 최신 판"이어야 한다 (AI 가 도는 동안 사람이 고친 판이 생겼으면 그 값을 덮지 않게).
 *   기준 판 번호가 없는 옛 초안은 예전 규칙(받아들인 판보다 옛 초안만 막음)
 */
export function draftStale(accepted: number | null, draftVersion: number, draftBase: unknown): string | null {
  if (typeof draftBase === "number") {
    if (accepted !== null && draftBase !== accepted) return `draft ${draftVersion} was made from version ${draftBase}, but the latest accepted version is ${accepted}`;
    return null;
  }
  if (accepted !== null && draftVersion < accepted) return `draft ${draftVersion} is older than accepted ${accepted}`;
  return null;
}

// ---- PA2v2: 명세 고치기 (계획 26 A2 v2 분기·함정 표) ----
type Req = { tenantId: string } & Parameters<typeof auditOk>[0];
const badV2 = (msg: string) => new BadRequest("SPEC_PATCH_INVALID", msg);

async function patchSpec(tx: Tx, req: Req, id: string, b: SpecPatchInput, base: Row, v2Base: Record<string, unknown>) {
  // BOUNDPULL: 경계 밖 자원 끌어오기를 먼저 (같은 요청의 changes·confirm 이 끌어온 자원을 가리킬 수 있게). 하나라도 못 하면 아무것도 안 바뀜
  let baseV2: Record<string, unknown> = v2Base;
  let included: string[] = [];
  if (b.include?.length) {
    const parsed = ImportResultV2.safeParse(v2Base);
    if (!parsed.success) throw new DomainError(409, "SPEC_INVALID", `spec version ${base.version} spec_v2 does not match ImportResultV2`);
    try { const inc = applyInclude(parsed.data, b.include); baseV2 = inc.result as unknown as Record<string, unknown>; included = inc.added; }
    catch (e) {
      if (!(e instanceof IncludeError)) throw e;
      // 없는 이름·이미 안에 있는 이름 = 요청이 틀림(400), 원본 값이 판에 없어 못 만듦 = 409
      if (e.failure === "unavailable") throw new DomainError(409, "SPEC_INCLUDE_UNAVAILABLE", e.message);
      throw badV2(e.message);
    }
  }
  const next = applySpecV2Patch({ spec: baseV2.spec, fieldMeta: (baseV2.fieldMeta ?? {}) as SpecMeta }, { changes: b.changes, confirm: b.confirm });
  const v2 = AppSpecV2.safeParse(next.spec);
  if (!v2.success)   // 값은 안 돌려줌 (비밀일 수 있음). 칸 이름과 이유만
    throw badV2(specIssueLines(v2.error.issues.slice(0, 10), next.spec).join("; "));
  const errs = checkV2(v2.data).errors;
  if (errs.length) throw badV2(errs.slice(0, 10).join("; "));
  // G3c-5 DRAFT(ai): checkV2 검토 줄을 고친 명세로 다시 맞춘다 (내용 키라 번호가 밀리지 않음). 사람이 고쳐 없어진 줄은 지우고,
  //   새로 생긴 줄(벤더 주소·사설 IP 를 넣음, external 링크를 지움, 끌어온 자원)은 검토 필요로, 같은 줄은 확인 표시 그대로
  const fieldMeta = syncCheckReviews(next.fieldMeta, checkV2Reviews(v2.data));
  const result = ImportResultV2.safeParse({ ...baseV2, spec: v2.data, fieldMeta });
  if (!result.success) throw badV2(result.error.issues.slice(0, 10).map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));
  const saved = await saveSpecRevision(tx, { tenantId: req.tenantId, migrationId: id, specV2: result.data });
  await writeAudit(tx, req.tenantId, auditOk(req, "spec.edited", id, {
    baseVersion: b.baseVersion, version: saved.version, changed: next.changed, confirmed: next.confirmed,
    ...(included.length ? { included } : {}),   // BOUNDPULL: 끌어온 자원 이름만 (값 없음)
    ...(b.acceptDraft !== undefined ? { acceptedDraft: b.acceptDraft } : {}) }));
  await notifyMigration(tx, { t: req.tenantId, id, s: "spec_review" });
  return { status: 200, body: toSpecView(id, { version: saved.version, createdAt: saved.createdAt, draft: false, specV2: result.data }, await endsOf(tx, id)) };
}
