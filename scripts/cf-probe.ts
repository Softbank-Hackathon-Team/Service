// Z70-2 DRAFT(ai): cf-check --probe 가 쓰는 LB 주소 요청 도우미.
// 맥 실측 실패(10/31 21:1xZ)【사실】: LB 를 만들자마자 probe 가 돌아, 맥 시스템 리졸버가 cf-check.<zone> 의
//   "없음" 답을 캐시(negative cache)했다 → 4단계 모두 오류 50/50. dig 는 풀리는데 getaddrinfo(fetch)는 "Could not resolve host".
// 고침:
//   1) 첫 probe 전에 시스템 리졸버를 거치지 않고 공개 DNS(기본 1.1.1.1, 1.0.0.1)에 직접 물어, 이름이 풀릴 때까지 기다린다 (기본 120초)
//   2) 그 뒤 요청은 lookup 옵션으로 그 주소에 바로 붙는다 (getaddrinfo·OS 캐시를 안 탄다). TLS SNI·Host 는 LB 이름 그대로
// 대안 "probe 를 hold 뒤로 미루기" 는 버림: hold 시간(기본 5초)이 negative cache TTL(구역 SOA minimum, 보통 30분대)보다 짧아 안 고쳐진다
// 대안 "sudo dscacheutil -flushcache" 는 버림: 사람 손·관리자 권한이 필요하고 VM·CI 에서 못 쓴다
import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { LookupFunction } from "node:net";

export interface Resolve4 { (host: string): Promise<string[]> }

export function dnsServersFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CF_CHECK_DNS_SERVERS || "1.1.1.1,1.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Z38 REVIEW-7 R7-5: 구역의 권한 서버(NS) 주소. 공개 리졸버(1.1.1.1)도 "없음" 답을 캐시한다(RFC 2308, SOA minimum 동안).
 *  LB 를 만들자마자 1.1.1.1 에 물으면 그 리졸버가 NXDOMAIN 을 쥐고 있어 120초 안에 안 풀릴 수 있다 → 캐시가 없는 권한 서버에 묻는다.
 *  NS 이름·주소는 오래 전부터 있던 레코드라 공개 리졸버로 찾아도 된다. 실패하면 빈 배열 (부른 쪽이 공개 DNS 로 간다) */
export async function authServers(zone: string, base: string[],
  r: { resolveNs(h: string): Promise<string[]>; resolve4(h: string): Promise<string[]> } = (() => {
    const x = new Resolver({ timeout: 3000, tries: 1 }); x.setServers(base); return x; })()): Promise<string[]> {
  try {
    const ns = (await r.resolveNs(zone)).slice(0, 4);
    const addrs = (await Promise.all(ns.map((n) => r.resolve4(n).catch(() => [] as string[])))).flat();
    return [...new Set(addrs)];
  } catch { return []; }
}

/** LB 이름에서 구역 이름 (CLOUDFLARE_ZONE_NAME 이 없을 때만 쓰는 어림값: 마지막 두 칸) */
export const zoneOf = (host: string) => host.split(".").slice(-2).join(".");

/** 시스템 리졸버 대신 지정한 DNS 서버에 직접 묻는 resolve4 */
export function directResolve4(servers: string[]): Resolve4 {
  const r = new Resolver({ timeout: 3000, tries: 1 });
  r.setServers(servers);
  return (host) => r.resolve4(host);
}

/** 직접 질의가 막힌 망(53번 차단, 이 클라우드 VM 이 그렇다【사실】)용 예비 길: 직접 → 실패하면 시스템 리졸버.
 *  기본은 끔 (CF_CHECK_DNS_FALLBACK=system 일 때만). 확정 방식(Z62)은 "캐시 비우기가 아니라 캐시 안 쓰기" 라 시스템 리졸버를 기본으로 타지 않는다 */
export function withSystemFallback(primary: Resolve4, system: Resolve4 = async (h) =>
  (await (await import("node:dns/promises")).lookup(h, { all: true, family: 4 })).map((x) => x.address)): Resolve4 {
  return async (host) => {
    try { const a = await primary(host); if (a.length) return a; } catch { /* 아래로 */ }
    return system(host);
  };
}

