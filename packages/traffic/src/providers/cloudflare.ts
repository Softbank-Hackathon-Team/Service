import { checkWeights, ProviderError, type TrafficSwitcher, type Weights } from "../switcher.js";
import type { FetchLike, TokenSource } from "./http.js";
import { HttpTimeout, jsonRequest, redactUrl } from "./http.js";

// Cloudflare Load Balancer 가중치 전환 (기본 경로. 클라우드가 달라도 앞단 하나로 나눌 수 있어서)
// DECISION(team): 트래픽 전환은 Cloudflare LB pool 가중치 (10/30 아키텍처 결정, 명세 FR-MIG-04)
//
// 【사실】 공식 API 문서로 확인한 것 (developers.cloudflare.com/api/resources/load_balancers, 2026-10-31 Z14)
//  - LB 수정: PATCH /zones/{zone_id}/load_balancers/{load_balancer_id} (부분 수정. 적은 필드만 바뀐다)
//  - random_steering.default_weight: 0~1, 0.1 단위. pool_weights: pool ID → 가중치 (다른 pool 과의 상대값)
//  - steering_policy: "off" | "geo" | "random" | "dynamic_latency" | "proximity" | "least_outstanding_requests"
//    | "least_connections" | "" ("" 는 region/country/pop pool 이 없으면 "off" = default_pools 순서대로 failover)
//  - session_affinity: "none" | "cookie" | "ip_cookie" | "header"
//  - 모니터·pool 은 계정 아래 자원(/accounts/{account_id}/load_balancers/monitors|pools), LB 만 zone 아래
// 토큰 권한: Zone · Load Balancers: Edit (LB 수정). 모니터·pool 을 만드는 검증 스크립트는 Account · Load Balancing: Monitors and Pools: Edit 도 필요
export interface CloudflareLbConfig {
  // Z14: zoneId 가 없으면 zoneName 으로 한 번 조회해서 기억한다 (.env 에는 CLOUDFLARE_ZONE_NAME 만 있다)
  zoneId?: string;
  zoneName?: string;
  sourcePoolId: string;
  targetPoolId: string;
  token: TokenSource;
  fetch?: FetchLike;
  baseUrl?: string;   // 시험용
  timeoutMs?: number; // 요청 하나 시간 제한. 기본 10초
}

interface CfEnvelope<T> { success: boolean; errors?: Array<{ code: number; message: string }>; result: T }
export interface CfLoadBalancer {
  id: string;
  name?: string;
  enabled?: boolean;
  proxied?: boolean;
  steering_policy?: string;
  session_affinity?: string;
  fallback_pool?: string;
  default_pools?: string[];
  random_steering?: { default_weight?: number; pool_weights?: Record<string, number> };
}
export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// 순수 함수: PATCH 본문. 두 pool 만 적고 나머지는 default_weight 0 으로 막는다
export function cloudflarePatchBody(c: Pick<CloudflareLbConfig, "sourcePoolId" | "targetPoolId">, w: Weights) {
  checkWeights(w);
  return {
    steering_policy: "random",
    random_steering: {
      default_weight: 0,
      pool_weights: { [c.sourcePoolId]: round1(w.source), [c.targetPoolId]: round1(w.target) },
    },
  };
}

// 순수 함수: GET 결과 → 비율. 적히지 않은 pool 은 default_weight 를 따른다
// Z14-02: 정책이 "off" 이거나 "" (= off) 면 default_pools 의 첫 번째(건강하면)로만 간다. 예전 코드는 "" 를 random 으로 봤다
export function cloudflareWeightsOf(c: Pick<CloudflareLbConfig, "sourcePoolId" | "targetPoolId">, lb: CfLoadBalancer): Weights {
  const policy = lb.steering_policy ?? "";
  if (policy !== "random") {
    const first = lb.default_pools?.[0];
    if (first === c.targetPoolId) return { source: 0, target: 1 };
    // 출발이 첫 번째이거나 모르는 정책이면 출발 쪽으로 본다 (롤백 확인을 낙관하지 않게, 컨트롤러는 random 이 아니면 PATCH 로 바꾼다)
    return { source: 1, target: 0 };
  }
  const pw = lb.random_steering?.pool_weights ?? {};
  // 【미확인】 default_weight 를 안 적었을 때 기본값. 문서에 기본값이 없다 → 1 로 본다 (예전과 같음). PATCH 는 항상 0 을 적는다
  const dw = lb.random_steering?.default_weight ?? 1;
  const s = pw[c.sourcePoolId] ?? dw, t = pw[c.targetPoolId] ?? dw;
  const sum = s + t;
  if (sum <= 0) return { source: 0, target: 0 };
  return { source: round1(s / sum), target: round1(t / sum) };
}

