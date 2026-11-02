import type { Tx } from "./db.js";
import { DomainError } from "./errors.js";

// 이전 한 건의 "받아들인 최신 명세" 찾기 (Z75-03). 예전엔 같은 SQL 이 워커 5곳·API 1곳에 따로 적혀 있었다
// AI 초안 판(field_meta 에 _draft 표시)은 사람이 받아들이기 전까지 계획·적용·배포·전환·비용 어디에도 쓰지 않는다 (Z19 H1)
// 값은 @svc/agent 의 DRAFT_MARKER_KEY 와 같아야 한다 (apps/agent-worker/test/spec-draft-key.test.ts 가 검사)
export const SPEC_DRAFT_KEY = "_draft";

/** 받아들인(초안이 아닌) 최신 판의 spec 원본. 없으면 null. 모양 검사(AppSpec.parse)는 부르는 쪽이 한다 */
export async function latestAcceptedSpec(tx: Tx, migrationId: string): Promise<unknown | null> {
  const r = await tx.query(
    `SELECT spec FROM spec_versions WHERE migration_id = $1 AND NOT (field_meta ? $2)
      ORDER BY version DESC LIMIT 1`, [migrationId, SPEC_DRAFT_KEY]);
  return r.rows[0]?.spec ?? null;
}

// ---- PA2 (계획 26 · A2 v1): 사람이 명세를 고친 새 판 ----

type MetaEntry = { source: string; confidence: number; needs_review: boolean; rationale?: string };
export type SpecMeta = Record<string, MetaEntry | Record<string, unknown>>;

export interface SpecPatchOps {
  changes?: Array<{ path: string; value?: unknown }>;
  confirm?: string[];
}

function setAt(o: Record<string, unknown>, path: string, v: unknown) {
  const ks = path.split(".");
  let cur = o;
  for (const k of ks.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[ks[ks.length - 1]!] = v;
}

/**
 * 기준 판(spec·field_meta)에 사람 수정을 얹은 새 spec·field_meta (순수 함수, 입력은 안 바꿈).
 *  - changes: 값 바꿈 → {source:"human", confidence:1, needs_review:false}
 *  - confirm: 값 그대로 "봤다" → needs_review:false (출처·신뢰도 그대로). 표시가 없는 칸은 그냥 넘어감
 *  - _draft 표시는 뺀다 (사람이 고친 판 = 받아들인 판)
 * 모양 검사(AppSpec)는 부르는 쪽이 한다. 칸 이름 검사도 부르는 쪽(SpecPatchInput)이 한다
 */
export function applySpecPatch(base: { spec: unknown; fieldMeta: SpecMeta | null }, ops: SpecPatchOps):
  { spec: Record<string, unknown>; fieldMeta: SpecMeta; changed: string[]; confirmed: string[] } {
  const spec = structuredClone((base.spec ?? {}) as Record<string, unknown>);
  const fieldMeta = structuredClone(base.fieldMeta ?? {}) as SpecMeta;
  delete fieldMeta[SPEC_DRAFT_KEY];
  const changed: string[] = [], confirmed: string[] = [];
  for (const c of ops.changes ?? []) {
    setAt(spec, c.path, structuredClone(c.value));
    fieldMeta[c.path] = { source: "human", confidence: 1, needs_review: false };
    if (!changed.includes(c.path)) changed.push(c.path);
  }
  for (const p of ops.confirm ?? []) {
    const m = fieldMeta[p];
    if (m && typeof m === "object") fieldMeta[p] = { ...m, needs_review: false };
    // DRAFT(ai): 표시 없는 칸을 confirm 해도 오류로 안 본다 (두 번 눌러도 같은 결과). 감사엔 실제로 바꾼 칸만
    if (m && typeof m === "object" && !confirmed.includes(p)) confirmed.push(p);
  }
  return { spec, fieldMeta, changed, confirmed };
}

/**
 * 명세 새 판 저장. version = 그 이전의 지금 최대 + 1. 이전 행 FOR UPDATE 는 부르는 쪽이 먼저 잡는다(잠금 순서: 이전 행 → 감사).
 * 이전 행 잠금을 안 거치는 쓰기(에이전트 초안 등)와 부딪히면 UNIQUE(migration_id, version) → 409 SPEC_VERSION_CONFLICT
 */
export async function saveSpecRevision(tx: Tx, r: { tenantId: string; migrationId: string; spec: unknown; fieldMeta: unknown }):
  Promise<{ version: number; createdAt: string }> {
  try {
    const q = await tx.query(
      `INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta)
       SELECT $1::uuid, $2::uuid, COALESCE(MAX(version), 0) + 1, $3::jsonb, $4::jsonb FROM spec_versions WHERE migration_id = $2::uuid
       RETURNING version, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`,
      [r.tenantId, r.migrationId, JSON.stringify(r.spec), JSON.stringify(r.fieldMeta)]);
    return q.rows[0] as { version: number; createdAt: string };
  } catch (e) {
    // 트랜잭션은 어차피 통째 취소된다 (오류 → withTenant ROLLBACK)
    if ((e as { code?: string }).code === "23505")
      throw new DomainError(409, "SPEC_VERSION_CONFLICT", `spec of migration ${r.migrationId} changed, reload`);
    throw e;
  }
}
