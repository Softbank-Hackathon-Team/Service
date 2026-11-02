import { envNumber } from "@svc/contracts";
import type { Tx } from "./db.js";
import { DomainError } from "./errors.js";

// 재시도 한도 (PA5a, 계획 26 · A5a, 회의 D5 "그래도 실패면 고객 부담")
// 사람이 실패를 다시 시도한 횟수 = 감사 migration.retried 줄 수 (replan·resume 이 남김).
// 한도 이상이면 본문 acceptCustomerCost:true 가 있어야 다시 시도할 수 있다 → 없으면 409 RETRY_BUDGET_EXHAUSTED
// DRAFT(ai): H-3 한도 3번 (환경변수 RETRY_BUDGET, 0 = 끔). 팀 합의 전 기본값
export const RETRY_BUDGET_DEFAULT = 3;
// 검증 PA5a: 글자("abc")면 NaN 이라 `budget > 0` 이 거짓 → 비용 한도가 조용히 꺼졌다. 숫자가 아니면 기본값 (observeMinSec 와 같은 규칙)
export const retryBudget = (env: Record<string, string | undefined> = process.env) => {
  const n = envNumber(env.RETRY_BUDGET, RETRY_BUDGET_DEFAULT);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : RETRY_BUDGET_DEFAULT;
};

export async function checkRetryBudget(tx: Tx, migrationId: string, acceptCustomerCost: boolean | undefined):
  Promise<{ attempt: number; budget: number; customerCostAccepted: boolean }> {
  const n = (await tx.query(
    "SELECT count(*)::int AS n FROM audit_events WHERE target = $1 AND action = 'migration.retried'", [migrationId])).rows[0].n as number;
  const budget = retryBudget();
  const over = budget > 0 && n >= budget;
  if (over && acceptCustomerCost !== true)
    throw new DomainError(409, "RETRY_BUDGET_EXHAUSTED",
      `retried ${n} times (budget ${budget}); send acceptCustomerCost:true to retry at customer cost`);
  return { attempt: n + 1, budget, customerCostAccepted: over };
}
