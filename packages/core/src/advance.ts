import { QUEUES, TERMINAL, type MigrationStatus, type QueueName } from "@svc/contracts";
import type { Tx } from "./db.js";
import { boss, asBossDb, jobKey, parseJobData, tenantGroup } from "./boss.js";
import { writeAudit, type AuditInput } from "./audit.js";
import { NotFound, InvalidTransition, LeaseLost, JobNotCreated, GuardFailed } from "./errors.js";
import { checkGuard, loadGuardFacts, type GuardFacts, type TransitionEvidence } from "./guards.js";
import { REPLANNABLE_FAILURES, canMove } from "./states.js";
import { reserveEnvLocks, releaseEnvLocks, reclaimEnvLocks, releaseTrafficLease, type ReclaimedLock } from "./envlock.js";
import { envNumber } from "@svc/contracts";
import { notifyMigration } from "./notify.js";
import { queueAgentRun, type QueueAgentResult } from "./agent-runs.js";

export interface AdvanceOpts {
  mode?: "strict" | "ifStill";
  // 잠금 확인. envIds를 주면 그 환경 모두를 내가(holder) 기한 안에 쥐고 있어야 한다
  fence?: { envId?: string; envIds?: string[]; holder: string };
  next?: { queue: QueueName; data: object; opts?: Record<string, unknown> };
  evidence?: TransitionEvidence;     // 전이 조건에 쓰는 증거. 감사 detail에 남는다
  failureCode?: string;              // → failed / → paused 일 때 이유 (예: WORKER_LOST)
  rollbackWindowSec?: number;        // cutover → rollback_window 일 때 창 길이
  // PA5a: → failed / paused 이고 failureCode 가 있으면 실패 원인 분석(agent_runs failure_analysis)을 같은 트랜잭션에 넣는다.
  //   깃발 FAILURE_ANALYSIS=1 일 때만 (기본 꺼짐: 에이전트 워커 분기 A5b 전엔 분석이 queued 로 남음). 못 넣어도 전이는 그대로 확정
  analyze?: boolean;
  audit: AuditInput;
}

// DRAFT(ai): 롤백 가능 창 기본 길이. 데모 2분 / 실서비스 24시간 (qa/09 5절, 팀 합의 전).
// 같은 트랜잭션에서 처리기가 rollback_window_ends_at을 먼저 적었으면 그 값을 쓴다
// 롤백 가능 창(초) 기본값은 한 곳에서. 워커 cutover.ts 도 이 값을 쓴다 (Z10 M3: 예전엔 워커 3초 / 여기 120초로 달랐음)
// F8-4: 기본값을 주석대로 120초(데모)로. 예전 3초는 컷오버 3초 뒤 정리가 역방향 복제를 걷어 사실상 롤백 불가였다.
//   TODO(human): 실서비스 기본값(24시간?)과 계획 화면에서 고객이 고를 수 있게 할지. 시험 스크립트는 ROLLBACK_WINDOW_SEC=3 을 준다
export const PLAN_ROLLBACK_WINDOW_SEC = 120;
export const DEFAULT_ROLLBACK_WINDOW_SEC = envNumber(process.env.ROLLBACK_WINDOW_SEC, PLAN_ROLLBACK_WINDOW_SEC);
/** F8-4: 이번 컷오버의 창 길이. 환경변수(개발·시험 덮어쓰기) > 승인한 계획서 칸 > 기본 */
export function rollbackWindowSecFor(plan: { rollbackWindowSec?: number } | null | undefined, env: NodeJS.ProcessEnv = process.env):
  { sec: number; source: "env" | "plan" | "default" } {
  if (env.ROLLBACK_WINDOW_SEC !== undefined && env.ROLLBACK_WINDOW_SEC.trim() !== "")
    return { sec: envNumber(env.ROLLBACK_WINDOW_SEC, PLAN_ROLLBACK_WINDOW_SEC), source: "env" };
  if (typeof plan?.rollbackWindowSec === "number") return { sec: plan.rollbackWindowSec, source: "plan" };
  return { sec: PLAN_ROLLBACK_WINDOW_SEC, source: "default" };
}

