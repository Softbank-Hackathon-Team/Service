import { test } from "node:test";
import assert from "node:assert/strict";
import { curveCost, curveOf, rpsAt, segments, smoothPath, valueAt, xOf, yTicks } from "../src/features/cost/curve";
import type { EnvEstimate } from "../src/lib/types";

const env = (provider: EnvEstimate["provider"], monthlyUsd: number | null, fixed = 0, feasible = true): EnvEstimate => ({
  provider, feasible, nodeSku: null, nodes: 1, monthlyUsd, monthlyUsdNoCredit: monthlyUsd, creditUsd: 0,
  parts: { cluster: 0, nodes: 0, db: 0, storage: 0, fixed }, unknown: [], unverified: [],
});

test("월 비용 곡선: 온프레는 하드웨어 고정비를 빼고, 계산할 수 없는 점은 곡선을 끊는다", () => {
  assert.equal(curveCost(env("onprem", 900, 600)), 300);
  assert.equal(curveCost(env("aws", 300, 0)), 300);
  assert.equal(curveCost(env("onprem", null, 0, false)), null);
  assert.equal(curveCost(undefined), null);
  const samples = [1, 10, 100, 1000].map((rps, i) => ({ rps, envs: [env("aws", 100 + i * 50), env("onprem", i === 3 ? null : 500, 400, i !== 3)] }));
  assert.deepEqual(curveOf(samples, "onprem").map((p) => p.usd), [100, 100, 100, null]);
  assert.deepEqual(segments([{ rps: 1, usd: 1 }, { rps: 2, usd: null }, { rps: 3, usd: 3 }, { rps: 4, usd: 4 }]).map((s) => s.length), [1, 2]);
});

test("월 비용 곡선: 로그 x 눈금, 지나는 점에서는 점의 값, 사이는 단조 (튀지 않음), 끊긴 곳은 값 없음", () => {
  assert.equal(xOf(1), 0);
  assert.equal(xOf(8000), 1);
  assert.equal(rpsAt(0), 1);
  assert.equal(rpsAt(1), 8000);
  assert.equal(rpsAt(xOf(120)), 120);
  const pts = [{ rps: 1, usd: 100 }, { rps: 10, usd: 120 }, { rps: 100, usd: 300 }, { rps: 1000, usd: 310 }];
  assert.equal(Math.round(valueAt(pts, 10)!), 120);
  for (let r = 10; r <= 100; r += 7) {
    const v = valueAt(pts, r)!;
    assert.ok(v >= 120 && v <= 300, `${r}: ${v}`);
  }
  assert.equal(valueAt([{ rps: 1, usd: 1 }, { rps: 10, usd: null }, { rps: 100, usd: 5 }], 30), null);
  assert.match(smoothPath([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 5 }]), /^M0\.0,0\.0 C/);
});

test("월 비용 곡선: y 눈금은 0 부터 1·2·5 단위, 맨 위가 가장 큰 값보다 크다", () => {
  const ticks = yTicks(268);
  assert.equal(ticks[0], 0);
  assert.ok(ticks[ticks.length - 1]! >= 268 * 1.1);
  assert.ok(ticks.length >= 3 && ticks.length <= 5);
  assert.deepEqual(yTicks(0).slice(0, 2), [0, 0.5]);
});
