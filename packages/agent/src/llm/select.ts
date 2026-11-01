import { agentLlmStatusFromEnv, type AgentLlmStatus } from "@svc/contracts";
import type { LlmProvider } from "../ai/llm.js";
import { anthropicProvider, missingKeyLlm, type Effort, type LlmCallLogger } from "./anthropic.js";
import { mockDraftLlm } from "./mock-draft.js";

// 명세 초안(spec_draft) LLM 고르기. 작업 Z90: 기본 = 실제 Claude API. 규칙은 @svc/contracts agent-llm.ts 한 곳
//   FAKE_LLM=1          시험 전용 가짜 (mockDraftLlm). 결과에 모델 "mock-draft" 가 남아 화면이 가짜로 표시한다
//   ANTHROPIC_API_KEY   없으면 key_missing: 호출마다 LLM_KEY_MISSING 으로 실패 (가짜 결과 없음)
//   AGENT_MODEL         기본 claude-sonnet-5-5 (claude-opus-5-5 로 바꿀 수 있다). 예전 이름 AGENT_LLM_MODEL 도 읽는다
//   AGENT_LLM_EFFORT    low | medium | high | xhigh | max (기본 medium)
//   AGENT_LLM_TIMEOUT_MS  호출 한 번 시간 제한 (기본 120000). AGENT_LLM_MAX_RETRIES 재시도 횟수 (기본 2, SDK 가 429·5xx·연결 오류만 재시도)
// 키 값은 읽지 않고 "있는지"만 본다. 키는 SDK 가 환경변수에서 직접 읽는다
type Env = Record<string, string | undefined>;
export interface LlmChoice {
  llm: LlmProvider;
  provider: "anthropic" | "fake" | "key_missing";
  model: string; why: string; warnings: string[]; status: AgentLlmStatus;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export function llmCallOptionsFromEnv(env: Env) {
  const effort = (env.AGENT_LLM_EFFORT?.trim() || "medium") as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`AGENT_LLM_EFFORT 값이 틀림: ${effort}`);
  const num = (name: string, def: number, min: number, max: number) => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 값이 틀림: ${raw} (${min}~${max})`);
    return n;
  };
  return {
    effort,
    timeoutMs: num("AGENT_LLM_TIMEOUT_MS", 120_000, 5_000, 600_000),
    maxRetries: num("AGENT_LLM_MAX_RETRIES", 2, 0, 6),
  };
}

export function llmFromEnv(env: Env = process.env, o: { onCall?: LlmCallLogger } = {}): LlmChoice {
  const status = agentLlmStatusFromEnv(env, { keyFlag: false });
  const base = { why: status.why, warnings: status.warnings, status };
  if (status.state === "fake") { const llm = mockDraftLlm(); return { ...base, llm, provider: "fake", model: llm.model }; }
  const call = llmCallOptionsFromEnv(env);
  if (status.state === "key_missing") return { ...base, llm: missingKeyLlm(status.model), provider: "key_missing", model: status.model };
  return { ...base, llm: anthropicProvider({ model: status.model, ...call, onCall: o.onCall }), provider: "anthropic", model: status.model };
}
