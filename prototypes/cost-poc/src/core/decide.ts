import type { Decision, MigrationParams, Range, VendorId } from "./types.js";
import { HOURS_PER_MONTH } from "./cost.js";

// DRAFT(ai): 옮길 가치가 있는가. 일회성 이전 비용과 회수 기간으로 판단한다. 비용은 모두 달러.
// 일회성 항목은 대부분 가정이고 파라미터다.

export type OneTimeInput = {
  params: MigrationParams;
  targetHourlyUsd: number;      // 병행 운영 동안 도착 쪽을 켜 두는 비용
  sourceEgressPerGB: number;    // 출발지 송신 단가
  dataGB: number;               // DB 전체 복사량
  cdcGB?: number;               // 병행 기간 복제로 나가는 양
};

export function oneTimeCost(i: OneTimeInput): { total: number; breakdown: Record<string, number> } {
  const p = i.params;
  const b: Record<string, number> = {
    engineering: p.engineerHours * p.engineerUsdPerHour,
    parallelRun: i.targetHourlyUsd * 24 * p.parallelRunDays,
    sandbox: i.targetHourlyUsd * p.sandboxHours,
    dataTransfer: p.egressWaived ? 0 : (i.dataGB + (i.cdcGB ?? 0)) * i.sourceEgressPerGB,
    llm: p.llmUsd,
  };
  return { total: Object.values(b).reduce((x, y) => x + y, 0), breakdown: b };
}

export type Candidate = { vendor: VendorId; monthly: Range; oneTime: { total: number; breakdown: Record<string, number> } };

// 비교는 같은 뽑기에서의 차이로 한다: savings[candidate] = 출발 월 비용 - 후보 월 비용의 범위
export function decide(
  from: VendorId, current: Range | null, candidates: (Candidate & { saving: Range })[], params: MigrationParams,
): Decision {
  const none = (verdict: Decision["verdict"], reason: string, to: VendorId | null = null): Decision => ({
    verdict, reason, from, to, monthlySavingUsd: null, oneTimeUsd: null, oneTimeBreakdown: null, paybackMonths: null, horizonNetUsd: null,
  });
  if (!current) return none("insufficient-evidence", "CURRENT_ENV_NOT_PRICED");
  if (candidates.length === 0) return none("stay", "NO_FEASIBLE_TARGET");
  const best = [...candidates].sort((a, b) => b.saving.base - a.saving.base || (a.vendor < b.vendor ? -1 : 1))[0]!;
  const saving = best.saving;
  const payback = saving.base > 0 ? best.oneTime.total / saving.base : Infinity;
  const common = {
    from, to: best.vendor, monthlySavingUsd: saving, oneTimeUsd: best.oneTime.total, oneTimeBreakdown: best.oneTime.breakdown,
    paybackMonths: Number.isFinite(payback) ? payback : null,
    horizonNetUsd: saving.base * params.horizonMonths - best.oneTime.total,
  };
  if (saving.base <= params.minMonthlySavingUsd) return { ...common, verdict: "stay", reason: "NO_SAVING" };
  if (payback > params.maxPaybackMonths) return { ...common, verdict: "stay", reason: "PAYBACK_TOO_LONG" };
  if (saving.low <= 0) return { ...common, verdict: "insufficient-evidence", reason: "SAVING_RANGE_CROSSES_ZERO" };
  return { ...common, verdict: "move", reason: "PAYBACK_WITHIN_LIMIT" };
}

export const hoursPerMonth = HOURS_PER_MONTH;