export interface WaitResult { addrs: string[]; waitedMs: number; tries: number; lastError?: string }

/** 이름이 풀릴 때까지 기다린다. 제한 시간 안에 못 풀면 addrs 가 빈 배열 */
export async function waitResolvable(host: string, o: { resolve4: Resolve4; timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<WaitResult> {
  const now = o.now ?? (() => performance.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = o.timeoutMs ?? 120_000, intervalMs = o.intervalMs ?? 2000;
  const t0 = now();
  let tries = 0, lastError: string | undefined;
  for (;;) {
    tries++;
    try {
      const addrs = await o.resolve4(host);
      if (addrs.length) return { addrs, waitedMs: Math.round(now() - t0), tries };
      lastError = "no A record";
    } catch (e) { lastError = (e as NodeJS.ErrnoException).code ?? (e as Error).message; }
    if (now() - t0 + intervalMs > timeoutMs) return { addrs: [], waitedMs: Math.round(now() - t0), tries, lastError };
    await sleep(intervalMs);
  }
}

/** 미리 받은 주소로만 답하는 lookup (돌아가며 쓴다). getaddrinfo 를 부르지 않는다 */
export function pinnedLookup(addrs: string[]): LookupFunction {
  let i = 0;
  return ((_host: string, opts: { all?: boolean } | number | undefined, cb?: (...a: unknown[]) => void) => {
    const done = (typeof opts === "function" ? opts : cb) as (...a: unknown[]) => void;
    const all = typeof opts === "object" && opts?.all;
    if (all) return done(null, addrs.map((address) => ({ address, family: 4 })));
    const a = addrs[i++ % addrs.length]!;
    done(null, a, 4);
  }) as unknown as LookupFunction;
}

// Z70-3: 요청 하나 제한 시간 기본 30초. Cloudflare 는 오리진 연결을 약 20초 기다린 뒤 522 를 준다【사실, 맥 curl 21:5xZ】.
//   예전 10초면 522 가 오기 전에 끊겨 "오류 ETIMEDOUT" 으로만 보였다 (원인이 가려짐)
export const PROBE_TIMEOUT_MS = (() => {
  const v = Number(process.env.CF_CHECK_PROBE_TIMEOUT_SEC);
  return Number.isFinite(v) && v > 0 ? v * 1000 : 30_000;
})();

export interface ProbeResult { status: number; header: string | null }

/** LB 이름으로 GET 한 번. lookup 이 있으면 그 주소로 붙고, TLS SNI·Host 는 host 그대로 */
export function probeOnce(host: string, path: string, headerName: string,
  o: { lookup?: LookupFunction; port?: number; tls?: boolean; timeoutMs?: number; insecure?: boolean; hostHeader?: string } = {}): Promise<ProbeResult> {
  const tls = o.tls ?? true;
  const req = tls ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req({ host, servername: tls ? host : undefined, port: o.port ?? (tls ? 443 : 80), path, method: "GET",
      headers: { host: o.hostHeader ?? host, "cache-control": "no-cache" }, lookup: o.lookup,
      ...(o.insecure ? { rejectUnauthorized: false } : {}), agent: false, timeout: o.timeoutMs ?? PROBE_TIMEOUT_MS },
    (res) => {
      const h = res.headers[headerName.toLowerCase()];
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, header: Array.isArray(h) ? h[0]! : h ?? null }));
    });
    // Z38 R7-8: 시간 초과에 코드를 붙여 집계가 "오류 ?" 대신 "오류 ETIMEDOUT" 으로 나온다
    r.on("timeout", () => r.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    r.on("error", reject);
    r.end();
  });
}

