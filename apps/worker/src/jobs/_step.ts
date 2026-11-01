import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";
import type { MigrationStatus, QueueName } from "@svc/contracts";
import {
  withTenant, advance, acquireEnvLock, handBackEnvLock, sameJobTakeoverWaitSec, LeaseLost, GuardFailed, boss, asBossDb, jobKey, writeAudit, START_ONLY_RETRY,
  currentLogContext, failureEdge, jobFailedCode, LOCKED_STAGES,
  type Tx, type TransitionEvidence, type FailureCodeLike,
} from "@svc/core";
import { startHeartbeat, type Heartbeat } from "../lease/heartbeat.js";
import { log } from "../instrument.js";
import { envNumber } from "@svc/contracts";

// 워커 작업 하나 = 짧은 트랜잭션 3구간 (설계 api-orchestrator-v1 5.1)
//  ① 재확인: DB에서 상태를 다시 읽는다. 기대한 상태가 아니면 아무것도 안 하고 끝
//  ② 일: 트랜잭션 밖에서 오래 걸리는 일(지금은 전부 STUB)
//  ③ 끝: advance() 한 번 + 다음 큐 작업 + 감사 (같은 트랜잭션)
// 승인 뒤 단계(LOCKED_STAGES)는 환경 잠금도 같이 다룬다 (설계 5.4, P-3 수정):
//  ① 안에서 두 환경 잠금 인수(reserved → worker:<id>, 90초). 못 쥐면 일을 시작하지 않는다(job.rejected)
//  ② 동안 생존 신호(30초마다 연장). 잠금을 잃으면 signal이 abort되고 ③을 하지 않는다
//  ③ advance에 fence(두 환경 모두 내가 기한 안에 쥠) + 같은 트랜잭션에서 반납(reserved, 10분) → 다음 작업이 인수
//  ②가 예외로 끝나면 잠금을 반납해 재시도(다른 워커일 수도)가 바로 인수하게 한다
// Z36 (Z12-4·6·7):
//  - 잠금 줄에 pg-boss 작업 id·큐를 적는다 → 워커가 죽으면 청소가 그 작업을 실패 처리 (같은 작업 키가 15분 active로 안 남음)
//  - ②든 ③이든 예외로 끝나면(남이 옮긴 경우·잠금 잃은 경우 빼고) 잠금을 따로 반납 + job.failed 감사 1줄
//    → ③의 전이 조건 실패(GuardFailed)도 더는 잠금을 "살아 있는 워커 이름"으로 남기지 않는다(예전: 90초 뒤 WORKER_LOST로 잘못 기록)
//    → 청소가 "안 집힘(JOB_NOT_PICKED)"과 "집혔다가 실패(STEP_FAILED)"를 가른다
// Z43: ①②③을 recheckAndLock / doWork / finish 세 함수로, 예외 갈래를 handleStepError 하나로 나눴다 (동작 그대로)

export interface StepJob { tenantId: string; requestId: string; migrationId: string }

export interface MigrationRow {
  id: string; status: MigrationStatus; sourceEnvId: string; targetEnvId: string;
}

export type NextJob = { queue: QueueName; data: object; opts?: Record<string, unknown> };

export interface StepOutcome {
  to: MigrationStatus;                                   // 다음 상태
  next?: NextJob;
  detail?: Record<string, unknown>;                      // 감사 detail (결과 계약 모양)
  inTx?: (tx: Tx) => Promise<void>;                      // ③ 안에서 같이 할 DB 쓰기
  evidence?: TransitionEvidence;                         // 전이 조건(guard)에 넘길 증거. 감사 detail에 남는다
  failureCode?: FailureCodeLike;                         // → failed / paused 일 때 이유 (목록: core failure-codes.ts)
}

