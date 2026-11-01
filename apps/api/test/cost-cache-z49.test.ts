// 작업 Z49: 비용 계산 기억(estimateCostCached). 결과가 매번 계산한 것과 같은지, TTL·복사·끄기
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, loadCatalog } from "@svc/cost";
import { estimateCostCached, clearCostCache, costCacheSize } from "../src/routes/cost-cache.js";
import { DEMO_SPEC, previewRequest } from "../src/routes/migration-cost.js";

const NOW = new Date("2026-10-31T00:00:00Z");
// priceStale 은 지금 시각에 따라 바뀌니 비교에서 같은 now 를 쓰게 뺀다
const strip = (e: Record<string, unknown>) => { const { priceStale: _s, ...rest } = e; return rest; };

test("Z49 비용 기억: 결과가 매번 계산한 것과 같다 (출발 aws·gcp·onprem)", () => {
  clearCostCache();
  for (const from of ["aws", "gcp", "onprem"] as const) {
    const req = previewRequest(DEMO_SPEC, from);
    const plain = estimateCost(req, loadCatalog(), { now: NOW });
    const first = estimateCostCached(req, { now: 1000 });
    const second = estimateCostCached(req, { now: 2000 });
    assert.deepEqual(strip(first), strip(plain));
    assert.deepEqual(second, first);
  }
  assert.equal(costCacheSize(), 3);
});

test("Z49 비용 기억: 받은 값을 고쳐도 기억한 값은 안 바뀐다", () => {
  clearCostCache();
  const req = previewRequest(DEMO_SPEC, "aws");
  const a = estimateCostCached(req, { now: 0 });
  a.envs.length = 0;
  (a as { cheapest: unknown }).cheapest = "broken";
  const b = estimateCostCached(req, { now: 1 });
  assert.ok(b.envs.length > 0);
  assert.notEqual(b.cheapest, "broken");
});

test("Z49 비용 기억: TTL 이 지나면 다시 계산, ttlMs=0 이면 기억 안 함", () => {
  clearCostCache();
  const req = previewRequest(DEMO_SPEC, "gcp");
  estimateCostCached(req, { now: 0, ttlMs: 100 });
  assert.equal(costCacheSize(), 1);
  // 지난 뒤: 같은 열쇠를 새로 넣는다 (크기 그대로)
  const again = estimateCostCached(req, { now: 500, ttlMs: 100 });
  assert.equal(costCacheSize(), 1);
  assert.ok(again.envs.length > 0);
  clearCostCache();
  estimateCostCached(req, { ttlMs: 0 });
  assert.equal(costCacheSize(), 0);
});

test("Z49 비용 기억: 100개 넘으면 오래된 것부터 버린다", () => {
  clearCostCache();
  for (let i = 0; i < 105; i++) {
    const req = { ...previewRequest(DEMO_SPEC, "aws"), traffic: { peakRps: i + 1 } };
    estimateCostCached(req, { now: 0, ttlMs: 60_000 });
  }
  assert.equal(costCacheSize(), 100);
});
