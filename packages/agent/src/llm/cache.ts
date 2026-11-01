import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { LlmMessage, LlmProvider, LlmResponse } from "../ai/llm.js";

// 작업 z75-59: 실제 Claude API 응답 캐시 (가짜 아님). 같은 회사가 같은 모델·같은 요청을 다시 보내면 저장해 둔 응답을 돌려준다.
//   - 열쇠 = sha256(판 번호 + 모델 + 호출 설정(effort·출력 상한) + system + tools + messages). 정확히 같은 요청만 맞는다 (뜻이 비슷한 요청은 안 맞춘다)
//   - 회사(tenant) 범위: 저장소가 tenant_id 로 나누고, 회사를 모르면 캐시를 안 쓴다 (늘 실제 호출)
//   - 첫 호출은 늘 실제 API. 끝까지 정상으로 끝난 응답(end_turn·tool_use)만 저장한다. max_tokens·refusal·오류는 저장 안 함
//   - 저장 기간 기본 24시간 (AGENT_LLM_CACHE_TTL_SEC). 저장소 오류는 "없음"으로 보고 실제 호출 (캐시가 실행을 깨면 안 된다)
// 데모 초기화 뒤에도 맞게: 이전·실행 번호(UUID)와 ISO 시각은 열쇠를 만들 때 나온 순서대로 자리표(__LLMC_U1__ 등)로 바꾸고,
//   응답에도 같은 자리표를 넣어 저장했다가 꺼낼 때 지금 요청의 값으로 되돌린다 (다른 이전 번호가 응답에 섞이지 않게).
//   생각(thinking) 블록은 서명이 내용에 묶여 있어 바꾸지 않고, 열쇠에서도 뺀다 (뺀 채로 같은 대화면 같은 열쇠)

export const LLM_CACHE_TTL_SEC = 24 * 60 * 60;
// 열쇠 판 번호. 열쇠 만드는 법을 바꾸면 올린다 (옛 줄은 자연히 안 맞고 24시간 뒤 버려진다)
const KEY_VERSION = "llmc1";

export interface LlmCacheStore {
  get(tenantId: string, key: string): Promise<{ response: LlmResponse } | null>;
  put(tenantId: string, key: string, e: { model: string; response: LlmResponse; ttlSec: number }): Promise<void>;
}

// 실행 하나(작업 하나) 동안 맞음·안 맞음 수. 감사 detail 의 cache_hit 에 쓴다
// z75-64: 실제 호출 지출도 같이 센다 (budget.ts). usd = 이 실행에서 쓴 달러, roundUsd = 이 회차 누적, budgetUsd·round = 상한·회차
export interface LlmCacheTally { hits: number; misses: number; usd?: number; roundUsd?: number; budgetUsd?: number; round?: string }
const tallyStore = new AsyncLocalStorage<LlmCacheTally>();
export function withLlmCacheTally<T>(fn: () => T): T { return tallyStore.run({ hits: 0, misses: 0 }, fn); }
export function currentLlmCacheTally(): LlmCacheTally | undefined { return tallyStore.getStore(); }
/** 감사 detail 에 붙일 칸. 캐시를 거친 호출이 없으면(가짜·키 없음·캐시 꺼짐) 빈 객체 → 예전 detail 그대로 */
export function llmCacheAuditDetail(t = currentLlmCacheTally()): Record<string, unknown> {
  if (!t) return {};
  const spend = t.round !== undefined
    ? { llm_usd: Math.round((t.usd ?? 0) * 1e6) / 1e6, llm_round_usd: Math.round((t.roundUsd ?? 0) * 1e6) / 1e6, llm_budget_usd: t.budgetUsd, llm_round: t.round }
    : {};
  if (t.hits + t.misses === 0) return spend;
  return { cache_hit: t.misses === 0, cache_hits: t.hits, cache_misses: t.misses, ...spend };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const TOKEN = /__LLMC_([UT])(\d+)__/g;
const isThinking = (b: unknown) => {
  const t = (b as { type?: unknown } | null)?.type;
  return t === "thinking" || t === "redacted_thinking";
};

// 키 순서를 고정한 JSON (같은 값이면 같은 글자)
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// 요청 안의 UUID·ISO 시각 → 자리표. 처음 나온 순서대로 번호를 매긴다 (같은 값은 같은 번호)
export interface Placeholders { toToken: Map<string, string>; fromToken: Map<string, string> }
function tokenize(s: string, ph: Placeholders): string {
  const sub = (kind: "U" | "T") => (m: string) => {
    const k = kind === "U" ? m.toLowerCase() : m;
    let t = ph.toToken.get(k);
    if (!t) { t = `__LLMC_${kind}${ph.toToken.size + 1}__`; ph.toToken.set(k, t); ph.fromToken.set(t, m); }
    return t;
  };
  return s.replace(UUID, sub("U")).replace(ISO, sub("T"));
}
// 생각 블록을 뺀 messages (열쇠용)
function withoutThinking(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => ({ role: m.role,
    content: Array.isArray(m.content) ? (m.content as unknown[]).filter((b) => !isThinking(b)) : m.content }));
}

