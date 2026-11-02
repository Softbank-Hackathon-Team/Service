import { TERMINAL, type MigrationStatus, type QueueName } from "@svc/contracts";
import type { Tx } from "./db.js";
import { boss, asBossDb, jobKey, parseJobData } from "./boss.js";
import { writeAudit, type AuditInput } from "./audit.js";
import { NotFound, InvalidTransition, LeaseLost, JobNotCreated, GuardFailed } from "./errors.js";
import { checkGuard, loadGuardFacts, type GuardFacts, type TransitionEvidence } from "./guards.js";
import { REPLANNABLE_FAILURES, canMove } from "./states.js";
import { reserveEnvLocks, releaseEnvLocks, reclaimEnvLocks, type ReclaimedLock } from "./envlock.js";
import { envNumber } from "@svc/contracts";
import { notifyMigration } from "./notify.js";

export interface AdvanceOpts {
  mode?: "strict" | "ifStill";
  // 잠금 확인. envIds를 주면 그 환경 모두를 내가(holder) 기한 안에 쥐고 있어야 한다
  fence?: { envId?: string; envIds?: string[]; holder: string };
  next?: { queue: QueueName; data: object; opts?: Record<string, unknown> };
  evidence?: TransitionEvidence;     // 전이 조건에 쓰는 증거. 감사 detail에 남는다
  failureCode?: string;              // → failed / → paused 일 때 이유 (예: WORKER_LOST)
  rollbackWindowSec?: number;        // cutover → rollback_window 일 때 창 길이
  audit: AuditInput;
}

// DRAFT(ai): 롤백 가능 창 기본 길이. 데모 2분 / 실서비스 24시간 (qa/09 5절, 팀 합의 전).
// 같은 트랜잭션에서 처리기가 rollback_window_ends_at을 먼저 적었으면 그 값을 쓴다
// 롤백 가능 창(초) 기본값은 한 곳에서. 워커 cutover.ts 도 이 값을 쓴다 (Z10 M3: 예전엔 워커 3초 / 여기 120초로 달랐음)
export const DEFAULT_ROLLBACK_WINDOW_SEC = envNumber(process.env.ROLLBACK_WINDOW_SEC, 3);

// 잠금을 푸는 상태: 끝 상태 셋 + 낡음(승인 후 시작 못 함) + 이른 실패.
// DRAFT(ai): provisioning 이하에서 실패(apply 실패 등)하면 잠금을 푼다. 다시 계획(T37)하면 승인 때 다시 예약한다.
//   예전엔 실패가 잠금을 계속 쥐어 같은 환경 다음 이전이 409 ENV_BUSY (W·X에서 재현).
//   데이터가 움직이기 시작한 뒤(cutover·rolling_back 등)의 실패는 잠금을 남긴다: 복제·트래픽이 반쯤 바뀐 상태일 수 있어
//   사람이 보고 POST .../cancel {manualCleanupConfirmed:true}(T38)로 끝낸다. TODO(human): provisioning 실패 때
//   Terraform이 반쯤 만든 자원이 남는데 잠금을 풀어도 되는지 (대안: 유지 + 취소로만 해제)
const RELEASES_LOCK = (from: MigrationStatus, to: MigrationStatus) =>
  TERMINAL.includes(to) || (to === "stale" && from === "approved")
  || (to === "failed" && REPLANNABLE_FAILURES.includes(from));

// 상태 옮기기. 상태를 바꾸는 곳은 이 함수 하나다.
// 잠금 순서: 이전 행 → 환경 잠금 줄 → 큐 표 → 감사 자문 잠금 (거꾸로 하면 교착, verify-10/05)
// Z43: 순서를 한눈에 보이게 단계마다 함수 하나로 나눴다. 단계 순서·SQL은 그대로다
export async function advance(
  tx: Tx,
  m: { id: string; tenantId: string },
  from: MigrationStatus,
  to: MigrationStatus,
  o: AdvanceOpts,
): Promise<boolean> {
  if (!(await lockRowAt(tx, m.id, from, to, o.mode))) return false;   // 1. 행 잠금 + 길 확인
  const facts = await checkTransition(tx, m.id, from, to, o);         // 2. 전이 조건
  const reclaimed = await settleEnvLocks(tx, m, from, to, facts, o.fence); // 3. 환경 잠금
  await writeStatus(tx, m.id, from, to, o);                           // 4. 상태 변경
  if (o.next) await enqueueNext(tx, m.id, facts.targetEnvId, o.next); // 5. 다음 작업
  await recordAndNotify(tx, m, from, to, o, reclaimed);               // 6·7. 감사 + 화면 신호
  return true;
}

// 1. 행 잠금 (RLS 적용). 상태가 이미 바뀌었으면 ifStill은 false, strict는 409
async function lockRowAt(tx: Tx, id: string, from: MigrationStatus, to: MigrationStatus,
  mode: AdvanceOpts["mode"]): Promise<boolean> {
  const r = await tx.query("SELECT status FROM migrations WHERE id = $1 FOR UPDATE", [id]);
  const row = r.rows[0] as { status: MigrationStatus } | undefined;
  if (!row) throw new NotFound("migration", id);
  if (row.status !== from) {
    if (mode === "ifStill") return false;
    throw new InvalidTransition(row.status, to);
  }
  if (!canMove(from, to)) throw new InvalidTransition(from, to);
  return true;
}

