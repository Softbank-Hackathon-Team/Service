import Anthropic from "@anthropic-ai/sdk";
import { AGENT_DEFAULT_MODEL, LLM_KEY_MISSING, LLM_BUDGET_EXCEEDED } from "@svc/contracts";
import type { ContentBlock, LlmMessage, LlmProvider, LlmResponse } from "../ai/llm.js";

// 진짜 LLM 제공자: Anthropic Messages API (상용 API. 모델 서버를 직접 띄우지 않는다)
// 키는 환경변수 ANTHROPIC_API_KEY 에서 SDK가 직접 읽는다. 이 코드는 키 값을 받지도, 로그에 남기지도 않는다.

// DRAFT(ai): 기본 모델 claude-sonnet-5-5 (입력 $2 / 출력 $10 per 1M 토큰). 2026-10-31 "기다리지 말고 진행" 지시로 비용 낮은 쪽을 먼저 둠.
// AGENT_MODEL=claude-opus-5-5 ($4 / $20) 로 바꿀 수 있다.
// TODO(human): 맥에서 두 모델 5회씩 실측(apps/agent-worker/scripts/bench-spec-draft.ts) 뒤 팀이 확정
export const DEFAULT_MODEL = AGENT_DEFAULT_MODEL;
// 1M 토큰당 달러 (2026-10 공개 가격). 비용 로그·측정 스크립트의 추정용
// 【사실】 claude-api 스킬 모델 표(cached 2026-10-06): sonnet-5-5 $2/$10·캐시 읽기 $0.20, opus-5-5 $4/$20·캐시 읽기 $0.20
// 캐시 쓰기(5분)는 입력값의 1.25배로 계산한다【추정: 기존 Anthropic 가격 규칙】
export const PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
};
export interface LlmUsageDetail { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
// 모르는 모델이면 null (가격표에 없는 값을 지어내지 않는다)
export function estimateUsd(model: string, u: LlmUsageDetail): number | null {
  const p = PRICE_PER_MTOK[model];
  if (!p) return null;
  const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
  const usd = (u.input_tokens * p.input + u.output_tokens * p.output + read * (p.cacheRead ?? p.input) + write * p.input * 1.25) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

// 작업 Z90: 호출 한 번마다 남기는 비용·시간 기록. 글 내용·키는 들어가지 않는다
export interface LlmCallLog {
  model: string; requested_model: string; ms: number; stop_reason: string; request_id: string | null;
  input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number;
  usd: number | null; ok: boolean; error?: string;
}
export type LlmCallLogger = (rec: LlmCallLog) => void;
// 기본: 한 줄 JSON 을 stderr 로 (agent-worker 는 main.ts 에서 pino 로거를 넘긴다)
const defaultCallLog: LlmCallLogger = (rec) => console.error(JSON.stringify({ msg: "llm call", ...rec }));

// 키 없음: 가짜 결과를 만들지 않고 바로 실패한다. 실행 기록에는 LLM_KEY_MISSING 이 남아 화면이 "키 없음" 으로 보여 준다
export class LlmKeyMissingError extends Error {
  readonly code = LLM_KEY_MISSING;
  constructor() { super("ANTHROPIC_API_KEY 가 없어 Claude API 를 부를 수 없음"); this.name = "LlmKeyMissingError"; }
}
export function missingKeyLlm(model = DEFAULT_MODEL): LlmProvider {
  return { model, async create() { throw new LlmKeyMissingError(); } };
}

// DRAFT(ai): effort medium 을 명시 (sonnet-5-5 기본은 high, opus-5-5 기본은 medium. 모델을 바꿔도 같은 깊이로 비교). 명세 초안은 짧은 추론으로 충분하다고 봄. 측정 후 조정
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicOptions {
  model?: string;
  effort?: Effort;
  maxTokens?: number;          // 비스트리밍이라 16000 이하로 둔다 (SDK HTTP 시간 제한)
  timeoutMs?: number;
  maxRetries?: number;         // SDK가 408/409/429/5xx/연결 오류를 자동 재시도
  fallbacks?: boolean;         // 서버 쪽 거부 대체(refusal fallback). 기본 켬
  client?: Pick<Anthropic, "beta">; // 시험용 주입
  onCall?: LlmCallLogger;      // 호출마다 비용·시간 기록 (기본 stderr 한 줄 JSON)
  clock?: () => number;        // 시험용
}

export function anthropicProvider(o: AnthropicOptions = {}): LlmProvider {
  const model = o.model ?? DEFAULT_MODEL;
  const client = o.client ?? new Anthropic({
    timeout: o.timeoutMs ?? 120_000,      // DRAFT(ai): 2분. 예산(900초) 안에서 여러 번 부를 수 있게
    maxRetries: o.maxRetries ?? 2,
  });
  const useFallbacks = o.fallbacks ?? true;
  const onCall = o.onCall ?? defaultCallLog;
  const clock = o.clock ?? (() => performance.now());
  return {
    model,
    async create(req: { system: string; tools: unknown[]; messages: LlmMessage[]; maxTokens?: number }): Promise<LlmResponse> {
      const t0 = clock();
      let res: Anthropic.Beta.BetaMessage & { _request_id?: string | null };
      try {
      res = await client.beta.messages.create({
        model,
        max_tokens: req.maxTokens ?? o.maxTokens ?? 16000,
        // thinking 은 생략 = 적응형 (sonnet-5-5·opus-5-5 모두 disabled 는 400). 깊이는 effort 로만 조절한다
        output_config: { effort: o.effort ?? "medium" },
        system: req.system,
        tools: req.tools as Anthropic.Beta.BetaToolUnion[],
        messages: req.messages as Anthropic.Beta.BetaMessageParam[],
        // 정책 거부 시 서버가 같은 요청을 대체 모델로 다시 돌린다. "default" = 거부 종류별 서버 기본값 (Claude API 전용)
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      }) as unknown as typeof res;
      } catch (e) {
        // 재시도(SDK maxRetries)까지 다 실패한 뒤 한 번 남긴다. 메시지 본문은 남기지 않는다 (요청 내용이 섞일 수 있음)
        safeLog(onCall, { model, requested_model: model, ms: Math.round(clock() - t0), stop_reason: "error", request_id: null,
          input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, usd: 0, ok: false, error: llmErrorCode(e) });
        throw e;
      }
      const u = res.usage as LlmUsageDetail;
      const answered = res.model ?? model;
      safeLog(onCall, { model: answered, requested_model: model, ms: Math.round(clock() - t0), stop_reason: res.stop_reason ?? "end_turn",
        request_id: res._request_id ?? null, input_tokens: u.input_tokens, output_tokens: u.output_tokens,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        usd: estimateUsd(answered, u), ok: true });
      const content: ContentBlock[] = [];
      for (const b of res.content) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      return {
        content,
        raw: res.content as unknown[],   // thinking·fallback 블록까지 다음 요청에 그대로 돌려보낸다
        stop_reason: res.stop_reason ?? "end_turn",
        usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
        model: res.model,
        usd: estimateUsd(answered, u),   // z75-64: 캐시 읽기·쓰기 토큰까지 넣은 값 (지출 상한이 쓴다)
      };
    },
  };
}

const safeLog = (f: LlmCallLogger, r: LlmCallLog) => { try { f(r); } catch { /* 로그 실패가 호출을 깨면 안 된다 */ } };

// SDK 오류를 실패 이유 코드로 바꾼다. 재시도는 SDK가 이미 했으므로 여기서는 이름만 붙인다
export function llmErrorCode(e: unknown): string {
  if (e instanceof LlmKeyMissingError) return LLM_KEY_MISSING;            // 키 없음 (호출 전에 막음)
  if ((e as { code?: unknown } | null)?.code === LLM_BUDGET_EXCEEDED) return LLM_BUDGET_EXCEEDED; // z75-64 지출 상한 (budget.ts, 호출 전에 막음)
  if (e instanceof Anthropic.AuthenticationError) return "LLM_AUTH";        // 키 없음·틀림
  if (e instanceof Anthropic.PermissionDeniedError) return "LLM_FORBIDDEN";
  if (e instanceof Anthropic.NotFoundError) return "LLM_MODEL_NOT_FOUND";
  if (e instanceof Anthropic.RateLimitError) return "LLM_RATE_LIMIT";
  if (e instanceof Anthropic.BadRequestError) return "LLM_BAD_REQUEST";
  if (e instanceof Anthropic.APIConnectionError) return "LLM_CONNECTION";  // 시간 초과 포함
  if (e instanceof Anthropic.APIError) return `LLM_HTTP_${e.status ?? "x"}`;
  return "LLM_UNKNOWN";
}
