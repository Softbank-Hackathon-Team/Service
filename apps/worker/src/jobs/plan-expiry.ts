import { PlanJob, QUEUES } from "@svc/contracts";
import { planExpired } from "@svc/core";
import { RetryLater, runStep, jobData } from "./_step.js";

// G7-1: 승인을 기다리다 만료된 계획을 stale 로 옮긴다 (awaiting_approval → stale, T11 staleReason=expired).
// 예전: T11 은 표·조건에만 있고 부르는 곳이 없었다. 만료된 이전은 승인·거절·다시 계획이 다 409 라 취소 → 처음부터 다시뿐이었다.
// 이제: 계획 작업이 awaiting_approval 로 넘길 때 이 작업을 만료 시각(startAfter)에 넣는다. 그 뒤엔 지금의 stale → 다시 계획 길을 쓴다.
// 이 계획이 이미 최신이 아니면(다시 계획함) 아무것도 안 한다. 아직 만료 전이면(시계 차이) 남은 만큼 뒤에 다시 깨어난다
export async function handlePlanExpiry(raw: unknown) {
  const job = PlanJob.parse(raw);
  return runStep(job, {
    name: "plan_expiry",
    expect: "awaiting_approval",
    load: async (tx, j, m) => {
      const q = await tx.query(
        `SELECT id, EXTRACT(EPOCH FROM (expires_at - now()))::float8 AS left_sec
           FROM plans WHERE migration_id = $1 ORDER BY created_at DESC LIMIT 1`, [m.id]);
      const latest = q.rows[0] as { id: string; left_sec: number } | undefined;
      if (!latest || latest.id !== j.planId) return null;          // 다시 계획해서 다른 계획이 최신 → 할 일 없음
      return { expired: (await planExpired(tx, latest.id)) !== false, leftSec: latest.left_sec };
    },
    work: async (j, _m, loaded) => {
      if (!loaded.expired)
        throw new RetryLater(QUEUES.planExpiry, { ...jobData(j), planId: j.planId }, Math.max(1, Math.ceil(loaded.leftSec) + 1),
          { reason: "plan_not_expired_yet", planId: j.planId });
      return { to: "stale", evidence: { staleReason: "expired" }, detail: { planId: j.planId, staleReason: "expired" },
        // 계획서 줄도 낡음으로 (승인 기록 표와 같은 상태 값). advance 가 지면(ifStill) 트랜잭션째 취소된다
        inTx: async (tx) => { await tx.query(`UPDATE plans SET status = 'stale' WHERE id = $1 AND status = 'proposed'`, [j.planId]); } };
    },
  });
}