// 잠금을 푸는 상태: 끝 상태 셋 + 낡음(승인 후 시작 못 함) + 이른 실패.
// DRAFT(ai): provisioning 이하에서 실패(apply 실패 등)하면 잠금을 푼다. 다시 계획(T37)하면 승인 때 다시 예약한다.
//   예전엔 실패가 잠금을 계속 쥐어 같은 환경 다음 이전이 409 ENV_BUSY (W·X에서 재현).
//   데이터가 움직이기 시작한 뒤(cutover·rolling_back 등)의 실패는 잠금을 남긴다: 복제·트래픽이 반쯤 바뀐 상태일 수 있어
//   사람이 보고 POST .../cancel {manualCleanupConfirmed:true}(T38)로 끝낸다. TODO(human): provisioning 실패 때
//   Terraform이 반쯤 만든 자원이 남는데 잠금을 풀어도 되는지 (대안: 유지 + 취소로만 해제)
// Jeong 11/4 01:53Z: provisioning 실패도 예전처럼 잠금을 푼다 (사람 답을 기다리는 동안 남의 이전을 막지 않게).
//   재시도·거절(롤백)을 고르면 POST .../failure-decision 이 같은 트랜잭션에서 잠금을 다시 예약한다 (그 사이 남이 잡았으면 409 ENV_BUSY)
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
  if (TERMINAL.includes(to)) await releaseTrafficLease(tx, m.id);     // 4-1. PF FM-ORC-10: 끝나면 트래픽 LB 주인도 놓는다
  if (o.next) await enqueueNext(tx, m.id, facts.targetEnvId, o.next); // 5. 다음 작업
  const fa = await queueFailureAnalysis(tx, m, from, to, o);          // 5-1. 실패 원인 분석 (큐 뒤·감사 앞 고정)
  const td = tearsDownTarget(from, to)
    ? await enqueueTargetTeardown(tx, m, o) : null;                   // 5-2. 만든 자원 지우기 작업 (G5-1, 큐 단계라 감사 앞)
  await recordAndNotify(tx, m, from, to, o, reclaimed, fa);           // 6·7. 감사 + 화면 신호
  if (td) await requestTargetTeardown(tx, m, from, to, o, td);            // 8. 지우기 요청 감사 (감사 잠금은 6에서 이미 쥠)
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
          -- PW-1: 정리 중 일시정지(cleanup → paused → cleanup)에서도 창 끝 시각을 지우지 않는다 (예전엔 paused 가 NULL 로 지워 보고서·재개 뒤 정리에서 창 기록이 사라졌다)
          WHEN $1 IN ('cleanup', 'paused') THEN rollback_window_ends_at
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
    { ...(key ? { singletonKey: key } : {}), ...tenantGroup(next.queue, (data as { tenantId?: string }).tenantId), ...next.opts, db: asBossDb(tx) });
  if (!jobId) throw new JobNotCreated(next.queue);
}

