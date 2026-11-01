import { LLM_BUDGET_EXCEEDED } from "@svc/contracts";
import type { LlmProvider, LlmResponse } from "../ai/llm.js";
import { PRICE_PER_MTOK, estimateUsd } from "./anthropic.js";
import { currentLlmCacheTally } from "./cache.js";

// z75-64: 실제 LLM 지출 상한. 실제 API 를 부르기 전에 이 회사·이 회차에 쓴 달러를 보고, 상한 이상이면 부르지 않고 LLM_BUDGET_EXCEEDED 로 실패한다.
//   부른 뒤에는 응답의 토큰 × 단가(estimateUsd, 캐시 읽기·쓰기 토큰 포함)를 DB 한 줄에 더한다 (UPDATE … usd = usd + x, 동시에 불러도 안 잃음)
//   캐시(cache.ts)는 이 바깥에 씌운다 → 캐시에서 꺼낸 응답은 여기까지 안 와서 0원
//   가격표에 없는 모델은 가장 비싼 표 값으로 센다 (적게 세서 상한을 넘기지 않게)
//   한계: 확인과 더하기 사이에 다른 호출이 끼면 마지막 한 번만큼 넘을 수 있다 (호출 1번 ≈ $0.01~0.06, Z71 실측). 상한을 넘긴 뒤 새 호출은 다 막힌다

export class LlmBudgetExceededError extends Error {
  readonly code = LLM_BUDGET_EXCEEDED;
  // scope: tenant = 이 회사 상한, global = 모든 회사 합 상한 (Z38 R8-48)
  constructor(readonly usd: number, readonly budgetUsd: number, readonly round: string, readonly scope: "tenant" | "global" = "tenant") {
    super(`LLM 지출 상한 넘음${scope === "global" ? "(전체 합)" : ""}: 회차 ${round} $${usd.toFixed(4)} / 상한 $${budgetUsd}`);
    this.name = "LlmBudgetExceededError";
  }
}

export interface LlmSpendStore {
  get(tenantId: string, round: string): Promise<{ usd: number; calls: number }>;
  add(tenantId: string, round: string, usd: number): Promise<{ usd: number; calls: number }>;
  /** 이 회차 모든 회사 합 (전체 상한용). 없으면 전체 상한을 안 본다 */
  total?(round: string): Promise<number>;
}

// 응답 한 번의 달러. anthropicProvider 가 붙인 usd(캐시 토큰 포함)를 쓰고, 없으면 입력·출력 토큰으로 센다
export function responseUsd(model: string, r: LlmResponse): number {
  if (typeof r.usd === "number") return r.usd;
  const known = estimateUsd(model, r.usage);
  if (known !== null) return known;
  const max = Object.values(PRICE_PER_MTOK).reduce((a, p) => ({ input: Math.max(a.input, p.input), output: Math.max(a.output, p.output) }), { input: 0, output: 0 });
  return (r.usage.input_tokens * max.input + r.usage.output_tokens * max.output) / 1e6;
}

export interface BudgetedLlmOptions {
  store: LlmSpendStore;
  tenantOf: () => string | undefined;
  budgetUsd: number;
  round: string;
  globalUsd?: number;                       // 모든 회사 합 상한 (store.total 이 있을 때만)
  onError?: (where: "get" | "add", e: unknown) => void;
}

export function budgetedLlm(inner: LlmProvider, o: BudgetedLlmOptions): LlmProvider {
  return {
    model: inner.model,
    async create(req) {
      const tenantId = o.tenantOf();
      // 회사를 모르면 막는다 (누구 돈인지 모르는 실제 호출은 하지 않는다)
      if (!tenantId) throw new LlmBudgetExceededError(0, o.budgetUsd, o.round);
      const tally = currentLlmCacheTally();
      let spent: { usd: number; calls: number };
      // 지출 표를 못 읽으면 부르지 않는다 (상한을 지킬 수 없으면 쓰지 않는 쪽)
      try { spent = await o.store.get(tenantId, o.round); }
      catch (e) { o.onError?.("get", e); throw new LlmBudgetExceededError(Number.NaN, o.budgetUsd, o.round); }
      if (tally) { tally.roundUsd = spent.usd; tally.budgetUsd = o.budgetUsd; tally.round = o.round; }
      if (spent.usd >= o.budgetUsd) throw new LlmBudgetExceededError(spent.usd, o.budgetUsd, o.round);
      if (o.globalUsd !== undefined && o.store.total) {
        let total: number;
        try { total = await o.store.total(o.round); }
        catch (e) { o.onError?.("get", e); throw new LlmBudgetExceededError(Number.NaN, o.globalUsd, o.round, "global"); }
        if (total >= o.globalUsd) throw new LlmBudgetExceededError(total, o.globalUsd, o.round, "global");
      }
      const res = await inner.create(req);
      const usd = responseUsd(res.model ?? inner.model, res);
      try {
        const after = await o.store.add(tenantId, o.round, usd);
        if (tally) tally.roundUsd = after.usd;
      } catch (e) { o.onError?.("add", e); }
      if (tally) tally.usd = (tally.usd ?? 0) + usd;
      return { ...res, usd };
    },
  };
}

export function memoryLlmSpendStore(): Required<LlmSpendStore> & { rows: Map<string, { usd: number; calls: number }> } {
  const rows = new Map<string, { usd: number; calls: number }>();
  return {
    rows,
    async get(t, r) { return { ...(rows.get(`${t}:${r}`) ?? { usd: 0, calls: 0 }) }; },
    async add(t, r, usd) {
      const k = `${t}:${r}`; const cur = rows.get(k) ?? { usd: 0, calls: 0 };
      const next = { usd: cur.usd + usd, calls: cur.calls + 1 }; rows.set(k, next); return { ...next };
    },
    async total(r) { let s = 0; for (const [k, v] of rows) if (k.endsWith(`:${r}`)) s += v.usd; return s; },
  };
}
