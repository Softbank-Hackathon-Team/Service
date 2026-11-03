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

// TA3 (설계 27번 3.5): 같은 줄(받아들인 최신 판)의 v1 spec + spec_v2->'spec' + "앞 판에 spec_v2 가 있었나".
//   spec_v2 칸(0023)은 to_jsonb 로 읽어 칸이 없는 DB 에서도 안 깨진다. 판이 없으면 null
export interface AcceptedSpecV2Row { version: number; spec: unknown; specV2: unknown | null; hadV2Before: boolean }
export async function latestAcceptedSpecV2(tx: Tx, migrationId: string): Promise<AcceptedSpecV2Row | null> {
  const r = await tx.query(
    `SELECT s.version, s.spec, to_jsonb(s)->'spec_v2'->'spec' AS "specV2",
            EXISTS (SELECT 1 FROM spec_versions p WHERE p.migration_id = s.migration_id AND p.version < s.version
                     AND NOT (p.field_meta ? $2) AND jsonb_typeof(to_jsonb(p)->'spec_v2') = 'object') AS "hadV2Before"
       FROM spec_versions s WHERE s.migration_id = $1 AND NOT (s.field_meta ? $2)
      ORDER BY s.version DESC LIMIT 1`, [migrationId, SPEC_DRAFT_KEY]);
  const row = r.rows[0] as { version: number; spec: unknown; specV2: unknown; hadV2Before: boolean } | undefined;
  if (!row) return null;
  return { version: Number(row.version), spec: row.spec, specV2: row.specV2 ?? null, hadV2Before: row.hadV2Before === true };
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
    // VPA3 버그 수정: 칸 전체(예: service.env)를 사람이 다시 썼으면 그 아래 칸 표시(service.env.<이름>)도 사람이 본 것으로.
    //   안 그러면 지운 환경변수의 검토 표시가 남아 T04 가 영원히 막힌다. DRAFT(ai): 아래 칸 표시는 지우지 않고 human 으로 덮는다
    for (const k of Object.keys(fieldMeta))
      if (k.startsWith(`${c.path}.`)) fieldMeta[k] = { source: "human", confidence: 1, needs_review: false };
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
export async function saveSpecRevision(tx: Tx, r: { tenantId: string; migrationId: string; spec: unknown; fieldMeta: unknown; specV2?: unknown }):
  Promise<{ version: number; createdAt: string }> {
  try {
    // PA2v2: specV2 가 오면 spec·field_meta·spec_v2 를 한 줄에 같이 (0023). 안 오면 아래 v1 SQL 그대로
    const q = r.specV2 !== undefined ? await tx.query(
      `INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
       SELECT $1::uuid, $2::uuid, COALESCE(MAX(version), 0) + 1, $3::jsonb, $4::jsonb, $5::jsonb FROM spec_versions WHERE migration_id = $2::uuid
       RETURNING version, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`,
      [r.tenantId, r.migrationId, JSON.stringify(r.spec), JSON.stringify(r.fieldMeta), JSON.stringify(r.specV2)]) : await tx.query(
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

// ---- PA2v2 (계획 26 · A2 v2 분기): 기준 판에 spec_v2 가 있을 때 v2 명세를 고친 새 v2 ----

const V2_COMPONENT_PATH = /^components\.([a-z][a-z0-9-]{0,39})\.([A-Za-z][A-Za-z0-9]{0,39})$/;

/**
 * spec_v2 {spec, fieldMeta, …} 에 사람 수정을 얹은 새 v2 spec·fieldMeta (순수 함수, 입력은 안 바꿈). 규칙은 applySpecPatch 와 같다.
 *  - changes: "components.<id>.<칸>" → 그 리소스 props.<칸> 을 바꿈. "links"·"entry"·"posture"·"security" → 통째로 바꿈 (security 는 null 이면 지움)
 *    그 키와 그 아래 키(예: components.api.env.DB_URL)의 표시 → {source:"human", confidence:1, needs_review:false}
 *  - confirm: fieldMeta 키 그대로 needs_review:false. 표시 없는 키는 넘어감
 * 없는 리소스 id → 400 SPEC_PATCH_INVALID. 모양 검사(AppSpecV2·checkV2)와 v1 다시 뽑기(rebuildFromV2)는 부르는 쪽
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
    } else if (c.path === "links" || c.path === "entry" || c.path === "posture" || c.path === "security") {
      // E2EDATA2 DRAFT(ai): posture 통째 바꾸기. 출발 방화벽을 못 읽은 데이터 자원(ingress "unknown")은 precheck 가 사람이 정하라며 막는데,
      //   posture 를 고칠 길이 없어 영원히 spec_review 에 갇혔다. 모양은 AppSpecV2 검사(부르는 쪽)가 막는다
      // security: 앱 보안 요구사항(데이터 등급·허용 국가·키 소유). 가져오기는 채우지 않으므로 사람이 넣는 길이 이것뿐이다.
      //   null 이면 칸을 지운다 (요구사항 없음 = 판정이 P-REQ-0 으로 선언을 요청)
      if (c.path === "security" && c.value === null) delete spec.security;
      else spec[c.path] = structuredClone(c.value);
    } else {
      throw new DomainError(400, "SPEC_PATCH_INVALID", `${c.path}: not a v2 path`);
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