// L = ①에서 읽어 ②로 넘기는 값의 타입. load가 없으면 undefined (Z43: 예전엔 unknown이라 처리기마다 `as`로 바꿔 썼다)
export interface StepDef<J extends StepJob, L = undefined> {
  name: string;                     // 감사 action 앞부분 (예: deploy)
  expect: MigrationStatus;          // 이 작업이 기대하는 상태
  // ①에서 같이 읽을 것 (계획서 등). 재확인에 실패하면 null을 돌려 no-op
  load?: (tx: Tx, job: J, m: MigrationRow) => Promise<L | null>;
  work: (job: J, m: MigrationRow, loaded: L, ctx: StepCtx) => Promise<StepOutcome>;
  lock?: boolean;                   // 기본: expect가 LOCKED_STAGES면 true
  // ②가 예외로 끝났을 때 상태로 바꿀지. StepOutcome을 주면 ③을 그대로 한다 (예: apply 실패 → failed).
  // null이면 예외를 다시 던져 pg-boss 재시도에 맡긴다
  onError?: (e: unknown, job: J) => Promise<StepOutcome | null>;
}

export type StepResult = "advanced" | "skipped";

// 환경 잠금을 쥐고 일하는 단계. 정의는 core states.ts 한 곳 (예전 이름으로도 쓸 수 있게 다시 내보낸다)
export { LOCKED_STAGES };
// 잠금 주인 이름. 같은 프로세스의 작업은 같은 이름을 쓴다 (같은 주인의 재인수는 허용)
export const WORKER_HOLDER = `worker:${process.env.WORKER_ID ?? `${hostname()}-${process.pid}`}`;

export interface StepCtx { signal?: AbortSignal }   // 잠금을 잃으면 abort (Terraform이면 SIGINT를 보낸다)

class LockNotAcquired extends Error {}
class StartedBefore extends Error {}   // Z32: 앞 시도가 일을 시작한 채 끝났다(죽음). START_ONLY_RETRY 단계는 다시 하지 않는다

// ── 작은 도움 함수 (Z43: 처리기마다 같은 줄이 반복되던 것) ─────────────────────────────
/** 예외 → 감사·detail에 넣을 한 줄 (기본 500자) */
export const errorMessage = (e: unknown, max = 500) => ((e as Error)?.message ?? String(e)).slice(0, max);
/** 다음 단계 작업 내용. 모든 이전 단계 작업은 이 셋만 싣는다 */
export const jobData = (j: StepJob) => ({ tenantId: j.tenantId, requestId: j.requestId, migrationId: j.migrationId });
/** 다음 단계 작업. 작업 키(singletonKey)는 advance()가 core jobKey() 한 곳에서 붙인다 ("<큐>:<이전 번호>").
 *  opts는 startAfter처럼 키 말고 다른 것을 줄 때, 또는 키를 일부러 다르게 쓸 때만 */
export const nextJob = (queue: QueueName, j: StepJob, opts?: Record<string, unknown>): NextJob =>
  ({ queue, data: jobData(j), ...(opts ? { opts } : {}) });

// ── Z19 H4: 실패한 작업이 이전을 조용히 멈춰 세우지 않게 ─────────────────────────────
// 예전: 처리기가 던지면 pg-boss 재시도(대부분 1번, 대기 0초)를 다 쓴 뒤 작업만 failed가 되고, 이전은 그 상태에 영원히 남았다(화면 표시 없음).
// 이제: ① 지금 몇 번째 시도인지 main.ts가 jobAttempt에 넣어 준다. ② 마지막 시도가 실패하면 이전을 사람이 볼 상태로 옮긴다
//       (failed 길이 있으면 failed, 없으면 paused. 리퍼 decideReap과 같은 규칙 = core failureEdge). failure_code = JOB_FAILED_<단계>
export interface JobAttempt { queue: string; retryCount: number; retryLimit: number }
export const jobAttempt = new AsyncLocalStorage<JobAttempt>();
// 처리기를 직접 부르는 시험처럼 jobAttempt가 없으면 "마지막 아님" (예전 동작 그대로)
// Z32: START_ONLY_RETRY 단계(apply·sync·cutover)는 재시도 1번이 "시작 전 워커 사망용"이라 처리기 예외는 첫 시도도 마지막으로 친다
export const isLastAttempt = () => {
  const a = jobAttempt.getStore();
  return !!a && (a.retryCount >= a.retryLimit || START_ONLY_RETRY.has(a.queue));
};

