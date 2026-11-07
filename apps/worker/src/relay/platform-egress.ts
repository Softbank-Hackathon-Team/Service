// 플랫폼 워커가 밖으로 나가는 IP (중계기 입구 15432·역방향 5432 를 이 대역에만 연다).
// PLATFORM_EGRESS_CIDRS 가 비어 있으면 워커가 기동할 때 스스로 알아낸다 → 사람이 배포 값에 넣지 않아도 중계기가 돈다.
//   온프레 Agent 의 나가는 IP 읽기(packages/agent facts.ts fetchEgressIp)와 같은 주소·같은 방식
// DRAFT(ai): 한 번만 읽어 /32 로 둔다. 워커 파드가 다른 NAT(다른 영역)로 옮겨 가면 다시 기동할 때 바뀐다 (파드가 옮겨 가면 어차피 다시 기동)
//   운영자가 값을 넣었으면 그 값이 이긴다. 끄려면 PLATFORM_EGRESS_AUTO=0
import { isIpv4 } from "./aws-relay.js";

export const DEFAULT_PLATFORM_EGRESS_URL = "https://checkip.amazonaws.com";
const TIMEOUT_MS = 5_000;

export type FetchText = (url: string, timeoutMs: number) => Promise<string>;
const defaultFetch: FetchText = async (url, timeoutMs) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};

/** 값이 비어 있으면 알아내서 env 에 넣는다. 결과: 넣은 값 / 이미 있음 / 끔 / 실패 이유 */
export async function ensurePlatformEgress(env: NodeJS.ProcessEnv = process.env, fetchText: FetchText = defaultFetch):
  Promise<{ kind: "set"; cidr: string } | { kind: "kept" | "off" } | { kind: "failed"; reason: string }> {
  if (env.PLATFORM_EGRESS_CIDRS?.trim()) return { kind: "kept" };
  if (env.PLATFORM_EGRESS_AUTO === "0") return { kind: "off" };
  try {
    const ip = (await fetchText(env.PLATFORM_EGRESS_URL || DEFAULT_PLATFORM_EGRESS_URL, TIMEOUT_MS)).trim();
    if (!isIpv4(ip)) return { kind: "failed", reason: "응답이 IPv4 한 줄이 아니다" };
    env.PLATFORM_EGRESS_CIDRS = `${ip}/32`;
    return { kind: "set", cidr: env.PLATFORM_EGRESS_CIDRS };
  } catch (e) { return { kind: "failed", reason: ((e as Error)?.message ?? String(e)).slice(0, 200) }; }
}