/** 분배 판정: 도착 이름(x-served-by)의 몫이 기대 가중치 ±tol 안인가. 오류·다른 이름은 분모에 넣는다 (빠뜨리면 좋게 보인다)
 *  Z38 REVIEW-7 R7-6: 허용 폭 = max(tolPct, z·표본 표준편차). 요청 50번·가중치 50% 면 표준편차가 7.1%p 라
 *    고정 ±10%p 는 LB 가 정확히 나눠도 약 16% 확률로 "실패"가 난다 (단계 2개면 약 30%) → "연속 2회 같은 결과" 비교가 흔들린다.
 *    z 기본 2.576 (정상 LB 를 실패로 볼 확률 약 1%). 가중치 0·100% 는 표준편차 0 이라 ±tolPct 그대로 */
/** 집계 열쇠가 "응답한 오리진 이름" 이 아닌 것 = 오류 (요청 실패 "오류 CODE", 헤더 없는 응답 "HTTP 522" 같은 것) */
export const isErrorKey = (k: string) => k.startsWith("오류 ") || /^HTTP \d{3}$/.test(k);

export function judgeShare(count: Map<string, number>, targetName: string, expectedTarget: number, tolPct = 10, z = 2.576, maxErrPct = MAX_ERR_PCT) {
  const total = [...count.values()].reduce((a, b) => a + b, 0);
  const errors = [...count].filter(([k]) => isErrorKey(k)).reduce((a, [, v]) => a + v, 0);
  const errorPct = total ? Math.round((errors / total) * 100) : 100;
  const got = total ? ((count.get(targetName) ?? 0) / total) * 100 : 0;
  const want = expectedTarget * 100;
  const sd = total ? Math.sqrt((expectedTarget * (1 - expectedTarget)) / total) * 100 : 0;
  const tol = Math.round(Math.max(tolPct, z * sd) * 10) / 10;
  // Z70-3: 오류가 임계(기본 20%)를 넘으면 비율과 상관없이 실패. 예전엔 50/50 전부 오류인데 "도착 0% / 기대 10% ±10.9%p → OK" 로 통과했다
  const shareOk = total > 0 && Math.abs(got - want) <= tol;
  const errOk = errorPct <= maxErrPct;
  return { ok: shareOk && errOk, gotPct: Math.round(got), wantPct: Math.round(want), total, tolPct: tol, errors, errorPct,
           reason: !errOk ? `오류 ${errors}/${total} (${errorPct}% > ${maxErrPct}%)` : !shareOk ? "비율 벗어남" : undefined };
}

/** Z70-3: 오류율 임계 (CF_CHECK_PROBE_MAX_ERR_PCT, 기본 20) */
export const MAX_ERR_PCT = (() => {
  const v = Number(process.env.CF_CHECK_PROBE_MAX_ERR_PCT);
  return Number.isFinite(v) && v >= 0 ? v : 20;
})();

/** Z70-3: Cloudflare pool health 응답(GET …/pools/{id}/health)에서 "건강한 PoP 가 있나 + 첫 실패 이유" 만 꺼낸다.
 *  모양은【추정, Cloudflare API 문서 기억】 { pop_health: { LAX: { healthy, origins: [{ "<주소>": { healthy, failure_reason, response_code } }] } } }.
 *  모양이 다르면 unknown 으로 두고 probe 를 막지 않는다 */
export function poolHealthOf(raw: unknown): { state: "healthy" | "unhealthy" | "unknown"; pops: string[]; reason?: string } {
  const pop = (raw as { pop_health?: Record<string, { healthy?: boolean; origins?: Array<Record<string, { healthy?: boolean; failure_reason?: string; response_code?: number }>> }> })?.pop_health;
  if (!pop || typeof pop !== "object" || !Object.keys(pop).length) return { state: "unknown", pops: [] };
  const pops = Object.keys(pop).sort();
  let reason: string | undefined;
  for (const p of pops) for (const o of pop[p]?.origins ?? []) for (const [addr, h] of Object.entries(o ?? {})) {
    if (h && h.healthy === false && !reason) reason = `${p} ${addr}: ${h.failure_reason ?? "?"}${h.response_code ? ` (HTTP ${h.response_code})` : ""}`;
  }
  const any = pops.some((p) => pop[p]?.healthy === true);
  return { state: any ? "healthy" : "unhealthy", pops, ...(reason ? { reason } : {}) };
}

