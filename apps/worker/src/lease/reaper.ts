import { QUEUES, type MigrationStatus } from "@svc/contracts";
import {
  boss, withTenant, advance, listExpiredEnvLocks, cleanupIdempotencyKeys,
  releaseEnvLocks, failureEdge, INACTIVE_STATES, STEP_QUEUES, LEASE, type ExpiredLock, type Tx,
} from "@svc/core";
import { replicationFromEnv, type FenceRecovery } from "@svc/replication";

// 청소 작업(60초마다): 기한이 지난 환경 잠금을 찾아 상태를 정리한다.
// pg-boss 감시자도 같은 이동을 시도할 수 있지만 둘 다 ifStill이라 한 번만 적용된다.

export type ReapAction =
  | { kind: "stale" }                                           // 승인됐는데 시작 못 함 → 낡음, 잠금 해제
  | { kind: "fail"; to: "failed" | "paused"; code: ReapCode }
  | { kind: "release" }                                         // 이전이 이미 끝났는데 잠금만 남음
  | { kind: "skip"; why: string };

// JOB_NOT_PICKED = 반납 뒤 아무도 안 집음, STEP_FAILED = 집혔는데 실패하고 반납(재시도도 끝남, Z12-6), WORKER_LOST = 쥔 채 생존 신호 끊김
export type ReapCode = "JOB_NOT_PICKED" | "STEP_FAILED" | "WORKER_LOST";

// 더 일할 게 없는 상태 = 끝 상태 + 낡음 + 거절. 정의는 core states.ts (Z43)
const DONE: readonly string[] = INACTIVE_STATES;

// 순수 함수: 잠금 하나를 보고 무엇을 할지 정한다
// stepFailed: 이 단계에 들어온 뒤 job.failed(또는 *.attempt_failed) 감사가 있나 (reapLock이 DB에서 읽어 넣는다)
export function decideReap(l: Pick<ExpiredLock, "holder" | "status"> & { stepFailed?: boolean }): ReapAction {
  const status = l.status as MigrationStatus;
  if (DONE.includes(status)) return { kind: "release" };
  if (l.holder === "reserved" && status === "approved") return { kind: "stale" };
  const code: ReapCode = l.holder !== "reserved" ? "WORKER_LOST" : l.stepFailed ? "STEP_FAILED" : "JOB_NOT_PICKED";
  // DRAFT(ai): failed로 갈 길이 없는 상태(deploying·syncing·shifting·cleanup)는 일시정지로 보낸다.
  //            사람이 원인을 보고 재개(같은 단계 작업 다시 넣기)하거나 롤백한다. 팀 합의 전
  // 규칙은 워커 죽은 작업 처리(Z19 H4)와 같은 core failureEdge (Z43)
  const to = failureEdge(status);
  return to ? { kind: "fail", to, code } : { kind: "skip", why: `no failed/paused edge from ${status}` };
}

export interface ReapReport { scanned: number; applied: number; skipped: number; jobsFailed: number }

export async function reapOnce(): Promise<ReapReport> {
  const rep: ReapReport = { scanned: 0, applied: 0, skipped: 0, jobsFailed: 0 };
  const locks = await listExpiredEnvLocks();
  const seen = new Set<string>();                       // 이전 하나에 잠금이 둘이어도 한 번만
  for (const l of locks) {
    rep.scanned++;
    if (seen.has(l.migrationId)) continue;
    seen.add(l.migrationId);
    const r = await reapLock(l);
    if (r.applied) rep.applied++; else rep.skipped++;
    if (r.jobFailed) rep.jobsFailed++;
  }
  return rep;
}

// 진짜 복제(REPL_*)가 있을 때만. STUB이면 걷을 울타리가 없다 → null. 실패해도 청소는 계속(결과는 감사 detail.fence)
export async function recoverFence(l: Pick<ExpiredLock, "migrationId" | "status">): Promise<FenceRecovery | { error: string } | null> {
  if (l.status !== "cutover" && l.status !== "rolling_back") return null;
  const repl = replicationFromEnv(l.migrationId);
  if (!repl) return null;
  const r = await repl.recoverInterruptedSwitch(l.status).catch((e) => ({ error: (e as Error).message.slice(0, 300) }));
  console.log("[lease-reaper] fence recovery", l.migrationId, JSON.stringify(r));
  return r;
}

