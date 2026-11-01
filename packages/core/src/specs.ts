import type { Tx } from "./db.js";

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