/** 정해진 대기 뒤 같은 단계를 다시 하게 한다 (pg-boss 재시도는 대기가 고정·지터라 5·15·45초 같은 간격을 못 준다).
 *  runStep이 잠금을 반납하고, 같은 큐에 startAfter로 새 작업을 넣고, 상태는 그대로 둔다 → "skipped" */
export class RetryLater extends Error {
  constructor(readonly queue: QueueName, readonly data: object, readonly delaySec: number, readonly detail: Record<string, unknown> = {}) {
    super(`retry ${queue} in ${delaySec}s`);
  }
}
const isMoved = (e: unknown) => (e as { code?: string } | null)?.code === "MIGRATION_MOVED";


async function markJobDead(job: StepJob, def: { name: string; expect: MigrationStatus }, e: unknown): Promise<boolean> {
  const to = failureEdge(def.expect);
  const a = jobAttempt.getStore();
  const msg = errorMessage(e);
  return withTenant(job.tenantId, async (tx) => {
    if (!to) {
      await writeAudit(tx, job.tenantId, { actor: "worker", action: `${def.name}.job_dead`, target: job.migrationId, result: "error",
        detail: { requestId: job.requestId, error: msg, queue: a?.queue, retryCount: a?.retryCount, note: `no failed/paused edge from ${def.expect}` } });
      return false;
    }
    // ifStill: 그 사이 상태가 바뀌었으면 아무것도 안 한다
    // Z36 (Z12-7): 전이 조건 실패도 JOB_FAILED_<단계>로 둔다(Z19 규칙). 어느 조건인지는 감사 detail.error·detail.guard
    return advance(tx, { id: job.migrationId, tenantId: job.tenantId }, def.expect, to, {
      mode: "ifStill", failureCode: jobFailedCode(def.name),
      audit: { actor: "worker", action: `${def.name}.${to}`, target: job.migrationId, result: "error",
        detail: { requestId: job.requestId, error: msg, queue: a?.queue, retryCount: a?.retryCount, retryLimit: a?.retryLimit, by: "dead-letter",
          ...(e instanceof GuardFailed ? { guard: true } : {}) } },
    });
  });
}
const envsOf = (m: MigrationRow) => [...new Set([m.sourceEnvId, m.targetEnvId])].sort();

// DRAFT(ai): STUB 작업이 "일하는 척" 기다리는 시간. 데모·smoke가 너무 빨리 끝나 화면에서 안 보이는 걸 막는 용도
export const STUB_DELAY_MS = envNumber(process.env.STUB_DELAY_MS, 200);
export const stubWait = (ms = STUB_DELAY_MS) => new Promise((r) => setTimeout(r, ms));

export async function readMigration(tx: Tx, id: string): Promise<MigrationRow | null> {
  const q = await tx.query(
    `SELECT id, status, source_env_id AS "sourceEnvId", target_env_id AS "targetEnvId"
       FROM migrations WHERE id = $1`, [id]);
  return (q.rows[0] as MigrationRow | undefined) ?? null;
}

// 한 작업 동안 단계 함수들이 같이 쓰는 값
interface StepRun<J extends StepJob, L> {
  job: J; def: StepDef<J, L>; useLock: boolean; m: MigrationRow; loaded: L; envIds: string[];
}

export async function runStep<J extends StepJob, L = undefined>(job: J, def: StepDef<J, L>, takeoverWaited = false): Promise<StepResult> {
  const useLock = def.lock ?? LOCKED_STAGES.includes(def.expect);
  const pre = await recheckAndLock(job, def, useLock, takeoverWaited);
  if (pre === "skipped") return "skipped";
  if (pre === "retry") return runStep(job, def, true);   // Z32 4차: 앞 시도 잠금 기한까지 기다린 뒤 한 번만 다시
  const run: StepRun<J, L> = { job, def, useLock, ...pre, envIds: envsOf(pre.m) };
  try {
    return await workAndFinish(run);
  } catch (e) {
    return handleStepError(run, e);
  }
}

