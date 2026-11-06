import { ProviderError } from "../switcher.js";
import { cfRequest, cloudflarePatchBody } from "./cloudflare.js";
import type { FetchLike, TokenSource } from "./http.js";

// 이전마다 Cloudflare 트래픽 자원(도착 터널·모니터·pool 2개·LB)을 만들고 지운다.
// DECISION(team): 트래픽 전환을 이전마다 자동으로 실제 Cloudflare 로 (2026-11-07 리더 결정, 스레드 "이전마다 실제 트래픽 전환 자동화").
//   예전엔 사람이 scripts/cf-check.ts 로 LB·pool 을 만들고 cf-register 로 이전에 붙였다 (cloud.ts TODO(human) "도착 터널 토큰을 누가 만드나").
// 이름 규칙: 전부 svc-<이전 앞 8자> 로 시작한다. 지우기는 이 접두어 + 이전 번호가 description 에 있는 것만 지운다 (팀 공용 계정의 다른 자원은 안 건드림).
// 여러 번 불러도 같다: 이름으로 찾고 있으면 다시 만들지 않는다 (작업 재시도·재개).
// 【사실】 API (developers.cloudflare.com/api): 터널 /accounts/{a}/cfd_tunnel (POST·GET ?name=·DELETE, /{id}/configurations PUT, /{id}/token GET,
//   /{id}/connections DELETE), 모니터·pool /accounts/{a}/load_balancers/monitors|pools, LB /zones/{z}/load_balancers.
// 【추정】 LB pool 오리진이 터널이면 주소 <터널 id>.cfargotunnel.com, 터널 연결 규칙의 hostname 이 LB 호스트와 같아야 받는다 (Cloudflare LB + Tunnel 안내). 실계정 확인 전

export interface CfProvisionCtx {
  token: TokenSource;
  accountId: string;
  zoneId: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface MigrationLbInput {
  migrationId: string;
  /** 앱 공개 호스트 이름 (명세 입구). LB 이름 = 이 호스트 */
  hostname: string;
  /** 출발 오리진 주소 (출발 터널 <id>.cfargotunnel.com 이나 공개 호스트·IP) */
  sourceOrigin: string;
  /** 도착 터널 연결 대상 (도착 클러스터 안 주소, 예: http://shop-web.app-shop:80) */
  targetService: string;
  /** 모니터 경로. DRAFT(ai): 기본 "/" (샘플 web 의 readinessProbe 와 같음) */
  monitorPath?: string;
}

export interface MigrationCfResources {
  tunnelId: string;
  /** 도착 cloudflared 파드가 읽을 토큰. 로그·감사에 남기지 않는다 */
  tunnelToken: string;
  monitorId: string;
  sourcePoolId: string;
  targetPoolId: string;
  lbId: string;
}

const short = (migrationId: string) => migrationId.replace(/-/g, "").slice(0, 8).toLowerCase();
export const cfResourcePrefix = (migrationId: string) => `svc-${short(migrationId)}`;
const tag = (migrationId: string) => `svc migration ${migrationId}`;
// 우리가 만든 것만: 이름이 접두어로 시작하고 description 에 이 이전 번호가 있어야 한다 (터널은 description 이 없어 이름만)
const ours = (migrationId: string, x: { name?: string; description?: string }) =>
  (x.name ?? "").startsWith(cfResourcePrefix(migrationId)) && (x.description === undefined || x.description.includes(migrationId));

interface Named { id: string; name?: string; description?: string }
const isOurMonitor = (migrationId: string, m: Named) => (m.description ?? "") === `${cfResourcePrefix(migrationId)}-mon ${tag(migrationId)}`;
interface Tunnel { id: string; name: string; deleted_at?: string | null }

/** 순수 함수: 터널 연결 규칙. 마지막 줄은 다른 호스트를 404 로 막는다 (Cloudflare 가 마지막 줄을 모두 받기로 요구) */
export function tunnelIngressConfig(hostname: string, service: string) {
  if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(service)) throw new Error(`도착 연결 대상은 http(s)://<주소>[:포트] 모양이어야 한다: ${service}`);
  return { config: { ingress: [{ hostname, service }, { service: "http_status:404" }] } };
}

/** 순수 함수: 모니터 본문. Host 헤더 = 앱 호스트 (터널 연결 규칙이 호스트로 고른다) */
export function monitorBody(migrationId: string, hostname: string, path = "/") {
  return {
    type: "https", method: "GET", path, expected_codes: "2xx", follow_redirects: false, allow_insecure: false,
    header: { Host: [hostname] },
    // 【사실】 모니터 최소 간격은 요금제별 60초(Pro) (Load Balancing 문서). DRAFT(ai): 60초
    interval: 60, timeout: 5, retries: 1, description: `${cfResourcePrefix(migrationId)}-mon ${tag(migrationId)}`,
  };
}

