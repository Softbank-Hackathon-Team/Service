import type { MigrationStatus } from "@svc/contracts";
import type { ShiftResult } from "./controller.js";
import type { MetricsSource } from "./metrics.js";
import { setAndVerify, sameWeights, type TrafficSwitcher } from "./switcher.js";

// 트래픽 결과 → 상태 머신 한 칸. 워커 shift / rollback 처리기가 advance() 에 그대로 넘긴다.
// 이 패키지는 DB·advance 를 모른다. 증거(evidence) 이름은 core 의 TransitionEvidence 와 같게 맞췄다.
//   shifting → cutover      T22: weightPct 100, observedSec ≥ 30, targetLogsSeen
//   shifting → rolling_back      (조건 없음) + rollback 작업
//   shifting → paused       T30: guardrailRule 또는 failureCode
//   rolling_back → rolled_back T35: sourceWeight100, sourceHealthy
export interface TrafficEvidence {
  weightPct?: number; observedSec?: number; targetLogsSeen?: boolean;
  sourceWeight100?: boolean; sourceHealthy?: boolean; guardrailRule?: string;
}
export interface TrafficTransition {
  to: Extract<MigrationStatus, "cutover" | "rolling_back" | "paused">;
  evidence: TrafficEvidence;
  failureCode: string | null;
  enqueue: "cutover" | "rollback" | null;   // 다음 큐 (QUEUES 의 키 이름)
  detail: Record<string, unknown>;          // 감사 detail
}

// 상태 머신에서 트래픽이 움직이는 상태. 이 밖에서 전환기를 부르면 안 된다
export const TRAFFIC_ACTIVE_STATES: readonly MigrationStatus[] = ["shifting", "rolling_back"];
// 각 상태에서 도착 가중치가 어때야 하나 (화면·점검용)
export const EXPECTED_TARGET_PCT: Partial<Record<MigrationStatus, string>> = {
  deploying: "0", syncing: "0", shifting: "10~100", cutover: "100", rollback_window: "100",
  cleanup: "100", completed: "100", rolling_back: "0", rolled_back: "0", paused: "멈춘 때 그대로",
};

export function shiftTransition(r: ShiftResult, o: { targetLogsSeen: boolean; pauseRule?: string }): TrafficTransition {
  const detail = {
    outcome: r.outcome, reachedPct: r.reachedPct, observedSecAt100: r.observedSecAt100,
    judgements: r.judgements.length, lastJudgement: r.judgements.at(-1) ?? null,
    rollbackReason: r.rollbackReason, finalWeights: r.finalWeights,
  };
  switch (r.outcome) {
    case "reached_100":
      return { to: "cutover", failureCode: null, enqueue: "cutover", detail,
        evidence: { weightPct: Math.round(r.finalWeights.target * 100), observedSec: r.observedSecAt100, targetLogsSeen: o.targetLogsSeen } };
    case "paused":
      return { to: "paused", failureCode: r.failureCode ?? "TRAFFIC_PAUSED", enqueue: null, detail,
        evidence: { guardrailRule: o.pauseRule } };
    case "rolled_back":
    case "rollback_failed":
      return { to: "rolling_back", failureCode: r.failureCode, enqueue: "rollback", detail, evidence: {} };
  }
}

// rollback 작업: 출발 100% 를 (다시) 확인·설정하고 출발 상태를 본다. 여러 번 불려도 결과가 같다 (멱등)
// DRAFT(ai): "출발 건강" = 최근 창에서 출발 5xx 비율 ≤ 1% 이고 표본이 있음. 표본 0 이면 지표 없이 건강으로 본다 (데모 트래픽이 없을 때)
export async function restoreSource(o: { switcher: TrafficSwitcher; lbId: string; metrics?: MetricsSource; migrationId: string;
  sleep?: (ms: number) => Promise<void> }): Promise<{ evidence: TrafficEvidence; detail: Record<string, unknown> }> {
  const before = await o.switcher.get(o.lbId).catch(() => null);
  const alreadyRestored = before !== null && sameWeights(before, { source: 1, target: 0 });
  if (!alreadyRestored) await setAndVerify(o.switcher, o.lbId, { source: 1, target: 0 }, { sleep: o.sleep });
  const after = await o.switcher.get(o.lbId);
  let sourceHealthy = true, sourceErrPct: number | null = null;
  if (o.metrics) {
    const w = await o.metrics.window(o.migrationId, 0);
    if (w.source.n > 0) { sourceErrPct = (w.source.err5xx / w.source.n) * 100; sourceHealthy = sourceErrPct <= 1; }
  }
  return {
    evidence: { sourceWeight100: sameWeights(after, { source: 1, target: 0 }), sourceHealthy },
    detail: { before, after, alreadyRestored, sourceErrPct },
  };
}
