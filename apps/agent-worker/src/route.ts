import { AgentRunJob } from "@svc/contracts";
import { handleAgentRun, type Deps } from "./handle-agent-run.js";
import { handleSpecDraft, type SpecDraftDeps } from "./handle-spec-draft.js";

// agent-run 큐 한 건을 실행 종류(kind)에 따라 나눈다. 큐 이름·작업 모양(AgentRunJob)은 그대로 쓴다
export type AgentRunKind = "remediate" | "spec_draft" | "failure_analysis";
export interface RouterDeps {
  kindOf(tenantId: string, agentRunId: string): Promise<AgentRunKind | null>;
  remediate: Deps;
  specDraft: SpecDraftDeps;
}

export async function routeAgentRun(raw: unknown, d: RouterDeps) {
  const job = AgentRunJob.parse(raw);
  const kind = await d.kindOf(job.tenantId, job.agentRunId);
  if (kind === "spec_draft") return { kind, ...(await handleSpecDraft(job, d.specDraft)) };
  // PF FM-ORC-19: 실패 원인 분석은 점검 고리(샌드박스·사람 승인 게이트)를 그대로 쓴다. 결과 kind 는 그대로 돌려준다
  if (kind === "failure_analysis") return { kind, ...(await handleAgentRun(job, d.remediate)) };
  return { kind: "remediate" as const, ...(await handleAgentRun(job, d.remediate)) };
}