// 단계에 들어온 뒤(migrations.updated_at) 실패 감사가 있나 (Z12-6)
export async function stepFailedSinceEntry(tx: Tx, migrationId: string): Promise<boolean> {
  const q = await tx.query(
    `SELECT 1 FROM audit_events a
      WHERE a.target = $1 AND (a.action = 'job.failed' OR a.action LIKE '%.attempt_failed')
        AND a.at >= (SELECT updated_at FROM migrations WHERE id = $2) LIMIT 1`, [migrationId, migrationId]);
  return (q.rowCount ?? 0) > 0;
}

// Z32 (맥 int5-4 kill 실측, paused 8): 반납(reserved, 10분) 뒤 다음 단계 작업이 "큐에서 차례를 기다리는 중"이면 JOB_NOT_PICKED가 아니다.
// 예: shift 1건 = 관찰 30초 이상, 워커 1개는 큐마다 한 번에 1건 → 50건이 몰리면 워커 2개로 10분 넘게 줄을 선다.
// 예전엔 그 사이 청소가 paused(JOB_NOT_PICKED)로 보내고, 차례가 온 작업은 재확인에서 job.rejected로 끝났다(사람 재개 필요).
// 이제: 이 이전의 단계 작업이 created·retry·active로 있고 QUEUE_WAIT_MAX_SEC(기본 3600초) 안에 들어간 것이면 예약 기한만 10분 늘리고 넘어간다.
// DRAFT(ai): 1시간 넘게 안 집히면(워커가 하나도 없음 등) 예전처럼 paused(JOB_NOT_PICKED)
export const QUEUE_WAIT_MAX_SEC = Number(process.env.QUEUE_WAIT_MAX_SEC) || 3600;
export async function stepJobWaiting(tx: Tx, l: Pick<ExpiredLock, "migrationId" | "tenantId">): Promise<boolean> {
  const q = await tx.query(
    `SELECT 1 FROM pgboss.job
      WHERE name = ANY($1::text[]) AND state IN ('created', 'retry', 'active')
        AND data->>'migrationId' = $2 AND data->>'tenantId' = $3
        AND created_on > now() - make_interval(secs => $4) LIMIT 1`,
    [STEP_QUEUES, l.migrationId, l.tenantId, QUEUE_WAIT_MAX_SEC]);
  return (q.rowCount ?? 0) > 0;
}

