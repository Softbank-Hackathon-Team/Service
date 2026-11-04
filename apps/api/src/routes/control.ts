import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { QUEUES, VALID, TERMINAL, FailureDecisionInput, FailureDecisionResult, RETRYABLE_FAILURES, ROLLBACK_ON_REJECT, type MigrationStatus, type QueueName } from "@svc/contracts";
import { randomUUID } from "node:crypto";
import { advance, boss, asBossDb, checkRetryBudget, reclaimEnvLocks, reserveEnvLocks, LEASE, targetTeardownPending, writeAudit, NotFound, DomainError, LOCKED_STAGES, type Tx } from "@svc/core";
import { loadLatestApproval } from "./plan-store.js";
import { RollbackResult, ReclaimResult, CancelResult, errors } from "./responses.js";
import { IdParam, RetryBody, auditOk, found, nextJob } from "./kit.js";

// 사람이 누르는 비상 버튼 둘 (상태 머신 표 기준)
//   POST /migrations/:id/rollback   지금 상태 → rolling_back (+ rollback 작업). 출발로 되돌린다
//   POST /migrations/:id/cancel     지금 상태 → cancelled. 아직 아무것도 안 만든 단계이거나, failed에서 수동 정리를 확인한 뒤
//   POST /migrations/:id/reclaim    rollback_window 를 일찍 끝낸다. 상태는 워커의 cleanup 작업이 옮긴다 (라우트는 advance 없음)
//   POST /migrations/:id/failure-decision  failed 질문의 답 (Jeong 11/4 01:53Z): retry → 실패 지점 상태 + 그 단계 작업 / rollback → rolling_back 또는 cancelled
//   POST /migrations/:id/resume     paused → 멈추기 전 단계(paused_from) + 그 단계 작업 다시 넣기 (Z12-3, Z36)
//   POST /migrations/:id/replication-cleanup  끝난 이전(TERMINAL)의 남은 복제 객체 다시 걷기. 상태 안 바꿈(advance 없음), repl-cleanup 작업만 (F8-5)
// 상태를 바꾸는 POST 하나 = advance() 한 번. 끝 상태가 되면 advance()가 환경 잠금을 푼다

const ReasonBody = z.object({ reason: z.string().max(500).optional() }).strict();
const CancelBody = ReasonBody.extend({
  // failed에서 취소할 때만 필요 (T38): 만들다 만 자원을 사람이 정리했다고 확인
  manualCleanupConfirmed: z.boolean().optional(),
}).strict();

const ResumeBody = ReasonBody.extend({
  // 가드레일 규칙으로 멈춘 경우(failure_code 없음)만 필요 (T31/T32): 규칙 위반이 풀렸다고 사람이 확인
  ruleCleared: z.boolean().optional(),
  ...RetryBody.shape,   // PA5a: 재시도 한도 이상이면 acceptCustomerCost:true
}).strict();

// 재개할 때 다시 넣는 작업. 작업 키는 워커가 다음 단계를 넣을 때와 같은 모양(<queue>:<id>)
// paused로 올 수 있는 단계 = 상태표 VALID[paused]에서 rolling_back을 뺀 넷
export const RESUME_QUEUE: Partial<Record<MigrationStatus, QueueName>> = {
  deploying: QUEUES.deploy, syncing: QUEUES.sync, shifting: QUEUES.shift, cleanup: QUEUES.cleanup,
};

// DRAFT(ai) Jeong 11/4 01:53Z: failed "재시도" 때 실패 지점마다 다시 넣는 작업 (워커 재시도 재개 지점).
//   import·precheck·cutover 는 이전 번호만, plan 은 새 계획 번호, apply 는 마지막 승인 계획(번호·지문), rollback 은 롤백 작업 그대로
//   복제는 새 함수 없이 단계 작업을 다시 넣는다 (handleSync 멱등, E pf08). 배포 뒤 단계(deploying·syncing·shifting·cleanup)는 paused → /resume
export const RETRY_QUEUE: Partial<Record<MigrationStatus, QueueName>> = {
  "importing": QUEUES.import, "prechecking": QUEUES.precheck, "planning": QUEUES.plan,
  "provisioning": QUEUES.apply, "cutover": QUEUES.cutover, "rolling_back": QUEUES.rollback,
};

