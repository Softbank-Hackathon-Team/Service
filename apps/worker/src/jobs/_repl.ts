import { replicationFromEnv, replicationFromRecords, ReplConfigError, type ManagedSecrets, type Migration } from "@svc/replication";
import { iacMockEnabled, specV2ForPlan } from "@svc/adapters";
import type { ReplicationEndpoint } from "@svc/contracts";
import { latestAcceptedSpecV2, replicationEndpointsFor, withTenant, type Tx } from "@svc/core";
import { fetchManagedSecrets, managedSecretArns } from "../relay/source-secret.js";
import { readMigration } from "./_step.js";

// PF FM-ORC-09 ①: 복제 끝점은 워커 전역 REPL_* 하나라, 명세에 postgres 가 없는 앱(DB 없는 2티어)도 진짜 복제를 시도했다
//   → {tf:db_address} 를 못 채운 채 접속 실패 → paused(SYNC_FAILED). 받아들인 명세에 postgres 부품이 하나도 없으면 복제 없음(null = STUB 길).
//   명세를 못 읽으면(옛 판·시험) 예전처럼 env 를 따른다. 명세에 postgres 가 있는데 끝점이 없으면 진짜 판은 REPL_ENDPOINT_MISSING (pickReplication).
// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
//   replication_endpoints(db 0050)에 이 이전의 source·target 두 줄이 있으면 그 줄로, 둘 다 없으면 예전 env(REPL_*), 한 줄만이면 오류.
//   복제 객체를 얻는 길은 replicationFor 하나 (sync·cutover·rollback·cleanup·repl-cleanup·리퍼)
export async function specHasPostgres(tenantId: string, migrationId: string): Promise<boolean | null> {
  return withTenant(tenantId, (tx) => specHasPostgresTx(tx, migrationId));
}
async function specHasPostgresTx(tx: Tx, migrationId: string): Promise<boolean | null> {
  const row = await latestAcceptedSpecV2(tx, migrationId);
  const spec = row ? specV2ForPlan(row) : null;
  return spec ? spec.components.some((c) => c.kind === "postgres") : null;
}

/** 읽은 값으로 고르기 (순수, 시험용). 명세에 postgres 없음 → null / 줄 두 개 → 줄 / 줄 없음 → env / 한 줄 → ReplConfigError
 *  줄도 env 도 없음: 진짜 판(MOCK_IAC≠1)에 명세 postgres 가 있으면 REPL_ENDPOINT_MISSING (precheck RV-28 required 와 같은 기준).
 *  흉내 판·명세를 못 읽음(옛 판)이면 null = STUB 길. 예전엔 진짜 판에서도 null 이라 sync·cutover·cleanup·rollback 이 가짜 성공으로 넘어갔다 */
export function pickReplication(migrationId: string, hasPostgres: boolean | null, records: readonly ReplicationEndpoint[],
  env: NodeJS.ProcessEnv = process.env, managed?: ManagedSecrets): Migration | null {
  if (hasPostgres === false) return null;
  const repl = replicationFromRecords(migrationId, records, env, managed) ?? replicationFromEnv(migrationId, env);
  if (!repl && hasPostgres === true && !iacMockEnabled(env))
    throw new ReplConfigError("REPL_ENDPOINT_MISSING: 명세에 postgres 가 있는데 복제 끝점이 없다 (replication_endpoints 줄 없음, 워커 REPL_SOURCE_URL·REPL_TARGET_URL 없음). "
      + "AWS 출발 중계기 이전이면 apply 의 중계기 단계 감사(relay)를, 아니면 npm run repl:endpoint -- set 으로 두 쪽을 넣고 다시", "REPL_ENDPOINT_MISSING");
  return repl;
}

/** 이전 하나의 복제 객체. 회사 벽(withTenant) 안에서 명세·끝점 줄을 읽는다.
 *  tx 를 주면 그 트랜잭션 안에서 읽는다 (리퍼: 이전 행 잠금을 쥔 채 연결을 하나 더 빌리지 않게). 읽기 실패가 그 트랜잭션을 깨지 않게 SAVEPOINT 로 감싼다 */
// 출발 줄이 RDS 관리 비밀(aws-sm:)을 가리키면 여기서 출발 실행 역할을 빌려 읽는다 (relay/source-secret.ts). 값은 이 호출의 메모리에만 있다.
//   부를 때마다 새로 읽는다 (관리 비밀은 기본 7일마다 바뀐다). 못 읽으면 REPL_SECRET_UNRESOLVED (env 참조를 못 풀 때와 같은 길)
export async function replicationFor(tenantId: string, migrationId: string, tx?: Tx): Promise<Migration | null> {
  const read = async (t: Tx) => ({ hasPg: await specHasPostgresTx(t, migrationId), records: await replicationEndpointsFor(t, migrationId),
    mig: await readMigration(t, migrationId) });
  const got = tx ? await inSavepoint(tx, read) : await withTenant(tenantId, read);
  // 회사 벽이 이미 막지만 한 번 더: 다른 회사 줄은 쓰지 않는다
  const records = got.records.filter((r) => r.tenantId === tenantId);
  const arns = got.hasPg === false ? [] : managedSecretArns(records);
  let managed: ManagedSecrets | undefined;
  if (arns.length) {
    if (!got.mig) throw new ReplConfigError(`이전 ${migrationId} 을 못 읽어 출발 관리 비밀을 읽을 수 없다`, "REPL_SECRET_UNRESOLVED");
    try { managed = await fetchManagedSecrets({ tenantId, migrationId }, got.mig, arns); }
    catch (e) { throw new ReplConfigError(`source 끝점: ${(e as Error).message}`, "REPL_SECRET_UNRESOLVED"); }
  }
  return pickReplication(migrationId, got.hasPg, records, process.env, managed);
}

async function inSavepoint<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await tx.query("SAVEPOINT svc_repl_resolve");
  try {
    const out = await fn(tx);
    await tx.query("RELEASE SAVEPOINT svc_repl_resolve");
    return out;
  } catch (e) {
    await tx.query("ROLLBACK TO SAVEPOINT svc_repl_resolve").catch(() => undefined);
    throw e;
  }
}
