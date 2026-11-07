// 사전 점검: 도착 환경에 같은 앱을 옮겨 놓은 끝난 이전이 있나 (DRAFT(ai), 2026-11-07).
//   배포 묶음 위치와 도착 네임스페이스는 (회사, 앱 이름, 도착 환경)으로만 정해진다 (gitops/bundle.ts bundleRefFor·appNamespace).
//   그래서 같은 회사가 같은 앱 이름으로 같은 도착 환경에 다시 옮기면, 앞서 끝난 이전이 올려 둔 앱·DB 를 덮어쓰고
//   이번 이전을 롤백하면 그것까지 지운다 (2026-11-07 실플랫폼: GCP→온프레 1adfeb6c 가 AWS→온프레 f6c08ef2 의 결과를 덮고 롤백 때 지움).
//   환경 잠금(env_locks)은 진행 중인 이전끼리만 막고, 끝난 이전의 결과는 보지 않는다.
// 판정: 이 앱이 이 환경에 "들어온" 마지막 완료 이전이, 이 환경에서 "나간" 마지막 완료 이전보다 뒤면 지금 그 앱이 거기 있다.
//   (앱을 다시 출발로 삼아 다른 곳으로 옮겨 끝냈으면 비었다고 본다)
// DRAFT(ai): 수준은 warn → 계획 승인 때 사람이 확인하는 줄. 손으로 지운 경우·의도한 재배포를 막지 않으려고 block 은 안 했다
//   TODO(human): block 으로 올릴지, 실제 도착 상태(Agent 보고의 네임스페이스·워크로드)로 다시 확인할지
import { PrecheckItem } from "@svc/contracts";
import { SPEC_DRAFT_KEY, type Tx } from "@svc/core";

export interface CompletedMove { id: string; sourceEnvId: string; targetEnvId: string; completedAt: string }

/** 순수 함수: moves = 같은 앱 이름의 다른 완료 이전 중 이 환경이 출발이나 도착인 것 (순서 무관) */
export function targetOccupancyItems(i: { appName: string; targetEnvId: string; targetName: string; moves: CompletedMove[] }): PrecheckItem[] {
  const last = [...i.moves].filter((m) => m.sourceEnvId === i.targetEnvId || m.targetEnvId === i.targetEnvId)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
  if (!last || last.targetEnvId !== i.targetEnvId) return [];
  return [PrecheckItem.parse({
    id: "PC-TARGET-APP-OCCUPIED", level: "warn",
    message: `도착 ${i.targetName} 에 같은 앱 ${i.appName} 을 옮겨 놓은 끝난 이전 ${last.id.slice(0, 8)} 이 있다. 이대로 배포하면 그 앱(네임스페이스 app-${i.appName})을 덮어쓰고, 이 이전을 롤백하면 그것까지 지운다`,
    fix: "그 앱을 지켜야 하면 취소하고 다른 앱 이름으로 가져오거나 다른 도착 환경을 고른다. 이미 지웠거나 덮어써도 되면 확인하고 진행",
  })];
}

/** 같은 회사(RLS)·같은 앱 이름(받아들인 최신 명세)의 완료 이전 중 이 환경이 들어간 것. 최근 것 몇 개만 */
export async function completedMovesFor(tx: Tx, migrationId: string, appName: string, envId: string): Promise<CompletedMove[]> {
  const r = await tx.query(
    `SELECT m.id::text AS id, m.source_env_id::text AS "sourceEnvId", m.target_env_id::text AS "targetEnvId", to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "completedAt"
       FROM migrations m
       JOIN LATERAL (SELECT to_jsonb(s)->'spec_v2'->'spec'->'app'->>'name' AS app FROM spec_versions s
                      WHERE s.migration_id = m.id AND NOT (s.field_meta ? $4) ORDER BY s.version DESC LIMIT 1) v ON true
      WHERE m.id <> $1 AND m.status = 'completed' AND v.app = $2 AND $3::uuid IN (m.source_env_id, m.target_env_id)
      ORDER BY m.updated_at DESC LIMIT 10`, [migrationId, appName, envId, SPEC_DRAFT_KEY]);
  return r.rows as CompletedMove[];
}