// 5-1. 실패 원인 분석 넣기 (PA5a, 계획 26 3.2). 자리 = 큐 단계 뒤·감사 앞: 잠금 순서(이전 행 → 큐 → 감사)를 그대로 지킨다
// 던지지 않는다: 바쁨·키 없음·지출 상한·작업 키 겹침은 { skipped }, DB 오류도 SAVEPOINT 로 되돌리고 { skipped: "error" }
//   → 실패 전이는 언제나 확정된다. 같은 실패에 한 번: 작업 키 agent-run:fa:<이전>:<version> + 같은 종류 queued·running 이면 busy
async function queueFailureAnalysis(tx: Tx, m: { id: string; tenantId: string }, from: MigrationStatus,
  to: MigrationStatus, o: AdvanceOpts): Promise<QueueAgentResult | null> {
  // G5-1 (Jeong 결정 11/3 20:02Z: 실패하면 AI 가 원인을 분석하고 failed 로 끝낸다): failed 로 가는 길은 부르는 쪽이 analyze 를
  //   안 줘도 분석한다 (리퍼·API·운영 도구 길도). paused 는 예전처럼 부르는 쪽이 analyze:true 를 줄 때만. 끄려면 analyze:false
  const want = to === "failed" ? o.analyze !== false : o.analyze === true;
  if (!want || (to !== "failed" && to !== "paused") || !o.failureCode) return null;
  // G5-1 DRAFT(ai): 깃발 기본 켬. FAILURE_ANALYSIS=0 이면 끔 (에이전트 워커가 없는 시험·데모). 예전 기본은 꺼짐
  if (process.env.FAILURE_ANALYSIS?.trim() === "0") return null;
  await tx.query("SAVEPOINT failure_analysis");
  try {
    const v = (await tx.query("SELECT version FROM migrations WHERE id = $1", [m.id])).rows[0]?.version as number;
    const r = await queueAgentRun(tx, {
      tenantId: m.tenantId, migrationId: m.id, kind: "failure_analysis", checkLlm: true,
      requestId: `failure-analysis:${m.id}:${v}`, singletonKey: `agent-run:fa:${m.id}:${v}`,
      // 모델에 들어가는 글. 상태·코드 이름만 (비밀·오류 원문은 워커가 감사에서 다시 읽는다)
      task: `실패 원인 분석: ${from} → ${to}, 실패 코드 ${o.failureCode}`,
    });
    await tx.query("RELEASE SAVEPOINT failure_analysis");
    return r;
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT failure_analysis");
    return { skipped: "error" };
  }
}

// 5-2·8. 도착 자원 지우기 (target-destroy 작업을 같은 트랜잭션에).
// DECISION(team): 실패하면 트래픽 출발 → AI 원인 분석 → 사람에게 "재시도할까?" → 승인: 실패한 단계부터 / 거절: 롤백(트래픽 출발 → 만든 자원 삭제 → rolled_back)
//   (Jeong 11/4 01:53Z, 11/3 20:02Z "실패 → failed + 자동 삭제" 대체, ADR-066 개정). 그래서 failed 로 갈 때는 지우지 않는다(재시도가 같은 자원을 쓴다).
//   지우기는 거절 → rolling_back → rolled_back 길에서만. failed → cancelled 는 지우지 않는다: 만들기 전 실패(지울 것 없음)이거나
//   사람이 수동 정리를 확인한 경우(T38)이고, cleanup 뒤 실패면 도착이 이미 새 주인이라 지우면 안 된다
// PF FM-ORC-08: 롤백으로 끝나도(rolled_back) 도착 자원은 더 쓸 일이 없다 (출발이 다시 주인, 롤백 작업이 복제를 이미 걷음).
//   작업 폴더가 없으면(만들기 전 실패) 지우기 작업이 "지울 것 없음"으로 끝난다.
//   DRAFT(ai): Argo 로 공유 도착 클러스터에 올린 앱(Helm)은 이 지우기 범위 밖(gitops 영역). completed 는 도착이 새 주인이라 절대 안 지운다
/** 예전 G5-1 "실패하면 바로 지움" 단계 목록. 01:53Z 결정으로 비었다 (시험·문서가 이름을 찾을 수 있게 남김) */
export const TEARDOWN_ON_FAIL: readonly MigrationStatus[] = [];
export const tearsDownTarget = (_from: MigrationStatus, to: MigrationStatus) => to === "rolled_back";
// 던지지 않는다(5-1 실패 원인 분석과 같은 규칙): 큐에 못 넣어도 failed 전이는 확정된다. 못 넣은 이유는 감사 detail.queueError 에 남아
//   사람이 npm run tf:real -- destroy <이전 id> 로 지운다
async function enqueueTargetTeardown(tx: Tx, m: { id: string; tenantId: string }, o: AdvanceOpts): Promise<{ queued: boolean; queueError?: string }> {
  const requestId = String((o.audit.detail as { requestId?: unknown } | undefined)?.requestId ?? `teardown:${m.id}`);
  await tx.query("SAVEPOINT target_teardown");
  try {
    const jobId = await boss.send(QUEUES.targetDestroy, { tenantId: m.tenantId, requestId, migrationId: m.id },
      { singletonKey: `${QUEUES.targetDestroy}:${m.id}`, db: asBossDb(tx) });
    await tx.query("RELEASE SAVEPOINT target_teardown");
    // null = 같은 키 작업이 이미 대기 중 (그 작업이 같은 일을 한다)
    return { queued: jobId !== null };
  } catch (e) {
    await tx.query("ROLLBACK TO SAVEPOINT target_teardown");
    return { queued: false, queueError: ((e as Error)?.message ?? String(e)).slice(0, 200) };
  }
}
async function requestTargetTeardown(tx: Tx, m: { id: string; tenantId: string }, from: MigrationStatus, to: MigrationStatus, o: AdvanceOpts,
  td: { queued: boolean; queueError?: string }) {
  await writeAudit(tx, m.tenantId, { actor: o.audit.actor, action: "target_teardown.requested", target: m.id, result: td.queueError ? "error" : "ok",
    detail: { trigger: to, ...(to === "failed" ? { failedAtStatus: from, failureCode: o.failureCode ?? "UNSPECIFIED" } : { from }), mode: "auto", humanConfirm: false,
              queue: QUEUES.targetDestroy, queued: td.queued, ...(td.queueError ? { queueError: td.queueError, hint: `npm run tf:real -- destroy ${m.id}` } : {}) } });
}
/** 지우기 작업이 아직 안 끝났나 (대기·실행·재시도). 다시 계획 막기용 */
export async function targetTeardownPending(tx: Tx, migrationId: string): Promise<boolean> {
  const q = await tx.query(`SELECT 1 FROM pgboss.job WHERE name = $1 AND singleton_key = $2 AND state IN ('created','retry','active') LIMIT 1`,
    [QUEUES.targetDestroy, `${QUEUES.targetDestroy}:${migrationId}`]);
  return (q.rowCount ?? 0) > 0;
}

