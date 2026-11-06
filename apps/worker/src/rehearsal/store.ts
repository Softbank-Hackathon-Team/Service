import { QUEUES, RehearsalResult, type RehearsalFailureCode, type RehearsalInput, type RehearsalSkip, type SandboxRunStatus } from "@svc/contracts";
import { asBossDb, boss, jobKey, type Tx } from "@svc/core";

// sandbox_runs (db 0046) 워커 쪽 읽기·쓰기. 줄 하나 = 이전 하나의 deploying 차례(epoch = migrations.version) 하나.
// 모든 쓰기는 같은 차례에 두 번 와도 같은 끝 상태가 되게: 끝난 줄 넣기는 ON CONFLICT DO NOTHING, 상태 바꾸기는 조건부 UPDATE.
// 끝난 줄(skipped·passed·failed·error)은 누가 닫든 phase = done

export interface RunKey { tenantId: string; migrationId: string; epoch: number; planId: string | null }
export interface RunRow {
  id: string; status: SandboxRunStatus; skipReason: RehearsalSkip | null; failureCode: RehearsalFailureCode | null;
  bundleSha256: string | null; reusedFrom: string | null; sandboxName: string | null;
  leftSec: number | null;                 // 지금 단계(queued = 줄 서기, running = 실행) 기한까지 남은 초 (DB 시계). 음수면 지남
  result: RehearsalResult | null;
  // 결과 없이 끝난 줄(failed·error, agent-worker 입력 거부·처리기 오류)의 이유. agent-worker 는 이유를 감사(sandbox.rehearsal)에만 쓴다 (pg-sandbox-run-store)
  errorReason: string | null;
}

export async function readRun(tx: Tx, k: Pick<RunKey, "migrationId" | "epoch">): Promise<RunRow | null> {
  const r = await tx.query(
    `SELECT id, status, skip_reason AS "skipReason", failure_code AS "failureCode", bundle_sha256 AS "bundleSha256",
            reused_from AS "reusedFrom", sandbox_name AS "sandboxName", result,
            EXTRACT(EPOCH FROM (deadline_at - now()))::float8 AS "leftSec",
            CASE WHEN s.status IN ('failed', 'error') AND s.result IS NULL THEN
              (SELECT a.detail->>'reason' FROM audit_events a
                WHERE a.target = s.migration_id::text AND a.action = 'sandbox.rehearsal' AND a.detail->>'sandboxRunId' = s.id::text
                ORDER BY a.seq DESC LIMIT 1) END AS "errorReason"
       FROM sandbox_runs s WHERE migration_id = $1 AND epoch = $2 AND purpose = 'rehearsal'`, [k.migrationId, k.epoch]);
  const x = r.rows[0] as (Omit<RunRow, "result"> & { result: unknown }) | undefined;
  if (!x) return null;
  const parsed = RehearsalResult.safeParse(x.result);
  return { ...x, result: parsed.success ? parsed.data : null };
}

export async function insertSkipped(tx: Tx, k: RunKey, reason: RehearsalSkip): Promise<void> {
  await tx.query(
    `INSERT INTO sandbox_runs (tenant_id, migration_id, epoch, status, phase, skip_reason, plan_id, finished_at)
     VALUES ($1, $2, $3, 'skipped', 'done', $4, $5, now()) ON CONFLICT (migration_id, epoch, purpose) DO NOTHING`,
    [k.tenantId, k.migrationId, k.epoch, reason, k.planId]);
}