async function statusOf(tx: Tx, id: string): Promise<MigrationStatus> {
  return (await rowOf(tx, id)).status;
}
async function rowOf(tx: Tx, id: string) {
  const q = await tx.query(
    `SELECT status, paused_from AS "pausedFrom", failure_code AS "failureCode", failed_at_status AS "failedAtStatus",
            target_env_id AS "targetEnvId" FROM migrations WHERE id=$1 FOR UPDATE`, [id]);
  return found(q.rows[0] as { status: MigrationStatus; pausedFrom: MigrationStatus | null; failureCode: string | null;
    failedAtStatus: MigrationStatus | null; targetEnvId: string } | undefined, "migration", id);
}

// Jeong 11/4 01:53Z: 실패 질문의 답(재시도·롤백) 전에 이 이전의 출발·도착 잠금을 예약으로. provisioning 실패는 잠금을 풀었으므로 새로 잡는다
async function relock(tx: Tx, tenantId: string, id: string) {
  if (await reclaimEnvLocks(tx, id) > 0) return;
  const e = (await tx.query<{ s: string; t: string }>("SELECT source_env_id AS s, target_env_id AS t FROM migrations WHERE id = $1", [id])).rows[0]!;
  const until = new Date(Date.now() + LEASE.handBackSec * 1000);
  await reserveEnvLocks(tx, { id, tenantId }, [e.s, e.t], until);
}

function mustAllow(from: MigrationStatus, to: MigrationStatus) {
  if (!VALID[from].includes(to))
    throw new DomainError(409, "INVALID_TRANSITION", `${from} → ${to} not allowed`);
}