// 잠금 하나 처리 (reapOnce가 부른다. 시험은 다른 회사를 안 건드리게 이것만 부른다)
export async function reapLock(l: ExpiredLock): Promise<{ action: ReapAction; applied: boolean; jobFailed: boolean; lost: boolean }> {
  const m = { id: l.migrationId, tenantId: l.tenantId };
  const audit = (action: string) => ({ actor: "worker", action, target: l.migrationId, result: "ok" as const,
    detail: { by: "lease-reaper", envId: l.envId, holder: l.holder, ...(l.jobId ? { jobId: l.jobId, jobQueue: l.jobQueue } : {}) } });
  let act: ReapAction = { kind: "skip", why: "not decided" };
  let fence: Awaited<ReturnType<typeof recoverFence>> = null;
  let lost = false;
  const done = await withTenant(l.tenantId, async (tx) => {
    // Z38-5: 목록(트랜잭션 밖)과 처리 사이에 워커가 기한 지난 잠금을 다시 인수할 수 있다.
    //   이전 행 → 잠금 줄 순서(advance 와 같은 잠금 순서)로 잠그고 "아직 기한 지남"을 다시 본다 (release 는 제외)
    if (!DONE.includes(l.status)) {
      await tx.query("SELECT 1 FROM migrations WHERE id = $1 FOR UPDATE", [l.migrationId]);
      const still = await tx.query(
        `SELECT 1 FROM env_locks WHERE migration_id = $1 AND lease_expires_at < now() ORDER BY env_id FOR UPDATE`,
        [l.migrationId]);
      if (still.rowCount === 0) { lost = true; return false; }   // 그사이 누가 인수·연장했다
      // Z32: 반납 뒤 다음 작업이 줄 서 있음 → 기다림 (예약 기한 연장). approved(시작 전 낡음)는 예전 그대로
      if (l.holder === "reserved" && l.status !== "approved" && await stepJobWaiting(tx, l)) {
        await tx.query(`UPDATE env_locks SET lease_expires_at = now() + make_interval(secs => $2)
                         WHERE migration_id = $1 AND holder = 'reserved'`, [l.migrationId, LEASE.handBackSec]);
        act = { kind: "skip", why: "step_job_waiting" };
        return false;
      }
    }
    // Z36 (Z42 Q17): 쓰기 담당 바꾸기 도중(cutover·rolling_back)에 잠금 기한이 지났으면, 상태를 옮기기 전에 울타리부터 확인·해제.
    // Z38 R3-1: 위 잠금을 쥔 채 부른다 → 새 워커의 acquireEnvLock 이 울타리 해제가 끝날 때까지 기다린다
    //   대가: 복제 DB 두 곳에 붙는 몇백 ms 동안 이 트랜잭션이 열려 있다 【추정】
    fence = await recoverFence(l);
    const stepFailed = l.holder === "reserved" && !DONE.includes(l.status) ? await stepFailedSinceEntry(tx, l.migrationId) : false;
    act = decideReap({ holder: l.holder, status: l.status, stepFailed });
    if (act.kind === "skip") return false;
    if (act.kind === "release") return (await releaseEnvLocks(tx, l.migrationId)) > 0;
    if (act.kind === "stale")
      return advance(tx, m, "approved", "stale", { mode: "ifStill", audit: audit("migration.stale") });
    const au = audit(`migration.${act.to}`);
    return advance(tx, m, l.status as MigrationStatus, act.to,
      { mode: "ifStill", failureCode: act.code, audit: fence ? { ...au, detail: { ...au.detail, fence } } : au });
  });
  const a = act as ReapAction;
  // 쥐고 있던 큐 작업도 실패 처리한다. 안 하면 같은 작업 키가 "실행 중"으로 남아 재개 작업이 못 들어간다
  // (Z12-4: 이제 runStep이 잠금 줄에 job_id를 적는다)
  let jobFailed = false;
  if (done && a.kind === "fail" && l.jobId && l.jobQueue) {
    await boss.fail(l.jobQueue, l.jobId, { reason: a.code }).then(() => { jobFailed = true; },
      (e) => console.error("[lease-reaper] boss.fail", e));
  }
  return { action: a, applied: done, jobFailed, lost };
}

// Z38 시험용 얇은 감싸기: 결과를 한 단어로
export async function reapOne(l: ExpiredLock): Promise<"skip" | "applied" | "applied+job" | "lost"> {
  const r = await reapLock(l);
  if (r.lost) return "lost";
  if (r.action.kind === "skip") return "skip";
  if (!r.applied) return "lost";
  return r.jobFailed ? "applied+job" : "applied";
}

// 워커 main.ts에서 한 줄로 등록: await registerLeaseJobs();
// DRAFT(ai): 멱등 키 청소는 1시간마다(17분), 키 보관 24시간
export async function registerLeaseJobs() {
  await boss.schedule(QUEUES.leaseReaper, "* * * * *");
  await boss.schedule(QUEUES.idempotencyCleanup, "17 * * * *");
  await boss.work(QUEUES.leaseReaper, async () => {
    const r = await reapOnce();
    if (r.applied || r.jobsFailed) console.log("[lease-reaper]", r);
  });
  await boss.work(QUEUES.idempotencyCleanup, async () => {
    const n = await cleanupIdempotencyKeys(24);
    if (n) console.log("[idempotency-cleanup] deleted", n);
  });
}
