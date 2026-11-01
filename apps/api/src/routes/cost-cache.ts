import type { CostEstimate, CostEstimateRequestInput } from "@svc/contracts";
import { canonical } from "@svc/core";
import { estimateCost, loadCatalog } from "@svc/cost";
import { envNumber } from "@svc/contracts";

// 작업 Z49: 비용 계산 결과를 잠깐 기억한다.
// 왜: estimateCost 는 "최저 환경이 바뀌는 지점"을 찾으려고 0~2000 rps 를 1씩 올리며 환경 4개를 다 계산한다(8천 번 남짓).
//     요청 하나에 CPU 40ms 정도라 화면 여러 개가 동시에 열면 줄을 선다(동시 10개면 p50 0.4초, docs/PERF.md).
// 같은 입력이면 같은 결과(순수 계산)라 입력 JSON(키 정렬)을 열쇠로 COST_CACHE_TTL_MS(기본 60초) 동안 돌려준다.
// 가격 파일(npm run prices:fetch)을 바꾸면 길어야 TTL 뒤에 반영된다. 0 이면 끈다(예전 그대로 매번 계산).
// 대안: 가격표 색인(rowsFor 를 Map 으로)은 8%밖에 안 줄어 버렸다. 계산 쪽 알고리즘 변경은 packages/cost 범위라 제안만(proposals/)
export const COST_CACHE_TTL_MS = envNumber(process.env.COST_CACHE_TTL_MS, 60_000);
const MAX_ENTRIES = 100;   // POST /cost/estimate 는 본문이 제각각이라 상한을 둔다 (가장 오래된 것부터 버림)

const memo = new Map<string, { at: number; v: CostEstimate }>();

export function estimateCostCached(
  input: CostEstimateRequestInput, o: { ttlMs?: number; now?: number } = {},
): CostEstimate {
  const ttl = o.ttlMs ?? COST_CACHE_TTL_MS;
  if (!(ttl > 0)) return estimateCost(input, loadCatalog());
  const now = o.now ?? Date.now();
  const key = canonical(input);
  const hit = memo.get(key);
  // 받는 쪽이 고쳐도 기억한 값이 안 바뀌게 복사해서 준다 (4KB 안팎, 0.1ms 아래)
  if (hit && now - hit.at < ttl) return structuredClone(hit.v);
  const v = estimateCost(input, loadCatalog());
  memo.delete(key);
  if (memo.size >= MAX_ENTRIES) memo.delete(memo.keys().next().value as string);
  memo.set(key, { at: now, v });
  return structuredClone(v);
}

export function clearCostCache(): void { memo.clear(); }
export const costCacheSize = (): number => memo.size;