// ---- z75-32: probe 전 선행 점검 ----
// 【사실, https://www.cloudflare.com/ips-v4 (10/31 기억, 자주 안 바뀜)】 Cloudflare 엣지 IPv4 대역. proxied LB 이름은 여기로 풀려야 한다
export const CLOUDFLARE_V4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14",
  "172.64.0.0/13", "131.0.72.0/22"];
const ip2n = (ip: string) => ip.split(".").reduce((a, x) => (a << 8) + Number(x), 0) >>> 0;
export function inCloudflareV4(ip: string, ranges = CLOUDFLARE_V4): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const n = ip2n(ip);
  return ranges.some((r) => { const [b, l] = r.split("/"); const m = Number(l) === 0 ? 0 : (~0 << (32 - Number(l))) >>> 0; return (n & m) === (ip2n(b!) & m); });
}

export type PreflightClass = "ORIGIN" | "POOL" | "DNS";
export interface PreflightFail { cls: PreflightClass; who: string; detail: string }

/** 오리진 직접 GET (Cloudflare 안 거침). https 는 자체 서명 허용. 응답 헤더에 이름이 있어야 통과 */
export async function originCheck(addr: string, path: string, header: string,
  o: { tls?: boolean; timeoutMs?: number; hostHeader?: string } = {}): Promise<{ ok: boolean; detail: string; ms: number }> {
  const t0 = performance.now();
  const [host, port] = addr.includes(":") ? [addr.split(":")[0]!, Number(addr.split(":")[1])] : [addr, undefined];
  try {
    const r = await probeOnce(host, path, header, { tls: o.tls ?? true, port, timeoutMs: o.timeoutMs ?? 5000, insecure: true, hostHeader: o.hostHeader });
    const ms = Math.round(performance.now() - t0);
    if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}`, ms };
    if (!r.header) return { ok: false, detail: `HTTP 200 인데 ${header} 헤더 없음`, ms };
    return { ok: true, detail: `${header}: ${r.header}`, ms };
  } catch (e) { return { ok: false, detail: (e as NodeJS.ErrnoException).code ?? (e as Error).message, ms: Math.round(performance.now() - t0) }; }
}

// DRAFT(ai): cf-check 자원 이름 앞머리 (모니터 <앞머리>-monitor, pool <앞머리>-src·-tgt, LB <앞머리>.<zone>).
//   CF_CHECK_PREFIX 가 비면 예전 그대로 "cf-check". 둘째 터널·pool 짝을 첫 짝을 안 건드리고 만들 때만 준다 (예: cf-check2).
//   "cf-check" 로 시작해야 한다 (이 스크립트는 cf-check* 자원만 바꾸고 지운다). 바로 뒤에 "-" 는 안 된다:
//   기본 앞머리의 --list·정리 확인이 pool 을 "cf-check-" 로 시작하는 이름으로 찾아, cf-check-b-src 를 첫 짝의 남은 것으로 센다
//   소문자·숫자만 (LB 이름이 <앞머리>.<zone> 호스트 이름이 된다), 뒤에 붙는 칸은 16자까지
export const CF_CHECK_DEFAULT_PREFIX = "cf-check";
export function cfCheckPrefix(env: NodeJS.ProcessEnv = process.env): { prefix: string } | { error: string } {
  const v = env.CF_CHECK_PREFIX?.trim();
  if (!v) return { prefix: CF_CHECK_DEFAULT_PREFIX };
  if (v === CF_CHECK_DEFAULT_PREFIX || /^cf-check[a-z0-9]{1,16}$/.test(v)) return { prefix: v };
  return { error: `CF_CHECK_PREFIX=${v.slice(0, 40)} 는 쓸 수 없다: cf-check 바로 뒤에 소문자·숫자 1~16자 (예: cf-check2). "-" 로 이으면 기본 앞머리 정리가 그 pool 을 자기 것으로 센다` };
}
