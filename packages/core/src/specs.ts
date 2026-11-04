import type { Tx } from "./db.js";
import { DomainError } from "./errors.js";

// 이전 한 건의 "받아들인 최신 명세" 찾기 (Z75-03). 예전엔 같은 SQL 이 워커 5곳·API 1곳에 따로 적혀 있었다
// AI 초안 판(field_meta 에 _draft 표시)은 사람이 받아들이기 전까지 계획·적용·배포·전환·비용 어디에도 쓰지 않는다 (Z19 H1)
// 값은 @svc/agent 의 DRAFT_MARKER_KEY 와 같아야 한다 (apps/agent-worker/test/spec-draft-key.test.ts 가 검사)
export const SPEC_DRAFT_KEY = "_draft";

// DRAFT(ai): 명세는 spec_v2 칸 하나에 둔다 (ImportResult: {spec, fieldMeta, unmapped, ids, …}). 예전 v1 칸 spec·field_meta 는 지우지 않고 남기되
//   spec 은 늘 {} 로 쓰고, field_meta 는 AI 초안 표시(_draft) 자리로만 쓴다 (빈 판 = {}). 칸 삭제는 결선 뒤 마이그레이션으로
/** 받아들인(초안이 아닌) 최신 판의 명세 원본(spec_v2->'spec'). 판이 없으면 null. 모양 검사는 부르는 쪽(resolveSpecV2·AppSpecV2.parse) */
export interface AcceptedSpecV2Row { version: number; specV2: unknown | null }
export async function latestAcceptedSpecV2(tx: Tx, migrationId: string): Promise<AcceptedSpecV2Row | null> {
  const r = await tx.query(
    `SELECT s.version, to_jsonb(s)->'spec_v2'->'spec' AS "specV2"
       FROM spec_versions s WHERE s.migration_id = $1 AND NOT (s.field_meta ? $2)
      ORDER BY s.version DESC LIMIT 1`, [migrationId, SPEC_DRAFT_KEY]);
  const row = r.rows[0] as { version: number; specV2: unknown } | undefined;
  if (!row) return null;
  return { version: Number(row.version), specV2: row.specV2 ?? null };
}

/** 받아들인 최신 판의 앱 이름 (전환·앱 연결이 쓴다). 없거나 모양이 틀리면 null */
export async function latestAcceptedAppName(tx: Tx, migrationId: string): Promise<string | null> {
  const row = await latestAcceptedSpecV2(tx, migrationId);
  const name = (row?.specV2 as { app?: { name?: unknown } } | null)?.app?.name;
  return typeof name === "string" && name ? name : null;
}

// ---- PA2 (계획 26 · A2): 사람이 명세를 고친 새 판 ----

type MetaEntry = { source: string; confidence: number; needs_review: boolean; rationale?: string };
export type SpecMeta = Record<string, MetaEntry | Record<string, unknown>>;

export interface SpecPatchOps {
  changes?: Array<{ path: string; value?: unknown }>;
  confirm?: string[];
}

/**
 * 명세 새 판 저장. version = 그 이전의 지금 최대 + 1. 이전 행 FOR UPDATE 는 부르는 쪽이 먼저 잡는다(잠금 순서: 이전 행 → 감사).
 * 이전 행 잠금을 안 거치는 쓰기(에이전트 초안 등)와 부딪히면 UNIQUE(migration_id, version) → 409 SPEC_VERSION_CONFLICT
 */
export async function saveSpecRevision(tx: Tx, r: { tenantId: string; migrationId: string; specV2: unknown; draftMarker?: Record<string, unknown> }):
  Promise<{ version: number; createdAt: string }> {
  try {
    // spec(옛 칸) = {}, field_meta = 초안 표시 자리({} 또는 {_draft: …}), spec_v2 = 명세 한 벌
    const q = await tx.query(
      `INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
       SELECT $1::uuid, $2::uuid, COALESCE(MAX(version), 0) + 1, '{}'::jsonb, $3::jsonb, $4::jsonb FROM spec_versions WHERE migration_id = $2::uuid
       RETURNING version, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`,
      [r.tenantId, r.migrationId, JSON.stringify(r.draftMarker ? { [SPEC_DRAFT_KEY]: r.draftMarker } : {}), JSON.stringify(r.specV2)]);
    return q.rows[0] as { version: number; createdAt: string };
  } catch (e) {
    // 트랜잭션은 어차피 통째 취소된다 (오류 → withTenant ROLLBACK)
    if ((e as { code?: string }).code === "23505")
      throw new DomainError(409, "SPEC_VERSION_CONFLICT", `spec of migration ${r.migrationId} changed, reload`);
    throw e;
  }
}

// ---- PA2v2 (계획 26 · A2): 명세 고치기 ----

const V2_COMPONENT_PATH = /^components\.([a-z][a-z0-9-]{0,39})\.([A-Za-z][A-Za-z0-9]{0,39})$/;

