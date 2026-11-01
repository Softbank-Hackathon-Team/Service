import { JOB_SCHEMAS, type MigrationStatus, type QueueName } from "@svc/contracts";
import type { Tx } from "./db.js";
import { writeAudit } from "./audit.js";

// 큐 작업 멱등성 3 (받는 쪽): pg-boss는 "최소 한 번" 준다. 같은 작업이 두 번 와도 결과가 같으려면
// 처리기 첫머리에서 (1) 모양 검사 (2) DB에서 이전을 다시 읽어 기대 상태인지 본다.
// 기대 상태가 아니면 아무것도 안 하고 job.rejected 감사 한 줄만 남긴다.

// 1단계: 모양 검사 (withTenant 밖, 회사 번호를 얻으려고)
export function parseJob<Q extends keyof typeof JOB_SCHEMAS>(queue: Q, raw: unknown) {
  return JOB_SCHEMAS[queue].parse(raw) as ReturnType<(typeof JOB_SCHEMAS)[Q]["parse"]>;
}

// 2단계: withTenant 안에서 다시 읽기. 행을 잠그지 않는다 (상태 변경은 advance가 잠그고 다시 본다)
export async function recheckMigration(
  tx: Tx,
  job: { tenantId: string; requestId: string; migrationId: string },
  queue: QueueName,
  expected: MigrationStatus | readonly MigrationStatus[],
): Promise<{ status: MigrationStatus; version: number } | null> {
  const want: readonly MigrationStatus[] = typeof expected === "string" ? [expected] : expected;
  const r = await tx.query("SELECT status, version FROM migrations WHERE id = $1", [job.migrationId]);
  const row = r.rows[0] as { status: MigrationStatus; version: number } | undefined;
  if (row && want.includes(row.status)) return row;
  // 회사 벽 안에서 안 보이면(없거나 남의 회사) 감사도 쓰지 않는다: 남의 회사 번호로 기록이 생기면 안 된다
  if (row) await writeAudit(tx, job.tenantId, {
    actor: "worker", action: "job.rejected", target: job.migrationId, result: "denied",
    detail: { queue, requestId: job.requestId, expected: want, actual: row.status },
  });
  return null;
}
