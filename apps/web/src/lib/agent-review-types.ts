// 작업 Z58: GET /migrations/:id/agent-review 응답 모양 (apps/api/src/routes/agent-review.ts 의 AgentReview 와 같게 손으로 맞춘다)
// TODO(human): web 이 @svc/contracts 를 직접 import 하지 않는 기존 방식(types.ts 복사)을 따랐다
export type AgentRunStatus = "queued" | "running" | "finished" | "failed";
export interface AgentStep { seq: number; tool: string; ok: boolean; note: string }
interface RunMeta {
  source: "db" | "stub";
  runId: string | null;
  status: AgentRunStatus;
  model: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  reason: string | null;
  usage: { input: number; output: number };
  steps: AgentStep[];
}
export interface RemediateReview extends RunMeta {
  outcome: "proposed" | "no_change" | "gave_up" | null;
  title: string;
  rationale: string;
  checked: string[];
  notDone: string[];
  gate: { ok: boolean; violations: string[] } | null;
}
export interface SpecDraftReview extends RunMeta {
  version: number | null;
  risks: { id: string; level: "high" | "medium" | "low"; title: string; source: "rule" | "ai" }[];
  planExplanation: string;
  rejectedCount: number;
}
// 작업 Z90: 서버 설정상 AI LLM 상태. ready = 실제 Claude API, key_missing = 키 없음(실행 불가), fake = 시험용 가짜
// z75-64: spend = 이 회차 실제 LLM 지출 (달러 추정)
export interface AgentLlmSpend { round: string; usd: number; budgetUsd: number; calls: number; exceeded: boolean; totalUsd?: number; globalUsd?: number }
export interface AgentLlm { state: "ready" | "key_missing" | "fake"; model: string; why: string; spend?: AgentLlmSpend }
// PA5a: 실패 원인 분석 (contracts results.ts FailureAnalysis). AI 는 원인·고칠 것만 알려 주고 재시도는 사람이 누른다
//   analysis 는 아직 안 끝났거나 모양이 틀리면 null. confidence 는 0~1 연속값
export interface FailureAnalysis { cause: string; evidence: string[]; fix: string[]; retryable: boolean; confidence: number }
export interface FailureAnalysisReview extends RunMeta { analysis: FailureAnalysis | null }
// failureAnalysis: 이전이 failed·paused 로 갈 때 넣은 분석 실행이 있을 때만 칸이 생긴다
export interface AgentReview {
  migrationId: string; llm?: AgentLlm; remediate: RemediateReview | null; specDraft: SpecDraftReview | null;
  failureAnalysis?: FailureAnalysisReview;
}