// 순수 함수: 전환 전에 LB 설정이 설계 조건을 지키는지 본다 (트래픽 전환 설계 v1)
//  - LB 가 켜져 있어야 (Z14: enabled=false 면 가중치를 바꿔도 아무 일 없다)
//  - proxied 모드만 (DNS-only 는 TTL 때문에 롤백이 늦다)
//  - session_affinity none (쿠키로 묶이면 롤백해도 도착에 남는다)
//  - fallback_pool = 출발 (도착이 모니터에 죽으면 출발로)
//  - 두 pool 모두 default_pools 에 있어야 가중치가 먹는다
//  - 그 밖의 pool 이 default_pools 에 있으면 default_weight 0 으로 막히지만, 경고로 알린다 (Z14)
export function cloudflarePreflight(c: Pick<CloudflareLbConfig, "sourcePoolId" | "targetPoolId">, lb: CfLoadBalancer): string[] {
  const issues: string[] = [];
  if (lb.enabled === false) issues.push("CF_LB_DISABLED");
  if (lb.proxied === false) issues.push("CF_NOT_PROXIED");
  if (lb.session_affinity && lb.session_affinity !== "none") issues.push("CF_SESSION_AFFINITY");
  if (lb.fallback_pool && lb.fallback_pool !== c.sourcePoolId) issues.push("CF_FALLBACK_NOT_SOURCE");
  const pools = lb.default_pools ?? [];
  if (!pools.includes(c.sourcePoolId) || !pools.includes(c.targetPoolId)) issues.push("CF_POOLS_MISSING");
  if (pools.some((p) => p !== c.sourcePoolId && p !== c.targetPoolId)) issues.push("CF_EXTRA_POOLS");
  return issues;
}

// 경고일 뿐 전환을 막지 않는 코드 (controller 는 이것만 있으면 계속 간다)
export const CF_PREFLIGHT_WARN_ONLY = new Set(["CF_EXTRA_POOLS"]);

// 순수 함수: Cloudflare 오류 → 다시 해도 되는가
// 【사실】 429 = 5분 차단 (위 switcher.ts 주석의 문서). 401/403 = 토큰·권한, 404 = 없는 LB, 400 = 본문 문제 → 다시 해도 같다
// 【추정】 Cloudflare 오류 code 10000 = Authentication error (위 시험의 403 응답 모양, 실제 응답으로 확인 필요)
export function cloudflareRetryable(status: number): boolean {
  if (status === 0) return true;            // 시간 초과·네트워크
  if (status === 429) return false;
  if (status >= 500) return true;
  return false;
}

// 요청 하나. 검증 스크립트(scripts/cf-check.ts)도 같은 함수를 쓴다 (오류 처리·시간 제한이 같게)
export async function cfRequest<T>(o: { fetch?: FetchLike; token: TokenSource; baseUrl?: string; timeoutMs?: number },
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const url = `${o.baseUrl ?? CF_API_BASE}${path}`;
  let res: Awaited<ReturnType<typeof jsonRequest>>;
  try {
    res = await jsonRequest(o.fetch, method, url, await o.token(), body, { timeoutMs: o.timeoutMs });
  } catch (e) {
    const why = e instanceof HttpTimeout ? e.message : `네트워크 오류: ${(e as Error).message}`;
    throw new ProviderError("cloudflare", 0, `Cloudflare ${method} ${redactUrl(path)} 실패: ${why}`, { retryable: true });
  }
  const env = res.body as CfEnvelope<T> | null;
  if (res.status >= 400 || !env?.success) {
    const codes = env?.errors?.map((e) => e.code) ?? [];
    const msg = env?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
    const hint = res.status === 429 ? ` (속도 제한: 5분 기다린 뒤 다시${res.retryAfter ? `, retry-after ${res.retryAfter}` : ""})` : "";
    // success=false 인데 2xx 인 경우는 문서에 없다 → 다시 해 볼 만한 것으로 본다
    const status = res.status >= 400 ? res.status : 500;
    throw new ProviderError("cloudflare", res.status, `Cloudflare ${method} ${redactUrl(path)} 실패: ${msg}${hint}`,
      { retryable: cloudflareRetryable(status), providerCodes: codes });
  }
  return env.result;
}

