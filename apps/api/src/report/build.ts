import { Measurement, MigrationStatus, PrecheckItem, DeployResult, TrafficJudgement } from "@svc/contracts";
import { canonical, sha256 } from "@svc/core";
import type { CostEstimate } from "@svc/cost";
import { verifyAuditChain } from "./chain.js";
import type {
  AuditRow, ApprovalEvidence, CostSummary, EvidenceReport, TimelineStep,
} from "./schema.js";

// 리포트를 만드는 데 필요한 것 전부. DB에서 읽는 일은 load.ts가 하고 여기는 순수 함수다
export interface ReportInput {
  migration: {
    id: string; status: MigrationStatus; failureCode: string | null;
    source: { id: string; provider: string; name: string };
    target: { id: string; provider: string; name: string };
  };
  // 이 이전을 target으로 하는 감사 줄 (seq 오름차순)
  events: AuditRow[];
  // 회사 체인 검증용 줄 (seq 오름차순). 이전 이벤트 마지막 seq까지
  chain: AuditRow[];
  chainFromGenesis: boolean;
  plans: { planId: string; planHash: string }[];
  approvals: { planId: string; decision: "approve" | "reject"; approvedBy: string;
    planHash: string; at: string }[];
  cost?: CostEstimate | null;
  now?: () => Date;
}

const msBetween = (a: string, b: string) => Math.round(Date.parse(b) - Date.parse(a));

// detail 안의 값을 계약으로 걸러 낸다. 모양이 안 맞으면 버리고 gaps에 적지 않는다(감사 원본은 그대로 남아 있음)
function pick<T>(xs: unknown, parse: (v: unknown) => T | null): T[] {
  return Array.isArray(xs) ? xs.map(parse).filter((v): v is T => v !== null) : [];
}
const safe = <T>(s: { safeParse(v: unknown): { success: boolean; data?: T } }) =>
  (v: unknown): T | null => { const r = s.safeParse(v); return r.success ? r.data! : null; };

export function summarizeCost(c: CostEstimate): CostSummary {
  return {
    priceAsOf: c.priceAsOf,
    priceStale: c.priceStale,
    cheapest: c.cheapest,
    envs: c.envs.map((e) => ({ provider: e.provider, feasible: e.feasible,
      monthlyUsd: e.monthlyUsd, unverified: e.unverified })),
    savingsMonthlyUsd: c.savings?.monthlyUsd ?? null,
  };
}

export function buildEvidenceReport(inp: ReportInput): EvidenceReport {
  const now = (inp.now ?? (() => new Date()))();
  const ev = inp.events;

  // 1. 상태 전이 줄만 골라 시간표로 (advance가 detail에 from/to를 남긴다)
  const moves = ev.filter((e) =>
    MigrationStatus.safeParse(e.detail.from).success && MigrationStatus.safeParse(e.detail.to).success);
  const timeline: TimelineStep[] = moves.map((e, i) => ({
    seq: e.seq, at: e.at,
    from: e.detail.from as MigrationStatus, to: e.detail.to as MigrationStatus,
    actor: e.actor, action: e.action,
    durationMs: i > 0 ? msBetween(moves[i - 1]!.at, e.at) : null,
  }));

  // 2. 측정값·트래픽 판정·사전 점검·배포 결과 (각 작업이 감사 detail에 남긴 것)
  const measurements = ev.flatMap((e) => pick(e.detail.measurements, safe(Measurement)));
  const judgements = ev.flatMap((e) => pick(e.detail.judgements, safe(TrafficJudgement)));
  const prechecks = ev.filter((e) => Array.isArray(e.detail.precheck));
  const precheck = prechecks.length ? pick(prechecks.at(-1)!.detail.precheck, safe(PrecheckItem)) : [];
  const deploys = ev.map((e) => safe(DeployResult)(e.detail.deploy)).filter((d) => d !== null);
  const deploy = deploys.at(-1) ?? null;

  const traffic = judgements.length ? {
    judgements: judgements.length,
    steps: [...new Set(judgements.map((j) => j.stepPct))],
    bad: judgements.filter((j) => j.verdict === "bad" || j.verdict === "bad_shortcut").length,
    maxTargetErrorRatePct: Math.max(...judgements.map((j) => j.targetErrorRatePct)),
    maxTargetP95Ms: Math.max(...judgements.map((j) => j.targetP95Ms)),
  } : null;

  // 3. 승인: 사람이 본 지문과 저장된 계획서 지문이 같은가
  const planHashById = new Map(inp.plans.map((p) => [p.planId, p.planHash]));
  const approvals: ApprovalEvidence[] = inp.approvals.map((a) => {
    const stored = planHashById.get(a.planId) ?? null;
    return { planId: a.planId, decision: a.decision, approvedBy: a.approvedBy, at: a.at,
      approvedPlanHash: a.planHash, storedPlanHash: stored, hashMatches: stored === a.planHash };
  });

  // 4. 거부·오류 줄 (가드레일 발동, 재확인 거부 등)
  const incidents = ev.filter((e) => e.result !== "ok").map((e) => ({
    seq: e.seq, at: e.at, actor: e.actor, action: e.action,
    result: e.result as "denied" | "error",
    note: String(e.detail.failureCode ?? e.detail.ruleId ?? e.detail.job ?? e.detail.reason ?? ""),
  }));

  const integrity = verifyAuditChain(inp.chain, inp.chainFromGenesis);
  const cost = inp.cost ? summarizeCost(inp.cost) : null;
  const visited = new Set(timeline.map((t) => t.to));

  // 5. 비어 있는 것은 숨기지 않고 적는다 (심사 때 "왜 없나"에 바로 답하려고)
  const gaps: string[] = [];
  if (!timeline.length) gaps.push("상태 전이 기록 없음");
  if (!approvals.some((a) => a.decision === "approve")) gaps.push("승인 기록 없음");
  if (!measurements.some((m) => m.name === "cutover_pause_ms")) gaps.push("컷오버 멈춤 시간(cutover_pause_ms) 측정 없음");
  if (!measurements.some((m) => m.name === "replication_lag_ms")) gaps.push("복제 지연(replication_lag_ms) 측정 없음");
  if (!traffic) gaps.push("트래픽 판정 기록 없음");
  if (!cost) gaps.push("비용 추정 없음");
  if (integrity.partial) gaps.push("감사 체인을 처음부터 다 확인하지 못함");
  const stubbed = ev.some((e) => canonical(e.detail).includes("STUB"));
  if (stubbed) gaps.push("일부 단계 결과가 STUB(가짜 구현) 값");

  const body: Omit<EvidenceReport, "reportHash"> = {
    reportVersion: 1,
    generatedAt: now.toISOString(),
    migration: { ...inp.migration },
    summary: {
      startedAt: timeline[0]?.at ?? null,
      endedAt: timeline.at(-1)?.at ?? null,
      totalMs: timeline.length ? msBetween(timeline[0]!.at, timeline.at(-1)!.at) : null,
      transitions: timeline.length,
      reachedCutover: visited.has("cutover"),
      rolledBack: visited.has("rolled_back") || visited.has("rolling_back"),
      deniedOrError: incidents.length,
    },
    integrity, timeline, approvals, precheck, measurements, traffic, deploy, cost, incidents, gaps,
  };
  // generatedAt은 지문에서 뺀다: 같은 기록이면 언제 뽑아도 같은 지문
  const { generatedAt: _g, ...stable } = body;
  return { ...body, reportHash: sha256(canonical(stable)) };
}
