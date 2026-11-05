import { MigrationJob, TERMINAL, type MigrationStatus } from "@svc/contracts";
import { withTenant, writeAudit } from "@svc/core";
import { replicationFor } from "./_repl.js";
import { targetBundle } from "../app-link.js";
import { commitReplicationCleanup } from "../gitops/index.js";
import { cleanupAfterRollback, type ReplCleaner, type RollbackCleanup } from "./rollback-cleanup.js";

// F8-5: 끝난 이전에 남은 복제 객체(구독·슬롯·발행·마커)를 사람이 다시 걷는 작업. 상태는 안 바꾼다(advance 없음).
// 롤백 작업의 걷기가 실패하면 rolled_back + 감사 rollback.cleanup_incomplete 만 남고 다시 걷을 길이 없었다.
// 남은 출발 DB 슬롯은 WAL 을 계속 붙잡는다. teardown 은 있는 것만 지워서 여러 번 불러도 안전하다.
// DRAFT(ai): 끝 상태(rolled_back·cancelled·completed)에서만 걷는다. failed 는 뒤에 rolling_back·prechecking 으로
//   다시 움직일 수 있어, 그 작업과 걷기가 겹치지 않게 뺐다. TODO(human): 주기 훑기로 자동 걷기까지 할지
export const REPL_CLEANUP_FROM: readonly MigrationStatus[] = TERMINAL;

export type ReplCleanupOutcome = "done" | "incomplete" | "skipped" | "stub";

export async function handleReplCleanup(raw: unknown, cleaner?: ReplCleaner | null): Promise<ReplCleanupOutcome> {
  const j = MigrationJob.parse(raw);
  // 작업 내용은 믿지 않는다: 상태는 DB 에서 다시 읽는다
  const status = await withTenant(j.tenantId, async (tx) =>
    (await tx.query<{ status: MigrationStatus }>(`SELECT status FROM migrations WHERE id=$1`, [j.migrationId])).rows[0]?.status);
  if (!status || !REPL_CLEANUP_FROM.includes(status)) {
    await audit(j, "skipped", { status: status ?? null, reason: "not a finished migration" });
    return "skipped";
  }
  const repl = cleaner === undefined ? await replicationFor(j.tenantId, j.migrationId) : cleaner;
  if (!repl) {
    // STUB: 복제 설정(REPL_*)이 없는 개발 환경. 걷을 대상이 없다
    await audit(j, "ok", { status, stub: true, removed: [], leftovers: [] });
    return "stub";
  }
  const c: RollbackCleanup = await cleanupAfterRollback(repl);
  // 온프레 CNPG 이전: 다 걷었으면 gitops 에서 이전 역할(ensure absent)·터널도 걷는다 (롤백·정리 때 찌꺼기로 남겨 둔 터널)
  const gitopsReplication = c.ok ? await commitReplicationCleanup(await withTenant(j.tenantId, async (tx) => {
    const m = (await tx.query<{ id: string; targetEnvId: string }>(`SELECT id, target_env_id AS "targetEnvId" FROM migrations WHERE id=$1`, [j.migrationId])).rows[0];
    return m ? targetBundle(tx, j.tenantId, m) : null;
  })) : { skipped: "replication_leftovers" };
  await audit(j, c.ok ? "ok" : "error", { status, removed: c.removed, leftovers: c.leftovers, gitopsReplication,
    ...(c.warning ? { warning: c.warning } : {}) });
  return c.ok ? "done" : "incomplete";
}

/** PF-E25 (RV-12): 큐 처리기. 예전엔 걷기가 덜 끝나도(incomplete) 정상 끝 → 큐의 재시도(2번·30초)가 안 돌았다.
 *  덜 끝났으면 감사(error)를 남긴 뒤 던져서 큐가 다시 부르게 한다 (teardown 은 여러 번 불러도 안전). 재시도를 다 쓰면 작업이 failed 로 남는다 */
export async function replCleanupJob(raw: unknown, cleaner?: ReplCleaner | null): Promise<ReplCleanupOutcome> {
  const r = await handleReplCleanup(raw, cleaner);
  if (r === "incomplete") throw new Error("replication cleanup incomplete (leftovers remain; queue will retry)");
  return r;
}

async function audit(j: MigrationJob, result: "ok" | "error" | "skipped", detail: Record<string, unknown>) {
  await withTenant(j.tenantId, (tx) => writeAudit(tx, j.tenantId, {
    actor: "worker", action: "replication.cleanup", target: j.migrationId,
    result: result === "skipped" ? "ok" : result, detail: { requestId: j.requestId, ...(result === "skipped" ? { skipped: true } : {}), ...detail } }));
}