// ① 재확인 (회사 벽 안에서 다시 읽기) + 잠금 인수
async function recheckAndLock<J extends StepJob, L>(job: J, def: StepDef<J, L>, useLock: boolean, takeoverWaited: boolean):
  Promise<{ m: MigrationRow; loaded: L } | "skipped" | "retry"> {
  let pre: { m: MigrationRow; loaded: L } | null;
  try {
    pre = await withTenant(job.tenantId, async (tx) => {
      const m = await readMigration(tx, job.migrationId);
      if (!m || m.status !== def.expect) return null;      // 두 번 온 작업·이미 지나간 작업
      const loaded = def.load ? await def.load(tx, job, m) : (undefined as L);
      if (def.load && loaded === null) return null;
      // Z32: START_ONLY_RETRY 단계의 재시도인데 앞 시도가 이미 시작했다(잠금에 같은 작업 번호, 또는 실패 감사가 있음) → 다시 하지 않는다
      const a = jobAttempt.getStore(), ref = jobRef(def.name);
      if (a && a.retryCount > 0 && START_ONLY_RETRY.has(a.queue) && ref.jobId) {
        const q = await tx.query(
          `SELECT 1 FROM env_locks WHERE migration_id = $1 AND job_id = $2::uuid
           UNION ALL SELECT 1 FROM audit_events WHERE target = $3 AND action = 'job.failed' AND detail->>'jobId' = $4 LIMIT 1`,
          [m.id, ref.jobId, m.id, ref.jobId]);
        if (q.rowCount) throw new StartedBefore(ref.jobId);
      }
      if (useLock) for (const envId of envsOf(m)) {
        const ok = await acquireEnvLock(tx, { migrationId: m.id, envId, holder: WORKER_HOLDER, ...jobRef(def.name) });
        if (!ok) throw new LockNotAcquired(envId);           // 한쪽만 쥔 채로 남지 않게 트랜잭션째 취소
      }
      return { m, loaded: loaded as L };
    });
  } catch (e) {
    if (e instanceof StartedBefore) {
      // 잠금은 죽은 앞 시도 이름 그대로 둔다 → 기한(90초) 뒤 청소 작업이 WORKER_LOST + 울타리 복구(Z36)
      await auditSkip(job, def.name, { reason: "previous_attempt_started", jobId: e.message });
      return "skipped";
    }
    if (!(e instanceof LockNotAcquired)) throw e;
    // Z32 4차: 죽은 앞 시도(같은 작업 번호)의 잠금인데 아직 selfFence 시간이 안 지났다 → 그만큼 기다렸다 한 번만 다시
    const jobId = jobRef(def.name).jobId;
    if (!takeoverWaited && jobId) {
      const wait = await withTenant(job.tenantId, (tx) => sameJobTakeoverWaitSec(tx, job.migrationId, jobId));
      if (wait !== null) {
        log.info({ wait_sec: Math.ceil(wait) }, "waiting for previous attempt's lease before takeover");
        await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 500));
        return "retry";
      }
    }
    await auditSkip(job, def.name, { reason: "env_lock_not_acquired", envId: e.message });
    return "skipped";
  }
  if (!pre) {
    log.info({ expected_state: def.expect }, "job skipped: state already moved");
    await auditSkip(job, def.name);
    return "skipped";
  }
  return pre;
}