/**
 * spec_v2 {spec, fieldMeta, …} 에 사람 수정을 얹은 새 spec·fieldMeta (순수 함수, 입력은 안 바꿈). _draft 표시는 field_meta 칸 몫이라 여기엔 없다.
 *  - changes: "components.<id>.<칸>" → 그 리소스 props.<칸> 을 바꿈. "app"·"links"·"entry"·"posture"·"security"·"secrets" → 통째로 바꿈 (security 는 null 이면 지움)
 *    그 키와 그 아래 키(예: components.api.env.DB_URL)의 표시 → {source:"human", confidence:1, needs_review:false}
 *  - confirm: fieldMeta 키 그대로 needs_review:false. 표시 없는 키는 넘어감
 * 없는 리소스 id → 400 SPEC_PATCH_INVALID. 모양 검사(AppSpecV2·checkV2)는 부르는 쪽
 */
export function applySpecV2Patch(base: { spec: unknown; fieldMeta: SpecMeta | null }, ops: SpecPatchOps):
  { spec: Record<string, unknown>; fieldMeta: SpecMeta; changed: string[]; confirmed: string[] } {
  const spec = structuredClone((base.spec ?? {}) as Record<string, unknown>);
  const fieldMeta = structuredClone(base.fieldMeta ?? {}) as SpecMeta;
  const changed: string[] = [], confirmed: string[] = [];
  for (const c of ops.changes ?? []) {
    const m = V2_COMPONENT_PATH.exec(c.path);
    if (m) {
      const comp = (Array.isArray(spec.components) ? spec.components : [])
        .find((x) => !!x && typeof x === "object" && (x as { id?: unknown }).id === m[1]) as { props?: Record<string, unknown> } | undefined;
      if (!comp) throw new DomainError(400, "SPEC_PATCH_INVALID", `${c.path}: no component ${m[1]}`);
      // RUNTIMEMAP DRAFT(ai): origin(출발 원래 실행 모양)은 가져오기가 정한 사실이라 사람이 못 고친다. 고칠 수 있으면 runtime 을 바꾼 뒤 origin 도 맞춰
      //   checkV2 의 runtime_change 승인 줄을 없앨 수 있다 (N8: 도착 실행 방식 = 출발과 같은 종류, 바꾸려면 runtime 을 바꾸고 승인)
      if (m[2] === "origin") throw new DomainError(400, "SPEC_PATCH_INVALID", `${c.path}: origin 은 가져오기가 정한 값이라 고칠 수 없음 (도착 실행 방식을 바꾸려면 runtime 을 고침)`);
      comp.props = { ...(comp.props ?? {}), [m[2]!]: structuredClone(c.value) };
    } else if (c.path === "app.name") {
      // G3b-5: 앱 이름. 모양(소문자 id)은 부르는 쪽 AppSpecV2 검사가 막는다
      spec.app = { ...((spec.app ?? {}) as Record<string, unknown>), name: structuredClone(c.value) };
    } else if (c.path === "links" || c.path === "entry" || c.path === "posture" || c.path === "security" || c.path === "secrets") {
      // T1·SC-1: secrets 통째 바꾸기 (사람이 binary 를 켜거나 짝(pairedWith)을 고치는 길). 모양·참조 검사는 부르는 쪽(AppSpecV2·checkV2)
      // E2EDATA2 DRAFT(ai): posture 통째 바꾸기. 출발 방화벽을 못 읽은 데이터 자원(ingress "unknown")은 precheck 가 사람이 정하라며 막는데,
      //   posture 를 고칠 길이 없어 영원히 spec_review 에 갇혔다. 모양은 AppSpecV2 검사(부르는 쪽)가 막는다
      // security: 앱 보안 요구사항(데이터 등급·허용 국가·키 소유). 가져오기는 채우지 않으므로 사람이 넣는 길이 이것뿐이다.
      //   DRAFT(ai): null 이면 칸을 지운다 (요구사항 없음 = 판정이 P-REQ-0 으로 선언을 요청)
      if (c.path === "security" && c.value === null) delete spec.security;
      else spec[c.path] = structuredClone(c.value);
    } else {
      throw new DomainError(400, "SPEC_PATCH_INVALID", `${c.path}: not a spec path`);
    }
    fieldMeta[c.path] = { source: "human", confidence: 1, needs_review: false };
    for (const k of Object.keys(fieldMeta))
      if (k.startsWith(`${c.path}.`)) fieldMeta[k] = { source: "human", confidence: 1, needs_review: false };
    if (!changed.includes(c.path)) changed.push(c.path);
  }
  for (const p of ops.confirm ?? []) {
    const m = fieldMeta[p];
    if (m && typeof m === "object") fieldMeta[p] = { ...m, needs_review: false };
    if (m && typeof m === "object" && !confirmed.includes(p)) confirmed.push(p);
  }
  return { spec, fieldMeta, changed, confirmed };
}
