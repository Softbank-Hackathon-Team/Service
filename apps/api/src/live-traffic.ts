import { z } from "zod";

// "가동 중 앱을 숫자로" (작업 Z35 = Z15 제안 3, DRAFT(ai))
// 앱 앞 프록시(tools/load/live-app/switch-proxy.mjs, Z31 hold 프록시가 대신할 수 있음)가 /__stats 로 내놓는 숫자를
// 이전 상세 화면이 읽을 수 있게 모양을 맞춘다.
//
// 왜 프록시 숫자인가: 사용자 요청은 전부 프록시를 지나간다. 부하기(writer.mjs) 숫자는 부하기 한 대의 시점이고,
// Prometheus(PROM_URL)는 맥 데모에 아직 없다. 프록시는 "앱에 들어온 요청 전부"를 본다.
// 대안(버림): 부하기가 API 로 숫자를 POST → 쓰기 경로·인증이 하나 더 생김. Prometheus 질의 → 데모 PC 에 구성 하나 더.
//
// 비밀·SSRF: 읽는 주소는 서버 환경변수 LIVE_TRAFFIC_URL 하나뿐이다. 요청에서 주소를 받지 않는다.

// 프록시 /__stats 모양 (v1). 옛 프록시(숫자 칸 없음)도 받도록 숫자 칸은 전부 선택
export const ProxyStats = z.object({
  id: z.string().nullable(),
  status: z.string(),
  switchedAt: z.string().nullable().optional(),
  held: z.number().int().nonnegative().optional(),
  maxHoldMs: z.number().nonnegative().optional(),
  mode: z.string().optional(),
  since: z.string().optional(),
  total: z.number().int().nonnegative().optional(),
  ok: z.number().int().nonnegative().optional(),
  fail: z.number().int().nonnegative().optional(),
  c4xx: z.number().int().nonnegative().optional(),
  p50Ms: z.number().nonnegative().nullable().optional(),
  p95Ms: z.number().nonnegative().nullable().optional(),
  byState: z.record(z.string(), z.object({
    n: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    p95Ms: z.number().nonnegative().nullable(),
  })).optional(),
});
export type ProxyStats = z.infer<typeof ProxyStats>;

export const LiveTrafficUnavailableReason = z.enum(["not_configured", "unreachable", "bad_shape", "other_migration", "no_counters"]);

// TODO(통합): 이 모양을 packages/contracts 로 옮긴다 (proposals/contracts-live-traffic.md)
export const LiveTrafficView = z.object({
  migrationId: z.uuid(),
  available: z.boolean(),
  reason: LiveTrafficUnavailableReason.optional(),
  source: z.literal("proxy"),
  fetchedAt: z.string(),
  total: z.number().int(),
  ok: z.number().int(),
  fail: z.number().int(),
  c4xx: z.number().int(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  held: z.number().int(),
  maxHoldMs: z.number(),
  mode: z.string().nullable(),
  switchedAt: z.string().nullable(),
  since: z.string().nullable(),
  // 이전 상태별 묶음. 순서 = 정상 경로 순서, 모르는 상태는 뒤
  byState: z.array(z.object({ state: z.string(), n: z.number().int(), fail: z.number().int(), p95Ms: z.number().nullable() })),
});
export type LiveTrafficView = z.infer<typeof LiveTrafficView>;

const STATE_ORDER = ["before", "draft", "importing", "spec_review", "prechecking", "planning", "awaiting_approval", "approved",
  "provisioning", "deploying", "syncing", "shifting", "cutover", "rollback_window", "cleanup", "completed",
  "paused", "rolling_back", "rolled_back", "failed", "cancelled"];

function empty(migrationId: string, reason: z.infer<typeof LiveTrafficUnavailableReason>, now: Date): LiveTrafficView {
  return { migrationId, available: false, reason, source: "proxy", fetchedAt: now.toISOString(),
    total: 0, ok: 0, fail: 0, c4xx: 0, p50Ms: null, p95Ms: null, held: 0, maxHoldMs: 0, mode: null, switchedAt: null, since: null, byState: [] };
}

// 순수 함수: 프록시 원본 → 화면 모양. 다른 이전을 보고 있으면 숫자를 내보내지 않는다 (남의 숫자를 내 것처럼 보이지 않게)
export function toLiveView(migrationId: string, raw: unknown, now = new Date()): LiveTrafficView {
  const p = ProxyStats.safeParse(raw);
  if (!p.success) return empty(migrationId, "bad_shape", now);
  const s = p.data;
  if (s.id !== migrationId) return empty(migrationId, "other_migration", now);
  if (s.total === undefined) return { ...empty(migrationId, "no_counters", now), held: s.held ?? 0, maxHoldMs: s.maxHoldMs ?? 0,
    mode: s.mode ?? null, switchedAt: s.switchedAt ?? null };
  const rank = (x: string) => { const i = STATE_ORDER.indexOf(x); return i < 0 ? STATE_ORDER.length : i; };
  const byState = Object.entries(s.byState ?? {})
    .map(([state, v]) => ({ state, n: v.n, fail: v.fail, p95Ms: v.p95Ms }))
    .sort((a, b) => rank(a.state) - rank(b.state) || a.state.localeCompare(b.state));
  return {
    migrationId, available: true, source: "proxy", fetchedAt: now.toISOString(),
    total: s.total, ok: s.ok ?? 0, fail: s.fail ?? 0, c4xx: s.c4xx ?? 0,
    p50Ms: s.p50Ms ?? null, p95Ms: s.p95Ms ?? null, held: s.held ?? 0, maxHoldMs: s.maxHoldMs ?? 0,
    mode: s.mode ?? null, switchedAt: s.switchedAt ?? null, since: s.since ?? null, byState,
  };
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// LIVE_TRAFFIC_URL 은 /__stats 까지 쓴 전체 주소. 예: http://localhost:8090/__stats
// DRAFT(ai): 시간 제한 800ms. 화면이 1초마다 부르므로 그보다 짧게 (프록시가 죽어도 상세 화면이 느려지지 않게)
export async function readLiveTraffic(migrationId: string, o: { url?: string; fetch?: FetchLike; timeoutMs?: number; now?: () => Date } = {}): Promise<LiveTrafficView> {
  const now = o.now ?? (() => new Date());
  if (!o.url) return empty(migrationId, "not_configured", now());
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), o.timeoutMs ?? 800);
  try {
    const res = await f(o.url, { signal: ac.signal });
    if (!res.ok) return empty(migrationId, "unreachable", now());
    return toLiveView(migrationId, await res.json(), now());
  } catch {
    return empty(migrationId, "unreachable", now());
  } finally { clearTimeout(t); }
}