// ②·③ 밖으로 나온 예외 갈래. 순서가 의미 있다 (위가 먼저)
async function handleStepError<J extends StepJob, L>(run: StepRun<J, L>, e: unknown): Promise<StepResult> {
  const { job, def } = run;
  if (e instanceof LeaseLost) throw e;                           // 남이 쥔 이전은 건드리지 않는다
  if (e instanceof RetryLater) {
    // Z19 H4: 정해진 대기 뒤 다시. 잠금은 workAndFinish가 이미 reserved로 반납했다
    await withTenant(job.tenantId, async (tx) => {
      const key = jobKey(e.queue, { migrationId: job.migrationId });
      await boss.send(e.queue, e.data, { ...(key ? { singletonKey: key } : {}), startAfter: e.delaySec, db: asBossDb(tx) });
      await writeAudit(tx, job.tenantId, { actor: "worker", action: `${def.name}.retry_scheduled`, target: job.migrationId,
        result: "error", detail: { requestId: job.requestId, delaySec: e.delaySec, ...e.detail } });
    });
    log.info({ delay_sec: e.delaySec }, "job retry scheduled");
    return "skipped";
  }
  if (isMoved(e)) {
    // Z19 H3: 일하는 동안 다른 쪽(롤백·일시정지)이 상태를 먼저 옮겼다. 바깥 일은 되돌렸거나 안 했다. 상태는 건드리지 않는다
    await auditSkip(job, def.name, { reason: "migration_moved", now: (e as { status?: string }).status });
    return "skipped";
  }
  // ③에서 죽었으면 아직 쥐고 있다 (Z12-7). ②에서 죽었으면 doWork가 이미 반납 → 여기선 바뀌는 줄 0, 감사만
  if (run.useLock) await handBack(job, run.envIds, { job: def.name, stage: def.expect, error: errorMessage(e),
    ...(e instanceof GuardFailed ? { code: "GUARD_FAILED" } : {}) }).catch(() => undefined);
  if (isLastAttempt()) {
    const moved = await markJobDead(job, def, e).catch((x) => { log.error({ err: x }, "dead-letter failed"); return false; });
    log.error({ err: e, dead_letter: moved }, "job exhausted retries");
  }
  throw e;                                                     // pg-boss가 작업을 실패(또는 재시도)로 적게 그대로 던진다
}

async function workAndFinish<J extends StepJob, L>(run: StepRun<J, L>): Promise<StepResult> {
  const out = await doWork(run);
  return finish(run, out);
}

// ② 일 (트랜잭션 밖). 잠금을 쥔 단계는 생존 신호를 돌린다
async function doWork<J extends StepJob, L>(run: StepRun<J, L>): Promise<StepOutcome> {
  const { job, def, useLock, envIds } = run;
  let hb: Heartbeat | undefined;
  if (useLock) hb = startHeartbeat({ tenantId: job.tenantId, migrationId: job.migrationId, envIds, holder: WORKER_HOLDER });
  let out: StepOutcome;
  try {
    out = await def.work(job, run.m, run.loaded, { signal: hb?.signal });
  } catch (e) {
    const alt = hb?.signal.aborted || !def.onError || e instanceof RetryLater || isMoved(e) ? null : await def.onError(e, job);
    if (!alt) {
      hb?.stop();
      // Z19 H3: 상태가 이미 옮겨졌으면(MigrationMoved) 잠금도 옮긴 쪽 것이다. 같은 프로세스의 rollback 작업은 같은 주인 이름이라
      // 여기서 반납하면 그 작업의 잠금을 빼앗는다 → 반납하지 않는다
      if (useLock && !hb?.signal.aborted && !isMoved(e)) await handBack(job, envIds).catch(() => undefined);
      // Z36: 잠금을 잃은 채 실패했으면 LeaseLost로 바꿔 던진다 → runStep이 반납·죽은 작업 처리를 하지 않는다(남의 잠금·상태)
      if (hb?.signal.aborted) { log.warn({ err: e }, "work failed after lease lost"); throw new LeaseLost(job.migrationId); }
      throw e;
    }
    out = alt;
  }
  hb?.stop();
  if (hb?.signal.aborted) throw new LeaseLost(job.migrationId);   // 잠금을 잃은 워커는 상태를 옮기지 않는다
  return out;
}

