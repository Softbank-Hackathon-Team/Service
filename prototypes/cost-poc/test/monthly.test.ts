import assert from "node:assert/strict";
import { test } from "node:test";
import { lambdaAt, monthlyCost, tieredEgress } from "../src/core/monthly.js";
import { makeResourceFn } from "../src/core/resource.js";
import { ResourceProfile, Sizing, Traffic, VendorPricing } from "../src/core/types.js";
import { approx, noDb, pageVendor as pv } from "./helpers.js";
import type { VendorPricingInput } from "../src/core/types.js";

// DB 항을 0으로 둬서 손 검산을 단순하게 한다
const pageVendor = (o: Partial<VendorPricingInput> = {}) => pv({ dbClasses: [{ sku: "free-db", hourly: 0, capacity: { cpu: 64, mem: 256 } }], ...o });

const flat = (over: object = {}) => ResourceProfile.parse({
  source: "measured",
  points: [
    { lambda: 0, cpu: 0, memGiB: 0, egressGBh: 0, storageGB: 20 },
    { lambda: 100, cpu: 4, memGiB: 8, egressGBh: 1, storageGB: 20 },
  ],
  ...over,
});
const S = Sizing.parse({});

test("적분: 일정 트래픽이면 C_v x T와 같다 (손 검산)", () => {
  const p = VendorPricing.parse(pageVendor({ fixedHourly: 0.1, storagePerGBMonth: 0.1, minNodes: 1 }));
  const fn = makeResourceFn(flat());
  const m = monthlyCost(p, fn, S, Traffic.parse({ kind: "constant", lambda: 50 }), { applyEgressTiers: false });
  // λ=50: cpu 2/4=0.5, mem 4/16=0.25 → 1대. 시간당 0.1 + 0.2 + 0.09x0.5 + 20x0.1/730
  const perHour = 0.1 + 0.2 + 0.045 + 2 / 730;
  assert.ok(approx(m.totalUsd, perHour * 730), `${m.totalUsd} vs ${perHour * 730}`);
  assert.ok(approx(m.parts.storage, 2));
  assert.ok(approx(m.egressGB, 365));
});

test("적분: 스토리지 누적은 해석해와 맞는다 (r_m(t) 시점별)", () => {
  const p = VendorPricing.parse(pageVendor({ egressPerGB: 0, storagePerGBMonth: 0.1, minNodes: 0, nodeTypes: [{ sku: "n", hourly: 0, capacity: { cpu: 100, mem: 100, gpu: 0 } }] }));
  const g = 1e-6; // GB/요청
  const fn = makeResourceFn(flat({ storageGrowthGBPerRequest: g }));
  const lam = 50;
  const m = monthlyCost(p, fn, S, Traffic.parse({ kind: "constant", lambda: lam }));
  // S(t) = 20 + g λ 3600 t (t 시간). ∫_0^730 q/730 S(t) dt = q/730 (20 x 730 + g λ 3600 730²/2)
  const rate = g * lam * 3600;
  const exact = (0.1 / 730) * (20 * 730 + (rate * 730 ** 2) / 2);
  assert.ok(approx(m.parts.storage, exact, 1e-9), `${m.parts.storage} vs ${exact}`);
  assert.ok(approx(m.storageEndGB, 20 + rate * 730, 1e-9));
});

test("적분: 계단이 있어 평균 λ의 비용과 적분이 다르다, dt를 줄이면 수렴한다", () => {
  const p = VendorPricing.parse(pageVendor({ egressPerGB: 0, minNodes: 1 }));
  const fn = makeResourceFn(flat());
  const tr = Traffic.parse({ kind: "diurnal", peak: 100, troughRatio: 0 });
  const fine = monthlyCost(p, fn, S, tr, { dtHours: 0.25 }).totalUsd;
  const hourly = monthlyCost(p, fn, S, tr, { dtHours: 1 }).totalUsd;
  assert.ok(Math.abs(fine - hourly) / fine < 0.02);
  const atMean = monthlyCost(p, fn, S, Traffic.parse({ kind: "constant", lambda: 50 })).totalUsd;
  assert.ok(fine !== atMean);
  // 피크 고정(팀의 현재 방식)은 자동 확장보다 비싸거나 같다
  assert.ok(monthlyCost(p, fn, S, tr, { provisioning: "peak" }).totalUsd >= hourly - 1e-9);
});