// 6. 감사 기록 (마지막 잠금). 증거와 실패 사유를 detail에 같이 남긴다 / 7. 화면 신호 (확정될 때만 나감)
async function recordAndNotify(tx: Tx, m: { id: string; tenantId: string }, from: MigrationStatus,
  to: MigrationStatus, o: AdvanceOpts, reclaimed: ReclaimedLock[] = [], fa: QueueAgentResult | null = null): Promise<void> {
  const detail = { ...(o.audit.detail ?? {}), from, to,
    ...(o.evidence ? { evidence: o.evidence } : {}),
    ...(o.failureCode ? { failureCode: o.failureCode } : {}) };
  await writeAudit(tx, m.tenantId, { ...o.audit, detail });
  // z32-10: 회수한 잠금마다 1줄 (감사 자문 잠금은 이미 쥐었으니 "마지막 잠금" 순서는 그대로)
  for (const r of reclaimed)
    await writeAudit(tx, m.tenantId, { actor: o.audit.actor, action: "env_lock.reclaimed", target: r.envId, result: "ok",
      detail: { code: "LOCK_RECLAIMED", byMigrationId: m.id, ...r } });
  // PA5a: 실패 원인 분석을 넣었거나 건너뛴 기록 (감사 자문 잠금은 이미 쥐었음)
  if (fa) await writeAudit(tx, m.tenantId, "skipped" in fa
    ? { actor: o.audit.actor, action: "failure_analysis.skipped", target: m.id, result: "ok",
        detail: { reason: fa.skipped, failureCode: o.failureCode, to } }
    : { actor: o.audit.actor, action: "agent.failure_analysis.requested", target: m.id, result: "ok",
        detail: { agentRunId: fa.runId, jobId: fa.jobId, failureCode: o.failureCode, to } });
  await notifyMigration(tx, { t: m.tenantId, id: m.id, s: to });
}
