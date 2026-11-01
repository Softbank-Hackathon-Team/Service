// 작업 Z90: AI 에이전트(명세 초안·장애 점검)가 어떤 LLM 으로 도는지 한 곳에서 정한다.
// agent-worker(실제 호출)와 API(화면에 상태 표시)가 같은 규칙을 쓴다. 이 파일은 import 가 없다 (API 에 LLM SDK 를 들이지 않음).
//
// 규칙 (기본 = 실제 Claude API)
//   FAKE_LLM=1          시험 전용 가짜 LLM (명세 초안 mock, 장애 점검 대본). 화면에 "가짜 LLM(시험)" 이라고 꼭 표시된다
//   ANTHROPIC_API_KEY   있으면 실제 Claude API. 없으면 "키 없음" 상태: 실행은 바로 실패(LLM_KEY_MISSING)하고 가짜 결과를 만들지 않는다
//   AGENT_LLM_KEY_SET=1 API 컨테이너용. 키 값을 넘기지 않고 "있다"는 사실만 넘긴다 (docker-compose ${ANTHROPIC_API_KEY:+1})
//   AGENT_MODEL         기본 claude-sonnet-5-5
// 예전 값 AGENT_LLM_PROVIDER=mock · AGENT_LLM=scripted 는 더 이상 가짜로 바꾸지 않는다 (무시하고 경고만 남긴다)
export type AgentLlmState = "ready" | "key_missing" | "fake";
export interface AgentLlmStatus {
  state: AgentLlmState;
  model: string;      // ready·key_missing: 부를 모델 이름, fake: "fake"
  why: string;        // 화면·로그에 그대로 쓰는 한국어 한 줄 (값 없이 이름만)
  warnings: string[]; // 무시한 예전 설정 등
}
export const AGENT_DEFAULT_MODEL = "claude-sonnet-5-5";
export const LLM_KEY_MISSING = "LLM_KEY_MISSING";

type Env = Record<string, string | undefined>;
const on = (v: string | undefined) => ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());

// keyFlag: AGENT_LLM_KEY_SET 를 믿을지. API 는 믿고(키 값이 없으니), agent-worker 는 안 믿는다(진짜 키가 있어야 부를 수 있음)
export function agentLlmStatusFromEnv(env: Env = process.env, o: { keyFlag?: boolean } = {}): AgentLlmStatus {
  const warnings: string[] = [];
  const legacyProvider = env.AGENT_LLM_PROVIDER?.trim();
  const legacyRemediate = env.AGENT_LLM?.trim();
  if (legacyProvider === "mock") warnings.push("AGENT_LLM_PROVIDER=mock 은 무시함 (가짜는 FAKE_LLM=1 시험 전용)");
  else if (legacyProvider && legacyProvider !== "anthropic") throw new Error(`AGENT_LLM_PROVIDER 값이 틀림: ${legacyProvider} (anthropic, 또는 지우기)`);
  if (legacyRemediate === "scripted") warnings.push("AGENT_LLM=scripted 는 무시함 (가짜는 FAKE_LLM=1 시험 전용)");
  else if (legacyRemediate && legacyRemediate !== "real") throw new Error(`AGENT_LLM 값이 틀림: ${legacyRemediate} (real, 또는 지우기)`);

  if (on(env.FAKE_LLM)) return { state: "fake", model: "fake", why: "FAKE_LLM=1 (시험 전용 가짜 LLM)", warnings };
  const model = env.AGENT_MODEL?.trim() || env.AGENT_LLM_MODEL?.trim() || AGENT_DEFAULT_MODEL;
  const hasKey = Boolean(env.ANTHROPIC_API_KEY?.trim()) || ((o.keyFlag ?? true) && on(env.AGENT_LLM_KEY_SET));
  if (!hasKey) return { state: "key_missing", model, why: "ANTHROPIC_API_KEY 없음 (.env 에 넣어야 AI 기능이 돈다)", warnings };
  return { state: "ready", model, why: "실제 Claude API", warnings };
}

// z75-64: 실제 LLM 지출 상한. 회사·회차마다 쓴 달러(토큰 × 단가 추정)를 DB 한 줄(llm_spend)에 쌓고, 상한을 넘으면 새 호출을 막는다
//   LLM_BUDGET_USD    회차 하나의 상한 (기본 2, 0 이상. 0 이면 실제 호출 전부 막음). 캐시에서 꺼낸 응답은 0원
//   LLM_BUDGET_GLOBAL_USD 회차 하나의 전체 상한 (모든 회사 합, 기본 10, Z38 R8-48: 키가 하나라 회사 N개면 N×상한이 되는 것을 막음)
//   LLM_BUDGET_ROUND  회차 이름 (기본 오늘 날짜 UTC, 예 2026-11-07). 새 회차를 열려면 이름을 바꾼다 (데모 초기화는 지출을 안 지운다)
export const LLM_BUDGET_EXCEEDED = "LLM_BUDGET_EXCEEDED";
export const LLM_BUDGET_DEFAULT_USD = 2;
export const LLM_BUDGET_GLOBAL_DEFAULT_USD = 10;
export interface LlmBudget { budgetUsd: number; round: string; globalUsd: number }
export function llmBudgetFromEnv(env: Env = process.env, now: Date = new Date()): LlmBudget {
  const raw = env.LLM_BUDGET_USD?.trim();
  const n = raw ? Number(raw) : LLM_BUDGET_DEFAULT_USD;
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error(`LLM_BUDGET_USD 값이 틀림: ${raw} (0~1000)`);
  const round = env.LLM_BUDGET_ROUND?.trim() || now.toISOString().slice(0, 10);
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(round)) throw new Error(`LLM_BUDGET_ROUND 값이 틀림: ${round} (영숫자·._:- 64자 이내)`);
  const graw = env.LLM_BUDGET_GLOBAL_USD?.trim();
  const g = graw ? Number(graw) : LLM_BUDGET_GLOBAL_DEFAULT_USD;
  if (!Number.isFinite(g) || g < 0 || g > 10000) throw new Error(`LLM_BUDGET_GLOBAL_USD 값이 틀림: ${graw} (0~10000)`);
  return { budgetUsd: n, round, globalUsd: g };
}
// 화면·감사에 보이는 지출 (달러는 소수 6자리까지 추정)
// totalUsd·globalUsd = 모든 회사 합과 전체 상한 (합을 못 읽은 옛 DB 면 없음). exceeded 는 둘 중 하나라도 넘으면 참
export interface LlmSpendView { round: string; usd: number; budgetUsd: number; calls: number; exceeded: boolean; totalUsd?: number; globalUsd?: number }
export const llmSpendView = (b: LlmBudget, s: { usd: number; calls: number; totalUsd?: number }): LlmSpendView => {
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const global = s.totalUsd !== undefined ? { totalUsd: r6(s.totalUsd), globalUsd: b.globalUsd } : {};
  return { round: b.round, usd: r6(s.usd), budgetUsd: b.budgetUsd, calls: s.calls,
    exceeded: s.usd >= b.budgetUsd || (s.totalUsd !== undefined && s.totalUsd >= b.globalUsd), ...global };
};