// ③ 끝: 상태 한 칸 + 다음 작업 + 감사 (+ 잠금 확인·반납), 한 트랜잭션
class LostRaceRollback extends Error { constructor() { super("transition lost race: in-step writes rolled back"); } }
async function finish<J extends StepJob, L>(run: StepRun<J, L>, out: StepOutcome): Promise<StepResult> {
  const { job, def, useLock, envIds } = run;
  // Z32 (Z83 10차 지적): inTx(계획서 저장 등)는 advance 앞에서 돈다. advance 가 졌는데(ifStill → false, 다른 배달이 먼저 옮김)
  //   그대로 확정하면 진 쪽의 쓰기가 남는다. 예: plan 이 두 번 배달되면 늦은 쪽의 새 plans 행이 남아 최신 계획이 바뀌고,
  //   화면이 든 첫 계획 승인이 409 PLAN_SUPERSEDED 가 된다. 이제 졌으면 이 트랜잭션을 통째로 취소하고 잠금 반납만 따로 한다
  let rolledBack = false;
  const moved = await withTenant(job.tenantId, async (tx) => {
    // M2: 잠금 순서(이전 행 → 환경 잠금 → 큐 → 감사)를 지키려고 inTx보다 먼저 행을 잠근다.
    // inTx가 writeAudit(회사 감사 자문 잠금)를 부르면, 예전엔 감사 잠금 → 행 잠금 순서가 되어
    // API 롤백·취소(행 → 감사)와 교착(40P01)할 수 있었다. advance가 같은 행을 다시 잠가도 같은 트랜잭션이라 괜찮다
    await tx.query("SELECT 1 FROM migrations WHERE id = $1 FOR UPDATE", [job.migrationId]);
    if (out.inTx) await out.inTx(tx);
    const ok = await advance(tx, { id: job.migrationId, tenantId: job.tenantId }, def.expect, out.to, {
      mode: "ifStill",
      ...(useLock ? { fence: { envIds, holder: WORKER_HOLDER } } : {}),
      next: out.next,
      evidence: out.evidence,
      failureCode: out.failureCode,
      audit: {
        actor: "worker", action: `${def.name}.${out.to}`, target: job.migrationId, result: "ok",
        detail: { requestId: job.requestId, ...(out.detail ?? {}) },
      },
    });
    if (!ok && out.inTx) throw new LostRaceRollback();
    // 끝 상태면 advance가 이미 지웠다. 롤백 시작이면 advance가 이미 되찾았다. 나머지는 다음 작업에게 넘긴다
    if (useLock) for (const envId of envIds)
      await handBackEnvLock(tx, { migrationId: job.migrationId, envId, holder: WORKER_HOLDER });
    return ok;
  }).catch(async (e) => {
    if (!(e instanceof LostRaceRollback)) throw e;
    rolledBack = true;
    if (useLock) await handBack(job, envIds);   // 취소된 트랜잭션 밖에서 잠금만 반납 (안 하면 기한 90초 뒤 청소가 WORKER_LOST)
    return false;
  });
  // 상태 이동 로그 한 줄. prev_state → state 로 api·worker 로그를 이어 읽는다 (T)
  log.info({ prev_state: def.expect, state: moved ? out.to : def.expect,
    result: moved ? "advanced" : "skipped", ...(out.failureCode ? { failure_code: out.failureCode } : {}),
    ...(rolledBack ? { in_tx_rolled_back: true } : {}) },
    moved ? "transition" : "transition lost race");
  return moved ? "advanced" : "skipped";
}

// 잠금 반납. failed를 주면 같은 트랜잭션에 job.failed 감사 1줄 (Z12-6). runStep의 catch에서 실패 한 번에 한 번만 부른다
// (②에서 실패했으면 doWork가 먼저 반납해 여기선 바뀌는 줄 0, 감사만 남는다)
async function handBack(job: StepJob, envIds: string[], failed?: Record<string, unknown> & { job: string; error: string }) {
  await withTenant(job.tenantId, async (tx) => {
    for (const envId of envIds)
      await handBackEnvLock(tx, { migrationId: job.migrationId, envId, holder: WORKER_HOLDER });
    if (failed) {
      await writeAudit(tx, job.tenantId, { actor: "worker", action: "job.failed", target: job.migrationId, result: "error",
        detail: { requestId: job.requestId, ...failed, ...jobRef(failed.job) } });
    }
  });
}

