// LLM 호출 인터페이스. Anthropic Messages API 응답 모양의 필요한 부분만 적었다.
// 추론은 상용 LLM API를 부른다 (모델 서버를 직접 띄우지 않는다).
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };
export interface LlmMessage { role: "user" | "assistant"; content: unknown }
export interface LlmResponse {
  content: ContentBlock[];
  // 진짜 제공자가 받은 블록 전체(thinking·fallback 포함). 다음 요청에 이걸 그대로 돌려보내야 한다.
  // 없으면 content 를 돌려보낸다 (대본·가짜 제공자)
  raw?: unknown[];
  model?: string;
  stop_reason: "tool_use" | "end_turn" | "max_tokens" | "refusal" | string;
  usage: { input_tokens: number; output_tokens: number };
  cacheHit?: boolean;   // z75-59: 응답 캐시(llm/cache.ts)에서 꺼냈으면 true. 캐시를 안 거치면 없음
  usd?: number | null;  // z75-64: 이 호출의 달러 추정 (실제 제공자·지출 상한이 붙인다. 캐시 응답은 0원이라 안 셈)
}
export interface LlmProvider {
  readonly model: string;
  create(req: { system: string; tools: unknown[]; messages: LlmMessage[]; maxTokens?: number }): Promise<LlmResponse>;
}

// 시험 전용 가짜 LLM (FAKE_LLM=1 일 때만 쓰인다, 작업 Z90): 정해진 도구 호출을 순서대로 낸다.
// 진짜 제공자는 ../llm/anthropic.ts (기본), 시험 전용 가짜 공급자는 ../llm/mock-draft.ts
export function scriptedLlm(script: Array<{ name: string; input: unknown }>, model = "stub-scripted"): LlmProvider {
  // 작업 Z65: 대본 위치는 대화 기록의 assistant 턴 수로 구한다 (속에 횟수를 세지 않음).
  // 워커는 LLM 을 한 번 만들어 작업마다 다시 쓰는데, 예전엔 두 번째 실행부터 대본이 바닥나 "finish 없이 종료"로 failed 였다
  return {
    model,
    async create(req) {
      const i = req.messages.filter((m) => m.role === "assistant").length;
      const s = script[i];
      if (!s) return { content: [{ type: "text", text: "끝" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } };
      return {
        content: [{ type: "tool_use", id: `tu_${i + 1}`, name: s.name, input: s.input }],
        stop_reason: "tool_use", usage: { input_tokens: 1200, output_tokens: 80 },
      };
    },
  };
}