// zone 이름 → zone id (+ 계정 id). 검증 스크립트도 쓴다
// 【추정】 zone 하나로 묶인 토큰이면 GET /zones?name= 이 그 zone 하나를 돌려준다. 권한이 모자라면 빈 목록 → 오류
export async function cfZoneByName(o: Parameters<typeof cfRequest>[0], name: string): Promise<{ id: string; accountId: string | null; plan: string | null }> {
  const zones = await cfRequest<Array<{ id: string; name: string; account?: { id?: string }; plan?: { name?: string } }>>(
    o, "GET", `/zones?name=${encodeURIComponent(name)}`);
  const z = zones.find((x) => x.name === name);
  if (!z) throw new ProviderError("cloudflare", 404, `zone ${name} 이 안 보인다 (이름 오타 또는 토큰 zone 범위 확인)`, { retryable: false });
  return { id: z.id, accountId: z.account?.id ?? null, plan: z.plan?.name ?? null };
}

export function cloudflareLb(c: CloudflareLbConfig): TrafficSwitcher & { describe(lbId: string): Promise<CfLoadBalancer> } {
  if (!c.zoneId && !c.zoneName) throw new Error("Cloudflare: zoneId 또는 zoneName 이 필요하다");
  const req = { fetch: c.fetch, token: c.token, baseUrl: c.baseUrl, timeoutMs: c.timeoutMs };
  let zoneId: Promise<string> | null = c.zoneId ? Promise.resolve(c.zoneId) : null;
  const zone = () => {
    // 실패하면 기억하지 않는다 (다음 호출에서 다시 조회)
    zoneId ??= cfZoneByName(req, c.zoneName!).then((z) => z.id).catch((e) => { zoneId = null; throw e; });
    return zoneId;
  };
  const path = async (lbId: string) => `/zones/${encodeURIComponent(await zone())}/load_balancers/${encodeURIComponent(lbId)}`;
  const describe = async (lbId: string) => cfRequest<CfLoadBalancer>(req, "GET", await path(lbId));
  return {
    provider: "cloudflare",
    describe,
    async get(lbId) { return cloudflareWeightsOf(c, await describe(lbId)); },
    async set(lbId, w) { await cfRequest(req, "PATCH", await path(lbId), cloudflarePatchBody(c, w)); },
    // pf-d FM-TRF-13: fallback_pool 만 바꾼다 (부분 PATCH, 가중치는 그대로)
    async setFallback(lbId, side) { await cfRequest(req, "PATCH", await path(lbId), { fallback_pool: side === "target" ? c.targetPoolId : c.sourcePoolId }); },
    async getFallback(lbId) {
      const f = (await describe(lbId)).fallback_pool;
      return f === c.targetPoolId ? "target" : f === c.sourcePoolId ? "source" : f ? "other" : null;
    },
    // #245: 풀은 계정 아래 자원이라 zone → 계정을 먼저 읽는다. 토큰에 Zone Read, Account Load Balancing: Monitors and Pools Read 가 더 필요하다
    async sourceOrigins() {
      const z = await cfRequest<{ account?: { id?: string } }>(req, "GET", `/zones/${encodeURIComponent(await zone())}`);
      if (!z.account?.id) throw new ProviderError("cloudflare", 404, "zone 의 계정 번호가 안 보인다", { retryable: false });
      const pool = await cfRequest<{ origins?: Array<{ address?: string; enabled?: boolean }> }>(req, "GET",
        `/accounts/${encodeURIComponent(z.account.id)}/load_balancers/pools/${encodeURIComponent(c.sourcePoolId)}`);
      return (pool.origins ?? []).filter((x) => x.enabled !== false && x.address).map((x) => x.address!);
    },
    // 막아야 하는 문제만 돌려준다 (CF_EXTRA_POOLS 같은 경고는 뺀다)
    async preflight(lbId) { return cloudflarePreflight(c, await describe(lbId)).filter((x) => !CF_PREFLIGHT_WARN_ONLY.has(x)); },
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