export function llmCacheKey(req: { system: string; tools: unknown[]; messages: LlmMessage[]; maxTokens?: number },
  o: { model: string; salt?: string }): { key: string; ph: Placeholders } {
  const ph: Placeholders = { toToken: new Map(), fromToken: new Map() };
  const body = tokenize(stableJson({ v: KEY_VERSION, model: o.model, salt: o.salt ?? "", maxTokens: req.maxTokens ?? null,
    system: req.system, tools: req.tools, messages: withoutThinking(req.messages) }), ph);
  return { key: createHash("sha256").update(body).digest("hex"), ph };
}

// 응답 → 저장 모양 (지금 요청에 나온 값만 자리표로. 생각 블록은 그대로)
function toStored(r: LlmResponse, ph: Placeholders): LlmResponse {
  const swap = (x: unknown) => {
    let s = JSON.stringify(x);
    for (const [v, t] of ph.toToken) s = s.split(v).join(t);
    return JSON.parse(s) as unknown;
  };
  // UUID 는 소문자로 맞춰 넣었으니 응답 쪽 대문자 UUID 도 같은 것으로 본다
  const swapCase = (x: unknown) => swap(JSON.parse(JSON.stringify(x).replace(UUID, (m) => (ph.toToken.has(m.toLowerCase()) ? m.toLowerCase() : m))));
  return { ...r,
    content: r.content.map((b) => swapCase(b) as LlmResponse["content"][number]),
    ...(r.raw ? { raw: r.raw.map((b) => (isThinking(b) ? b : swapCase(b))) } : {}) };
}
// 저장 모양 → 응답 (자리표를 지금 요청의 값으로)
function fromStored(r: LlmResponse, ph: Placeholders): LlmResponse {
  const back = (x: unknown) => JSON.parse(JSON.stringify(x).replace(TOKEN, (t) => {
    const v = ph.fromToken.get(t);
    return v === undefined ? t : JSON.stringify(v).slice(1, -1);
  })) as unknown;
  return { ...r,
    content: r.content.map((b) => back(b) as LlmResponse["content"][number]),
    ...(r.raw ? { raw: r.raw.map((b) => (isThinking(b) ? b : back(b))) } : {}) };
}

export interface CachedLlmOptions {
  store: LlmCacheStore;
  tenantOf: () => string | undefined;      // 지금 작업의 회사 (agent-worker 는 로그 문맥의 tenant_id)
  ttlSec?: number;
  salt?: string;                            // 모델 말고 응답을 바꾸는 호출 설정 (effort·출력 상한)
  onError?: (where: "get" | "put", e: unknown) => void;
}

export function cachedLlm(inner: LlmProvider, o: CachedLlmOptions): LlmProvider {
  const ttlSec = o.ttlSec ?? LLM_CACHE_TTL_SEC;
  return {
    model: inner.model,
    async create(req) {
      const tenantId = o.tenantOf();
      if (!tenantId) return inner.create(req);
      const tally = currentLlmCacheTally();
      const { key, ph } = llmCacheKey(req, { model: inner.model, salt: o.salt });
      let found: { response: LlmResponse } | null = null;
      try { found = await o.store.get(tenantId, key); } catch (e) { o.onError?.("get", e); }
      if (found) {
        if (tally) tally.hits++;
        return { ...fromStored(found.response, ph), cacheHit: true };
      }
      if (tally) tally.misses++;
      const res = await inner.create(req);
      if (res.stop_reason === "end_turn" || res.stop_reason === "tool_use") {
        try { await o.store.put(tenantId, key, { model: res.model ?? inner.model, response: toStored(res, ph), ttlSec }); }
        catch (e) { o.onError?.("put", e); }
      }
      return { ...res, cacheHit: false };
    },
  };
}

/** 메모리 저장소 (시험·단독 실행용). 시계는 주입 */
export function memoryLlmCacheStore(now: () => number = () => Date.now()): LlmCacheStore & { size(): number } {
  const m = new Map<string, { response: LlmResponse; exp: number }>();
  return {
    size: () => m.size,
    async get(t, k) {
      const e = m.get(`${t}:${k}`);
      if (!e || e.exp <= now()) return null;
      return { response: structuredClone(e.response) };
    },
    async put(t, k, e) { m.set(`${t}:${k}`, { response: structuredClone(e.response), exp: now() + e.ttlSec * 1000 }); },
  };
}

/** AGENT_LLM_CACHE=0 이면 끔. AGENT_LLM_CACHE_TTL_SEC 기본 86400 (60~604800) */
export function llmCacheConfigFromEnv(env: Record<string, string | undefined> = process.env): { enabled: boolean; ttlSec: number } {
  const enabled = env.AGENT_LLM_CACHE?.trim() !== "0";
  const raw = env.AGENT_LLM_CACHE_TTL_SEC?.trim();
  if (!raw) return { enabled, ttlSec: LLM_CACHE_TTL_SEC };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 60 || n > 604_800) throw new Error(`AGENT_LLM_CACHE_TTL_SEC 값이 틀림: ${raw} (60~604800)`);
  return { enabled, ttlSec: n };
}
