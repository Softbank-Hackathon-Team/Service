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
export interface AgentReview { migrationId: string; llm?: AgentLlm; remediate: RemediateReview | null; specDraft: SpecDraftReview | null }