// Z12-4: 지금 처리 중인 pg-boss 작업 (instrument()가 로그 문맥에 job_id·queue를 넣는다). 시험처럼 직접 부르면 id 없음
function jobRef(fallbackQueue: string): { jobId?: string; jobQueue: string } {
  const c = currentLogContext();
  return { ...(c.job_id ? { jobId: c.job_id } : {}), jobQueue: c.queue ?? fallbackQueue };
}

// 같은 단계가 몇 번 실패했나 (감사 기록 '<name>.attempt_failed'로 센다. 작업 재시도는 pg-boss가, 횟수 판단은 여기서)
// Z36: 이 단계에 들어온 뒤(migrations.updated_at = 마지막 상태 이동) 것만 센다. 재개(paused → 같은 단계)하면 0부터 다시
//      (예전: 재개한 sync가 지난번 실패 횟수를 이어 세서 첫 실패에 바로 자동 롤백)
export async function failedAttempts(job: StepJob, name: string): Promise<number> {
  return withTenant(job.tenantId, async (tx) => {
    const q = await tx.query(
      `SELECT count(*)::int AS n FROM audit_events a
        WHERE a.target = $1 AND a.action = $2
          AND a.at >= (SELECT updated_at FROM migrations WHERE id = $3)`,
      [job.migrationId, `${name}.attempt_failed`, job.migrationId]);
    return q.rows[0].n as number;
  });
}

// Z36 (Z12-5): 데모·시험용 어댑터 실패 스위치 (STUB 길에서만). STUB_FAIL_STEP=deploy,shift,cutover,cleanup 쉼표 목록.
// 실패는 Z19 죽은 작업 처리로 간다: 재시도를 다 쓰면 deploy·shift·cleanup → paused(JOB_FAILED_<단계>), cutover → failed(CUTOVER_ERROR)
// DRAFT(ai): 한 번 재개(migration.resumed)된 이전은 다시 실패하지 않는다 → "실패 → paused → 재개 → 통과"를 워커 재시작 없이 보여 준다
export async function stubFailIfAsked(job: StepJob, name: string) {
  const want = (process.env.STUB_FAIL_STEP ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!want.includes(name)) return;
  const resumed = await withTenant(job.tenantId, async (tx) => (await tx.query(
    `SELECT 1 FROM audit_events WHERE target = $1 AND action = 'migration.resumed' LIMIT 1`, [job.migrationId])).rowCount);
  if (!resumed) throw new Error(`STUB: ${name} adapter failed (STUB_FAIL_STEP=${name})`);
}
export async function recordAttemptFailure(job: StepJob, name: string, d: { attempts: number; max: number; error: string }) {
  await withTenant(job.tenantId, (tx) => writeAudit(tx, job.tenantId, {
    actor: "worker", action: `${name}.attempt_failed`, target: job.migrationId, result: "error",
    detail: { requestId: job.requestId, ...d } }));
}

// 재확인에서 멈춘 작업도 감사에 남긴다 (설계 5.1: job.rejected)
async function auditSkip(job: StepJob, name: string, extra: Record<string, unknown> = {}) {
  await withTenant(job.tenantId, (tx) => writeAudit(tx, job.tenantId, {
    actor: "worker", action: "job.rejected", target: job.migrationId, result: "denied",
    detail: { job: name, requestId: job.requestId, ...extra },
  }));
}

// 키를 재귀로 정렬한 JSON의 sha256 (계획 지문용. 순서에 흔들리지 않게)
export function stableHash(v: unknown): string {
  return createHash("sha256").update(canonical(v)).digest("hex");
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
