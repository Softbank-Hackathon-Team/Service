import { replicationFromEnv } from "@svc/replication";
import { specV2ForPlan } from "@svc/adapters";
import { latestAcceptedSpecV2, withTenant } from "@svc/core";

// PF FM-ORC-09 ①: 복제 끝점은 워커 전역 REPL_* 하나라, 명세에 postgres 가 없는 앱(DB 없는 2티어)도 진짜 복제를 시도했다
//   → {tf:db_address} 를 못 채운 채 접속 실패 → paused(SYNC_FAILED). 받아들인 명세에 postgres 부품이 하나도 없으면 복제 없음(null = STUB 길).
//   명세를 못 읽으면(옛 판·시험) 예전처럼 env 를 따른다.
// TODO(human): ② 끝점을 이전(명세·환경)마다 갖게 할지. 지금은 워커 하나 = 출발 DB 하나라 회사가 다른 두 이전이 같은 출발 DB 를 원본으로 쓸 수 있다
export async function specHasPostgres(tenantId: string, migrationId: string): Promise<boolean | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await latestAcceptedSpecV2(tx, migrationId);
    const spec = row ? specV2ForPlan(row) : null;
    return spec ? spec.components.some((c) => c.kind === "postgres") : null;
  });
}
export async function replicationFor(tenantId: string, migrationId: string) {
  return (await specHasPostgres(tenantId, migrationId)) === false ? null : replicationFromEnv(migrationId);
}