// DRAFT(ai): 재사용은 같은 이전·같은 계획·같은 지문의 처음 통과 줄(재사용 줄이 아닌 것)이 24시간 안에 끝났을 때만 (설계 7장 질문 9)
//   실패 줄은 재사용하지 않는다 (비밀 값·이미지를 고친 뒤 재개하면 같은 지문이어도 다시 돌아야 한다)
export async function insertReused(tx: Tx, k: RunKey, bundleSha256: string): Promise<{ id: string; from: string } | null> {
  if (!k.planId) return null;
  const r = await tx.query(
    `INSERT INTO sandbox_runs (tenant_id, migration_id, epoch, status, phase, plan_id, bundle_sha256, reused_from, sandbox_name, host_namespace,
                               input, result, started_at, finished_at, deleted_at)
     SELECT $1, $2, $3, 'passed', 'done', plan_id, bundle_sha256, id, sandbox_name, host_namespace, input, result, now(), now(), deleted_at
       FROM sandbox_runs
      WHERE migration_id = $2 AND plan_id = $4 AND bundle_sha256 = $5 AND status = 'passed' AND reused_from IS NULL
        AND purpose = 'rehearsal' AND finished_at > now() - interval '24 hours'
      ORDER BY finished_at DESC LIMIT 1
     ON CONFLICT (migration_id, epoch, purpose) DO NOTHING
     RETURNING id, reused_from AS "from"`, [k.tenantId, k.migrationId, k.epoch, k.planId, bundleSha256]);
  return (r.rows[0] as { id: string; from: string } | undefined) ?? null;
}

// 리허설 전에 워커가 끝낸 실패 (종류 미지원 = failed, 이미지 복사 실패 = error). 줄이 있어야 화면이 이유를 보인다
export async function insertFinished(tx: Tx, k: RunKey, x: { status: "failed" | "error"; code: RehearsalFailureCode; bundleSha256: string }): Promise<void> {
  await tx.query(
    `INSERT INTO sandbox_runs (tenant_id, migration_id, epoch, status, phase, failure_code, plan_id, bundle_sha256, finished_at)
     VALUES ($1, $2, $3, $4, 'done', $5, $6, $7, now()) ON CONFLICT (migration_id, epoch, purpose) DO NOTHING`,
    [k.tenantId, k.migrationId, k.epoch, x.status, x.code, k.planId, x.bundleSha256]);
}

/** queued 줄 + sandbox-rehearsal 작업을 한 트랜잭션에. 기한은 줄 서기 기한 (실행 기한은 agent-worker 가 잡을 때 다시 쓴다).
 *  ON CONFLICT 없음: 같은 차례 줄이 이미 있으면 고유 키 위반으로 트랜잭션째 취소되고, 작업 재시도가 그 줄을 읽어 따라간다 */
export async function insertQueued(tx: Tx, k: RunKey & { id: string; requestId: string }, input: RehearsalInput, queueTimeoutSec: number): Promise<void> {
  await tx.query(
    `INSERT INTO sandbox_runs (id, tenant_id, migration_id, epoch, status, plan_id, bundle_sha256, input, deadline_at)
     VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, now() + make_interval(secs => $8))`,
    [k.id, k.tenantId, k.migrationId, k.epoch, k.planId, input.bundleSha256, JSON.stringify(input), queueTimeoutSec]);
  // 리허설 격리: 회사마다 키 하나 = 같은 회사는 한 번에 1건, 다른 회사는 같이 (core boss.ts sandbox-rehearsal 정책, 노드는 agent-worker 가 회사마다 나눔)
  const job = await boss.send(QUEUES.sandboxRehearsal, { tenantId: k.tenantId, requestId: k.requestId, sandboxRunId: k.id },
    { singletonKey: jobKey(QUEUES.sandboxRehearsal, { tenantId: k.tenantId }), db: asBossDb(tx) });
  if (!job) throw new Error("sandbox-rehearsal job not created");
}

/** 지금 단계 기한이 지난 queued·running 줄을 error(REHEARSAL_TIMEOUT) 로. agent-worker 가 먼저 잡거나 썼으면 0줄 (먼저 쓴 쪽이 이긴다) */
export async function expireRun(tx: Tx, id: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE sandbox_runs SET status = 'error', phase = 'done', failure_code = 'REHEARSAL_TIMEOUT', finished_at = now()
      WHERE id = $1 AND status IN ('queued', 'running') AND deadline_at <= now()`, [id]);
  return (r.rowCount ?? 0) > 0;
}