export function poolBody(migrationId: string, side: "src" | "tgt", address: string, hostname: string, monitorId: string) {
  const name = `${cfResourcePrefix(migrationId)}-${side}`;
  return {
    name, monitor: monitorId, enabled: true, minimum_origins: 1, description: tag(migrationId),
    origins: [{ name: `${name}-o1`, address, enabled: true, weight: 1, header: { Host: [hostname] } }],
  };
}

/** 순수 함수: LB 본문. 출발 100% 로 시작, 도착이 죽으면 출발로 (cloudflarePreflight 조건과 같음) */
export function lbBody(migrationId: string, hostname: string, sourcePoolId: string, targetPoolId: string) {
  return {
    name: hostname, description: tag(migrationId), enabled: true, proxied: true,
    default_pools: [sourcePoolId, targetPoolId], fallback_pool: sourcePoolId, session_affinity: "none",
    ...cloudflarePatchBody({ sourcePoolId, targetPoolId }, { source: 1, target: 0 }),
  };
}

const cf = <T>(c: CfProvisionCtx, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) =>
  cfRequest<T>({ token: c.token, fetch: c.fetch, baseUrl: c.baseUrl, timeoutMs: c.timeoutMs }, method, path, body);

async function liveTunnel(c: CfProvisionCtx, name: string): Promise<Tunnel | undefined> {
  const list = await cf<Tunnel[]>(c, "GET", `/accounts/${c.accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
  return list.find((t) => t.name === name && !t.deleted_at);
}

/** 이전 하나의 Cloudflare 자원을 만든다 (있으면 다시 쓴다). 만드는 순서: 터널 → 연결 규칙 → 모니터 → pool 2 → LB */
export async function ensureMigrationCf(c: CfProvisionCtx, i: MigrationLbInput): Promise<MigrationCfResources> {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(i.hostname)) throw new Error(`호스트 이름이 아니다: ${i.hostname}`);
  const p = cfResourcePrefix(i.migrationId);
  const A = `/accounts/${c.accountId}`;
  // 1. 도착 터널 (원격 관리: 연결 규칙을 Cloudflare 쪽에 둔다 → 도착 파드는 토큰만 있으면 된다)
  const tName = `${p}-tgt`;
  const tunnel = (await liveTunnel(c, tName)) ?? await cf<Tunnel>(c, "POST", `${A}/cfd_tunnel`, { name: tName, config_src: "cloudflare" });
  await cf(c, "PUT", `${A}/cfd_tunnel/${tunnel.id}/configurations`, tunnelIngressConfig(i.hostname, i.targetService));
  const tunnelToken = await cf<string>(c, "GET", `${A}/cfd_tunnel/${tunnel.id}/token`);
  if (typeof tunnelToken !== "string" || !tunnelToken) throw new ProviderError("cloudflare", 500, "터널 토큰이 비어 있다", { retryable: true });
  // 2. 모니터 → pool → LB
  const [monitors, pools, lbs] = await Promise.all([
    cf<Named[]>(c, "GET", `${A}/load_balancers/monitors`), cf<Named[]>(c, "GET", `${A}/load_balancers/pools`),
    cf<Named[]>(c, "GET", `/zones/${c.zoneId}/load_balancers`)]);
  const monitorId = monitors.find((m) => isOurMonitor(i.migrationId, m))?.id
    ?? (await cf<Named>(c, "POST", `${A}/load_balancers/monitors`, monitorBody(i.migrationId, i.hostname, i.monitorPath))).id;
  const pool = async (side: "src" | "tgt", address: string) => {
    const have = pools.find((x) => x.name === `${p}-${side}` && ours(i.migrationId, x));
    const body = poolBody(i.migrationId, side, address, i.hostname, monitorId);
    if (!have) return (await cf<Named>(c, "POST", `${A}/load_balancers/pools`, body)).id;
    await cf(c, "PATCH", `${A}/load_balancers/pools/${have.id}`, { origins: body.origins, monitor: monitorId });   // 오리진이 바뀌었으면 맞춘다
    return have.id;
  };
  const sourcePoolId = await pool("src", i.sourceOrigin);
  const targetPoolId = await pool("tgt", `${tunnel.id}.cfargotunnel.com`);
  // 같은 호스트에 다른 이전의 LB 가 있으면 멈춘다 (두 이전이 한 호스트를 나눠 쥐면 서로의 가중치를 덮는다)
  const sameHost = lbs.find((l) => l.name === i.hostname);
  if (sameHost && !(sameHost.description ?? "").includes(i.migrationId))
    throw new ProviderError("cloudflare", 409, `호스트 ${i.hostname} 에 다른 LB 가 있다 (다른 이전이나 사람이 만든 것). 그 LB 를 정리한 뒤 다시`, { retryable: false });
  const lbId = sameHost?.id ?? (await cf<Named>(c, "POST", `/zones/${c.zoneId}/load_balancers`, lbBody(i.migrationId, i.hostname, sourcePoolId, targetPoolId))).id;
  return { tunnelId: tunnel.id, tunnelToken, monitorId, sourcePoolId, targetPoolId, lbId };
}

export interface CfTeardownResult { removed: string[]; kept: string[]; errors: string[] }

/** 이전 하나의 Cloudflare 자원을 지운다. 지우는 순서: LB → pool → 모니터 → 터널 (가리키는 쪽부터).
 *  keepTarget=true (이전 완료): 앱 호스트가 이제 도착을 가리켜야 하니 LB·도착 pool·모니터·도착 터널은 남기고 출발 pool 만 LB 에서 빼고 지운다.
 *  하나가 실패해도 나머지는 계속 지운다 (errors 에 모은다). 이 접두어·이전 번호가 아닌 자원은 건드리지 않는다 */
export async function teardownMigrationCf(c: CfProvisionCtx, migrationId: string, o: { keepTarget?: boolean } = {}): Promise<CfTeardownResult> {
  const p = cfResourcePrefix(migrationId);
  const A = `/accounts/${c.accountId}`;
  const out: CfTeardownResult = { removed: [], kept: [], errors: [] };
  const tryDo = async (what: string, f: () => Promise<unknown>) => {
    try { await f(); out.removed.push(what); } catch (e) { out.errors.push(`${what}: ${(e as Error).message.slice(0, 200)}`); }
  };
  const [monitors, pools, lbs] = await Promise.all([
    cf<Named[]>(c, "GET", `${A}/load_balancers/monitors`), cf<Named[]>(c, "GET", `${A}/load_balancers/pools`),
    cf<Named[]>(c, "GET", `/zones/${c.zoneId}/load_balancers`)]);
  const lb = lbs.find((l) => (l.description ?? "") === tag(migrationId));
  const src = pools.find((x) => x.name === `${p}-src` && ours(migrationId, x));
  const tgt = pools.find((x) => x.name === `${p}-tgt` && ours(migrationId, x));
  const mon = monitors.find((m) => isOurMonitor(migrationId, m));
  if (o.keepTarget) {
    if (lb && tgt) await tryDo("lb:target-only", () => cf(c, "PATCH", `/zones/${c.zoneId}/load_balancers/${lb.id}`,
      { default_pools: [tgt.id], fallback_pool: tgt.id, steering_policy: "off", random_steering: { default_weight: 1, pool_weights: {} } }));
    if (src) await tryDo("pool:src", () => cf(c, "DELETE", `${A}/load_balancers/pools/${src.id}`));
    out.kept.push(...[lb && "lb", tgt && "pool:tgt", mon && "monitor", "tunnel:tgt"].filter(Boolean) as string[]);
    return out;
  }
  if (lb) await tryDo("lb", () => cf(c, "DELETE", `/zones/${c.zoneId}/load_balancers/${lb.id}`));
  for (const [what, x] of [["pool:src", src], ["pool:tgt", tgt]] as const)
    if (x) await tryDo(what, () => cf(c, "DELETE", `${A}/load_balancers/pools/${x.id}`));
  if (mon) await tryDo("monitor", () => cf(c, "DELETE", `${A}/load_balancers/monitors/${mon.id}`));
  const t = await liveTunnel(c, `${p}-tgt`).catch((e) => { out.errors.push(`tunnel:list: ${(e as Error).message.slice(0, 200)}`); return undefined; });
  if (t) await tryDo("tunnel:tgt", async () => {
    // 연결이 남아 있으면 지우기가 거절된다 → 연결부터 끊는다 (도착 파드가 아직 떠 있으면 다시 붙을 수 있어 실패할 수 있다)
    await cf(c, "DELETE", `${A}/cfd_tunnel/${t.id}/connections`).catch(() => undefined);
    await cf(c, "DELETE", `${A}/cfd_tunnel/${t.id}`);
  });
  return out;
}