export async function controlRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/migrations/:id/rollback", { schema: { params: IdParam, body: ReasonBody.nullish(),
    response: { 202: RollbackResult, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      const from = await statusOf(tx, id);
      mustAllow(from, "rolling_back");
      await advance(tx, { id, tenantId: req.tenantId }, from, "rolling_back", {
        evidence: { reason: req.body?.reason },
        next: nextJob(req, QUEUES.rollback, id),
        audit: auditOk(req, "migration.rolling_back", id, { from, reason: req.body?.reason }),
      });
      return { status: 202, body: { id, from, status: "rolling_back" } };
    });
  });

  // 리소스 회수. 창 끝 시각을 지금으로 당기면 이 뒤의 롤백은 가드가 막고, cleanup 작업의 창 검사는 통과한다.
  // cutover 가 넣어 둔 cleanup 작업이 같은 키로 기다리고 있어 새로 넣지 못하므로 그 작업의 시작 시각을 당긴다.
  r.post("/migrations/:id/reclaim", { schema: { params: IdParam, body: ReasonBody.nullish(),
    response: { 202: ReclaimResult, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      const from = await statusOf(tx, id);
      if (from !== "rollback_window") throw new DomainError(409, "INVALID_TRANSITION", `${from} → cleanup not allowed`);
      const ended = await tx.query<{ at: string }>(
        `UPDATE migrations SET rollback_window_ends_at = LEAST(rollback_window_ends_at, now()), updated_at = now()
          WHERE id = $1 RETURNING to_char(rollback_window_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`, [id]);
      const singletonKey = `${QUEUES.cleanup}:${id}`;
      const woken = await tx.query(
        `UPDATE pgboss.job SET start_after = now() WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry')`,
        [QUEUES.cleanup, singletonKey]);
      if (woken.rowCount === 0) {
        await boss.send(QUEUES.cleanup, { tenantId: req.tenantId, requestId: req.id, migrationId: id },
          { singletonKey, db: asBossDb(tx) });
      }
      await writeAudit(tx, req.tenantId, { actor: req.actor, action: "migration.reclaim_requested", target: id, result: "ok",
        detail: { reason: req.body?.reason, jobWoken: (woken.rowCount ?? 0) > 0 } });
      return { status: 202, body: { id, status: "rollback_window" as const, windowEndsAt: ended.rows[0]!.at } };
    });
  });

  // 재개. 같은 Idempotency-Key로 다시 오면 첫 응답을 그대로 돌려준다(작업도 1개). 키 없이 두 번 누르면 두 번째는 409 NOT_PAUSED
  // DRAFT(ai): 실패 코드로 멈춘 경우(WORKER_LOST·STEP_FAILED·<단계>_FAILED·GUARD_FAILED 등) "재개를 누름 = 원인 확인"으로 본다(ruleCleared 자동).
  //   가드레일 규칙으로 멈춘 경우(failure_code 없음)는 본문 ruleCleared:true가 있어야 한다. TODO(human): 재개 권한을 승인자로 좁힐지
  r.post("/migrations/:id/resume", { schema: { params: IdParam, body: ResumeBody.nullish() } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      const m = await rowOf(tx, id);
      if (m.status !== "paused")
        throw new DomainError(409, "NOT_PAUSED", `migration is ${m.status}, not paused`);
      const to = m.pausedFrom;
      const queue = to ? RESUME_QUEUE[to] : undefined;
      if (!to || !queue) throw new DomainError(409, "INVALID_TRANSITION", `paused_from ${to ?? "?"}: nothing to resume`);
      const ruleCleared = m.failureCode ? true : req.body?.ruleCleared === true;
      // PA5a: 실패 코드로 멈춘 경우만 "실패 재시도"로 센다 (가드레일 규칙 멈춤은 실패가 아님). 한도 이상이면 acceptCustomerCost 필요
      const budget = m.failureCode ? await checkRetryBudget(tx, id, req.body?.acceptCustomerCost) : null;
      // 남은 잠금(죽은 워커 이름·기한 지난 예약)을 예약 10분으로 되돌린다 → 새 작업이 바로 인수. 10분 안에 안 집히면 청소가 다시 paused
      const relocked = await reclaimEnvLocks(tx, id);
      if (relocked === 0) throw new DomainError(409, "ENV_LOCK_MISSING", "no env lock left for this migration (cancel or roll back)");
      await advance(tx, { id, tenantId: req.tenantId }, "paused", to, {
        evidence: { ruleCleared, reason: req.body?.reason },
        audit: { actor: req.actor, action: "migration.resumed", target: id, result: "ok",
                 detail: { to, pausedFailureCode: m.failureCode, reason: req.body?.reason } },
      });
      // 작업은 advance의 next가 아니라 따로 넣는다: 같은 작업 키가 이미 대기(created·retry) 중이면 send가 null인데,
      // 그 작업이 곧 같은 일을 하므로 재개는 성공으로 본다 (advance next면 JobNotCreated로 재개 자체가 취소된다)
      const jobId = await boss.send(queue, { tenantId: req.tenantId, requestId: req.id, migrationId: id },
        { singletonKey: `${queue}:${id}`, db: asBossDb(tx) });
      if (budget)
        await writeAudit(tx, req.tenantId, { actor: req.actor, action: "migration.retried", target: id, result: "ok",
          detail: { via: "resume", pausedFrom: to, failureCode: m.failureCode, attempt: budget.attempt,
                    customerCostAccepted: budget.customerCostAccepted } });
      return { status: 202, body: { id, from: "paused" as const, status: to, queue, jobQueued: jobId !== null } };
    });
  });

  // Jeong 결정 11/4 01:53Z: 실패 → (트래픽 출발로, 워커) → AI 원인 분석(advance analyze) → 사람에게 "재시도할까?" = 이 버튼.
  //   상태를 바꾸는 POST 하나 = advance() 한 번. failed 가 아니거나 고른 길이 표·가드에 없으면 409 INVALID_TRANSITION
  r.post("/migrations/:id/failure-decision", { schema: { params: IdParam, body: FailureDecisionInput,
    response: { 202: FailureDecisionResult, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      const m = await rowOf(tx, id);
      const { choice, reason } = req.body;
      const at = m.failedAtStatus;
      if (m.status !== "failed")
        throw new DomainError(409, "INVALID_TRANSITION", `migration is ${m.status}, not failed: nothing to decide`);
      if (choice === "retry") {
        const queue = at ? RETRY_QUEUE[at] : undefined;
        if (!at || !queue || !RETRYABLE_FAILURES.includes(at))
          throw new DomainError(409, "INVALID_TRANSITION", `failed at ${at ?? "?"}: no step to retry (rollback instead)`);
        mustAllow("failed", at);
        // 예전 길(11/3 자동 지우기)로 지우는 중이면 새 apply 가 같은 작업 폴더를 쓰지 않게 기다린다
        if (at === "provisioning" && await targetTeardownPending(tx, id))
          throw new DomainError(409, "TEARDOWN_PENDING", "target resources are still being deleted; retry after it finishes");
        const budget = await checkRetryBudget(tx, id, req.body.acceptCustomerCost);
        // 잠금을 쥐고 하는 단계면 잠금을 예약으로 (남은 줄은 되돌리고, 실패 때 풀렸으면 다시 예약. 남이 잡았으면 409 ENV_BUSY)
        if (LOCKED_STAGES.includes(at)) await relock(tx, req.tenantId, id);
        let extra: Record<string, unknown> = {};
        let singletonKey = `${queue}:${id}`;
        if (at === "planning") extra = { planId: randomUUID() };
        if (at === "provisioning") {
          const appr = await loadLatestApproval(tx, id);
          if (!appr) throw new DomainError(409, "PLAN_NOT_APPROVED", "no approved plan to apply again");
          extra = { planId: appr.planId, planHash: appr.planHash };
          singletonKey = `apply:${m.targetEnvId}`;   // 설계 5.3: apply 는 도착 환경 단위로 하나씩 (/start 와 같은 키)
        }
        await advance(tx, { id, tenantId: req.tenantId }, "failed", at, {
          evidence: { failureDecision: "retry", reason },
          audit: { actor: req.actor, action: "migration.failure_retry", target: id, result: "ok",
                   detail: { requestId: req.id, failedAtStatus: at, failureCode: m.failureCode, reason } },
        });
        // 작업은 따로 넣는다 (resume 과 같음): 같은 키가 이미 대기 중이면 그 작업이 같은 일을 한다
        const jobId = await boss.send(queue, { tenantId: req.tenantId, requestId: req.id, migrationId: id, ...extra },
          { singletonKey, db: asBossDb(tx) });
        await writeAudit(tx, req.tenantId, { actor: req.actor, action: "migration.retried", target: id, result: "ok",
          detail: { via: "failure-decision", failedAtStatus: at, failureCode: m.failureCode, attempt: budget.attempt,
                    customerCostAccepted: budget.customerCostAccepted } });
        const body: FailureDecisionResult = { id, from: "failed", choice, status: at, queue, jobQueued: jobId !== null };
        return { status: 202, body };
      }
      // 거절: 만든 자원이 있으면 롤백(트래픽 출발 → 복제 걷기 → rolled_back → 도착 지우기), 없으면 cancelled
      const to: MigrationStatus = at && ROLLBACK_ON_REJECT.includes(at) ? "rolling_back" : "cancelled";
      mustAllow("failed", to);
      if (to === "rolling_back") await relock(tx, req.tenantId, id);   // 롤백 작업도 잠금을 쥐고 일한다
      await advance(tx, { id, tenantId: req.tenantId }, "failed", to, {
        evidence: { failureDecision: "rollback", reason },
        ...(to === "rolling_back" ? { next: nextJob(req, QUEUES.rollback, id) } : {}),
        audit: { actor: req.actor, action: `migration.failure_${to === "rolling_back" ? "rollback" : "cancel"}`, target: id, result: "ok",
                 detail: { requestId: req.id, failedAtStatus: at, failureCode: m.failureCode, reason } },
      });
      const body: FailureDecisionResult = { id, from: "failed", choice, status: to,
                                            queue: to === "rolling_back" ? QUEUES.rollback : null, jobQueued: to === "rolling_back" };
      return { status: 202, body };
    });
  });

  // F8-5: 롤백 걷기가 실패하면(감사 rollback.cleanup_incomplete) 원인을 고친 뒤 사람이 다시 누른다. 상태는 그대로라 advance 를 안 부른다.
  // 같은 작업 키가 이미 대기 중이면 새로 안 넣고(jobQueued:false) 그 작업이 같은 일을 한다.
  // DRAFT(ai): 끝 상태만 받는다. failed 는 뒤에 rolling_back·prechecking 으로 움직일 수 있어 그 작업과 겹치지 않게 409
  r.post("/migrations/:id/replication-cleanup", { schema: { params: IdParam, body: ReasonBody.nullish() } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      const status = await statusOf(tx, id);
      if (!TERMINAL.includes(status))
        throw new DomainError(409, "NOT_FINISHED", `migration is ${status}; replication cleanup runs only after ${TERMINAL.join("/")}`);
      const jobId = await boss.send(QUEUES.replCleanup, { tenantId: req.tenantId, requestId: req.id, migrationId: id },
        { singletonKey: `${QUEUES.replCleanup}:${id}`, db: asBossDb(tx) });
      await writeAudit(tx, req.tenantId, { actor: req.actor, action: "replication.cleanup_requested", target: id, result: "ok",
        detail: { status, reason: req.body?.reason, jobQueued: jobId !== null } });
      return { status: 202, body: { id, status, jobQueued: jobId !== null } };
    });
  });

  r.post("/migrations/:id/cancel", { schema: { params: IdParam, body: CancelBody.nullish(),
    response: { 200: CancelResult, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      const from = await statusOf(tx, id);
      mustAllow(from, "cancelled");
      await advance(tx, { id, tenantId: req.tenantId }, from, "cancelled", {
        evidence: { reason: req.body?.reason, manualCleanupConfirmed: req.body?.manualCleanupConfirmed },
        audit: auditOk(req, "migration.cancelled", id, { from, reason: req.body?.reason }),
      });
      return { status: 200, body: { id, from, status: "cancelled" } };
    });
  });
}