test("노드 종류 고정은 시간마다 바꾸는 min보다 싸지 않다", () => {
  const p = VendorPricing.parse(pageVendor({ egressPerGB: 0, minNodes: 1, nodeTypes: [
    { sku: "small", hourly: 0.05, capacity: { cpu: 1, mem: 2, gpu: 0 } },
    { sku: "big", hourly: 0.2, capacity: { cpu: 4, mem: 16, gpu: 0 } },
  ] }));
  const fn = makeResourceFn(flat());
  const tr = Traffic.parse({ kind: "diurnal", peak: 100, troughRatio: 0.1 });
  const fixed = monthlyCost(p, fn, S, tr).totalUsd;
  const free = monthlyCost(p, fn, S, tr, { nodeChoice: "free-type" }).totalUsd;
  assert.ok(fixed >= free - 1e-9);
});

test("송신 계단: 손 검산과 무료 구간, 합계 분해", () => {
  const tiers = [{ fromGB: 0, usdPerGB: 0 }, { fromGB: 100, usdPerGB: 0.126 }, { fromGB: 10340, usdPerGB: 0.122 }];
  assert.equal(tieredEgress(tiers, 50), 0);
  assert.ok(approx(tieredEgress(tiers, 1000), 900 * 0.126));
  assert.ok(approx(tieredEgress(tiers, 20000), (10340 - 100) * 0.126 + (20000 - 10340) * 0.122));
  const p = VendorPricing.parse(pageVendor({ egressPerGB: 0.126, egressTiers: tiers, minNodes: 1 }));
  const fn = makeResourceFn(flat());
  const m = monthlyCost(p, fn, S, Traffic.parse({ kind: "constant", lambda: 100 }));
  // 730GB: 원식 0.126 x 730 = 91.98, 무료 100GB 반영 후 79.38, 조정 -12.6
  assert.ok(approx(m.parts.egress, 91.98));
  assert.ok(approx(m.egressTierAdjustUsd, -12.6));
  assert.ok(approx(m.totalUsd, m.integralUsd - 12.6));
  const lit = monthlyCost(p, fn, S, Traffic.parse({ kind: "constant", lambda: 100 }), { applyEgressTiers: false });
  assert.ok(approx(lit.totalUsd, lit.integralUsd), "조정을 끄면 페이지 원식 그대로");
});

test("크레딧: 고정비에서만 뺀다", () => {
  const p = VendorPricing.parse(pageVendor({ fixedHourly: 0.1, monthlyCreditUsd: 74.4, egressPerGB: 0, minNodes: 1 }));
  const fn = makeResourceFn(flat());
  const m = monthlyCost(p, fn, S, Traffic.parse({ kind: "constant", lambda: 1 }));
  assert.ok(approx(m.creditUsd, 73), "0.1 x 730 = 73이 상한");
  assert.ok(approx(m.totalUsd, m.integralUsd - 73));
});

test("트래픽: 하루 주기의 최고·최저, 시계열, 거부", () => {
  const tr = Traffic.parse({ kind: "diurnal", peak: 100, troughRatio: 0.2 });
  assert.ok(approx(lambdaAt(tr, 14), 100));
  assert.ok(approx(lambdaAt(tr, 2), 20));
  const s = Traffic.parse({ kind: "series", hourly: [1, 2, 3] });
  assert.equal(lambdaAt(s, 1.5), 2);
  assert.equal(lambdaAt(s, 4), 2);
  assert.throws(() => Traffic.parse({ kind: "constant", lambda: -1 }));
  assert.throws(() => Traffic.parse({ kind: "series", hourly: [] }));
  const p = VendorPricing.parse(pageVendor());
  assert.throws(() => monthlyCost(p, makeResourceFn(flat()), Sizing.parse(noDb), Traffic.parse({ kind: "constant", lambda: 1 }), { dtHours: 0 }), /MONTHLY_BAD_RANGE/);
});

test("불가능한 시간이 하나라도 있으면 그 달은 불가다", () => {
  const p = VendorPricing.parse(pageVendor({ maxEgressGBh: 0.5, minNodes: 1 }));
  const m = monthlyCost(p, makeResourceFn(flat()), S, Traffic.parse({ kind: "diurnal", peak: 100, troughRatio: 0 }));
  assert.equal(m.feasible, false);
  assert.equal(m.reason, "LINE_CAPACITY_EXCEEDED");
});
