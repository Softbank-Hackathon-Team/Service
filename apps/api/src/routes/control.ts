import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { QUEUES, VALID, type MigrationStatus, type QueueName } from "@svc/contracts";
import { advance, boss, asBossDb, reclaimEnvLocks, writeAudit, NotFound, DomainError, type Tx } from "@svc/core";
import { RollbackResult, ReclaimResult, CancelResult, errors } from "./responses.js";
import { IdParam, auditOk, found, nextJob } from "./kit.js";

// 사람이 누르는 비상 버튼 둘 (상태 머신 표 기준)
//   POST /migrations/:id/rollback   지금 상태 → rolling_back (+ rollback 작업). 출발로 되돌린다
//   POST /migrations/:id/cancel     지금 상태 → cancelled. 아직 아무것도 안 만든 단계이거나, failed에서 수동 정리를 확인한 뒤
//   POST /migrations/:id/reclaim    rollback_window 를 일찍 끝낸다. 상태는 워커의 cleanup 작업이 옮긴다 (라우트는 advance 없음)
//   POST /migrations/:id/resume     paused → 멈추기 전 단계(paused_from) + 그 단계 작업 다시 넣기 (Z12-3, Z36)
// 상태를 바꾸는 POST 하나 = advance() 한 번. 끝 상태가 되면 advance()가 환경 잠금을 푼다

const ReasonBody = z.object({ reason: z.string().max(500).optional() }).strict();
const CancelBody = ReasonBody.extend({
  // failed에서 취소할 때만 필요 (T38): 만들다 만 자원을 사람이 정리했다고 확인
  manualCleanupConfirmed: z.boolean().optional(),
}).strict();

const ResumeBody = ReasonBody.extend({
  // 가드레일 규칙으로 멈춘 경우(failure_code 없음)만 필요 (T31/T32): 규칙 위반이 풀렸다고 사람이 확인
  ruleCleared: z.boolean().optional(),
}).strict();

// 재개할 때 다시 넣는 작업. 작업 키는 워커가 다음 단계를 넣을 때와 같은 모양(<queue>:<id>)
// paused로 올 수 있는 단계 = 상태표 VALID[paused]에서 rolling_back을 뺀 넷
export const RESUME_QUEUE: Partial<Record<MigrationStatus, QueueName>> = {
  deploying: QUEUES.deploy, syncing: QUEUES.sync, shifting: QUEUES.shift, cleanup: QUEUES.cleanup,
};

async function statusOf(tx: Tx, id: string): Promise<MigrationStatus> {
  return (await rowOf(tx, id)).status;
}
async function rowOf(tx: Tx, id: string) {
  const q = await tx.query(
    `SELECT status, paused_from AS "pausedFrom", failure_code AS "failureCode" FROM migrations WHERE id=$1 FOR UPDATE`, [id]);
  return found(q.rows[0] as { status: MigrationStatus; pausedFrom: MigrationStatus | null; failureCode: string | null } | undefined, "migration", id);
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
      return { status: 202, body: { id, from: "paused" as const, status: to, queue, jobQueued: jobId !== null } };
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