// 2. 전이 조건 (DB에서 다시 읽은 사실 + 부르는 쪽 증거)
async function checkTransition(tx: Tx, id: string, from: MigrationStatus, to: MigrationStatus,
  o: AdvanceOpts): Promise<GuardFacts> {
  const facts = await loadGuardFacts(tx, id);
  if (!facts) throw new NotFound("migration", id);
  const why = checkGuard(from, to, { facts, ev: o.evidence ?? {}, failureCode: o.failureCode });
  if (why) throw new GuardFailed(from, to, why);
  return facts;
}

// 3. 환경 잠금: 확인(fence) → 예약 → 해제 → 되찾기
async function settleEnvLocks(tx: Tx, m: { id: string; tenantId: string }, from: MigrationStatus,
  to: MigrationStatus, facts: GuardFacts, fence: AdvanceOpts["fence"]): Promise<ReclaimedLock[]> {
  if (fence) {
    const envIds = [...new Set([...(fence.envIds ?? []), ...(fence.envId ? [fence.envId] : [])])].sort();
    const ok = await tx.query(
      `SELECT 1 FROM env_locks WHERE env_id = ANY($1::uuid[]) AND migration_id=$2
         AND holder=$3 AND lease_expires_at > now() ORDER BY env_id FOR UPDATE`,
      [envIds, m.id, fence.holder]);
    if (envIds.length === 0 || ok.rowCount !== envIds.length) throw new LeaseLost(m.id);
  }
  let reclaimed: ReclaimedLock[] = [];
  if (to === "approved")   // T09: 승인과 같은 트랜잭션에서 두 환경 예약 (기한 = 계획 만료). z32-10: 만료된 남의 잠금 회수
    reclaimed = await reserveEnvLocks(tx, m, [facts.sourceEnvId, facts.targetEnvId], facts.plan!.expiresAt);
  if (RELEASES_LOCK(from, to)) await releaseEnvLocks(tx, m.id);
  // 롤백 시작: 일하던 워커에게서 잠금을 되찾아 롤백 작업이 인수할 수 있게 한다 (줄은 남김)
  if (to === "rolling_back") await reclaimEnvLocks(tx, m.id);
  return reclaimed;
}

// 4. 상태 변경 + 상태별 칸
async function writeStatus(tx: Tx, id: string, from: MigrationStatus, to: MigrationStatus,
  o: AdvanceOpts): Promise<void> {
  await tx.query(
    `UPDATE migrations SET status = $1, version = version + 1, updated_at = now(),
        paused_from = CASE WHEN $1 = 'paused' THEN $3 ELSE NULL END,
        failed_at_status = CASE WHEN $1 = 'failed' THEN $3 ELSE NULL END,
        failure_code = CASE WHEN $1 IN ('failed', 'paused', 'rolling_back', 'cancelled') THEN $4
                            WHEN $1 = 'shifting' AND $3 = 'cutover' THEN $4
                            WHEN $1 = 'rolled_back' THEN failure_code
                            ELSE NULL END,
        rollback_window_ends_at = CASE
          WHEN $1 = 'rollback_window'
            THEN COALESCE(rollback_window_ends_at, now() + make_interval(secs => $5))
          WHEN $1 = 'cleanup' THEN rollback_window_ends_at
          ELSE NULL END
      WHERE id = $2`,
    [to, id, from,
     to === "failed" ? (o.failureCode ?? "UNSPECIFIED") : (o.failureCode ?? null),
     o.rollbackWindowSec ?? DEFAULT_ROLLBACK_WINDOW_SEC]);
}

// 5. 다음 작업 (같은 트랜잭션). 같은 작업 키(jobKey)를 기본으로 붙인다. 부르는 쪽 opts.singletonKey가 있으면 그게 이긴다
async function enqueueNext(tx: Tx, migrationId: string, targetEnvId: string,
  next: NonNullable<AdvanceOpts["next"]>): Promise<void> {
  const data = parseJobData(next.queue, next.data) as { envId?: string; agentRunId?: string };
  const key = jobKey(next.queue, { migrationId, targetEnvId, envId: data.envId, agentRunId: data.agentRunId });
  const jobId = await boss.send(next.queue, data,
    { ...(key ? { singletonKey: key } : {}), ...next.opts, db: asBossDb(tx) });
  if (!jobId) throw new JobNotCreated(next.queue);
}

// 6. 감사 기록 (마지막 잠금). 증거와 실패 사유를 detail에 같이 남긴다 / 7. 화면 신호 (확정될 때만 나감)
async function recordAndNotify(tx: Tx, m: { id: string; tenantId: string }, from: MigrationStatus,
  to: MigrationStatus, o: AdvanceOpts, reclaimed: ReclaimedLock[] = []): Promise<void> {
  const detail = { ...(o.audit.detail ?? {}), from, to,
    ...(o.evidence ? { evidence: o.evidence } : {}),
    ...(o.failureCode ? { failureCode: o.failureCode } : {}) };
  await writeAudit(tx, m.tenantId, { ...o.audit, detail });
  // z32-10: 회수한 잠금마다 1줄 (감사 자문 잠금은 이미 쥐었으니 "마지막 잠금" 순서는 그대로)
  for (const r of reclaimed)
    await writeAudit(tx, m.tenantId, { actor: o.audit.actor, action: "env_lock.reclaimed", target: r.envId, result: "ok",
      detail: { code: "LOCK_RECLAIMED", byMigrationId: m.id, ...r } });
  await notifyMigration(tx, { t: m.tenantId, id: m.id, s: to });
}
