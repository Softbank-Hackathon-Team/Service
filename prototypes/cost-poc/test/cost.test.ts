import assert from "node:assert/strict";
import { test } from "node:test";
import { hourlyCost, hourlyTilde, HOURS_PER_MONTH, nodeCount } from "../src/core/cost.js";
import { makeResourceFn, vendorResources } from "../src/core/resource.js";
import { gradientAt } from "../src/core/gradient.js";
import { ResourceProfile, Sizing, VendorPricing } from "../src/core/types.js";
import { approx, noDb, pageVendor } from "./helpers.js";

const P = (o = {}) => VendorPricing.parse(pageVendor(o));
const S = Sizing.parse(noDb);
const pageProfile = ResourceProfile.parse({
  source: "price-only",
  points: [
    { lambda: 0, cpu: 0, memGiB: 0, egressGBh: 0, storageGB: 0 },
    { lambda: 2000, cpu: 2, memGiB: 40, egressGBh: 20, storageGB: 0 },
  ],
});
const fn = makeResourceFn(pageProfile);

test("페이지 예시: ∂Cost/∂λ = 0.00115로 고정", () => {
  const g = gradientAt(P(), fn, S, 1000, { respectMinNodes: false });
  assert.deepEqual(g.kStar, ["mem"]);
  assert.ok(approx(g.nodeTerm, 0.00025), `메모리 항 ${g.nodeTerm}`);
  assert.ok(approx(g.egressTerm, 0.0009), `송신 항 ${g.egressTerm}`);
  assert.ok(approx(g.total, 0.00115), `합 ${g.total}`);
  // 계단이 아니라 근사식 기준: 100 req/s 늘면 시간당 약 0.115달러
  const c0 = hourlyTilde(P(), vendorResources(fn, P(), S, 1000), false).total;
  const c1 = hourlyTilde(P(), vendorResources(fn, P(), S, 1100), false).total;
  assert.ok(approx(c1 - c0, 0.115), `차이 ${c1 - c0}`);
  // 송신이 증가분의 약 78%
  assert.ok(Math.abs(g.egressTerm / g.total - 0.7826) < 0.001);
});

test("C_v 손 검산: F + p⌈max⌉ + Σqr", () => {
  // F=0.10, 노드 0.2달러, 4 vCPU·16 GiB. cpu 6 → 6/4=1.5, mem 20 → 20/16=1.25, ⌈1.5⌉=2대 → 0.4
  // 송신 10GB/h x 0.09 = 0.9, 스토리지 100GB x 0.10/730 = 0.0136986..., DB 1대 0.05
  const p = P({ fixedHourly: 0.1, storagePerGBMonth: 0.1, dbClasses: [{ sku: "db", hourly: 0.05, capacity: { cpu: 2, mem: 8 } }] });
  const f = makeResourceFn(ResourceProfile.parse({ source: "sample", points: [{ lambda: 10, cpu: 6, memGiB: 20, egressGBh: 10, storageGB: 100, dbCpu: 0.1, dbMemGiB: 1 }] }));
  const c = hourlyCost(p, vendorResources(f, p, Sizing.parse({}), 10));
  assert.equal(c.nodes, 2);
  assert.deepEqual(c.kStar, ["cpu"]);
  const hand = 0.1 + 0.4 + 0.05 + 100 * 0.1 / 730 + 0.9;
  assert.ok(approx(c.total, hand), `${c.total} vs ${hand}`);
  assert.ok(approx(c.total, 1.4636986301369863));
});

test("계단: 경계에서 왼쪽 연속, 지나면 한 대 값만큼 뛴다", () => {
  const p = P({ egressPerGB: 0 });
  // mem = 0.02 λ, 16 GiB 노드 → λ=800에서 정확히 1대, 그 위는 2대
  const r = (l: number) => vendorResources(fn, p, S, l);
  assert.equal(hourlyCost(p, r(800)).nodes, 1);
  assert.equal(hourlyCost(p, r(800.001)).nodes, 2);
  assert.ok(approx(hourlyCost(p, r(800.001)).total - hourlyCost(p, r(800)).total, 0.2));
  // 계단 위에서는 실제 비용의 기울기가 0, 근사식은 0이 아니다
  assert.equal(hourlyCost(p, r(900)).total, hourlyCost(p, r(1000)).total);
  assert.ok(hourlyTilde(p, r(1000), false).total > hourlyTilde(p, r(900), false).total);
});

test("단조성: λ가 늘면 C와 C̃ 모두 줄지 않는다", () => {
  const p = P({ fixedHourly: 0.1 });
  let prevC = -1; let prevT = -1;
  for (let l = 0; l <= 2000; l += 7) {
    const r = vendorResources(fn, p, S, l);
    const c = hourlyCost(p, r).total; const t = hourlyTilde(p, r, false).total;
    assert.ok(c >= prevC - 1e-12); assert.ok(t >= prevT - 1e-12);
    assert.ok(c >= t - 1e-12, "C는 올림이 있어 C̃ 아래로 내려가지 않는다");
    prevC = c; prevT = t;
  }
});

test("병목 전환: 부하가 늘면 k*가 cpu에서 mem으로 바뀐다", () => {
  const p = P({ egressPerGB: 0 });
  const f = makeResourceFn(ResourceProfile.parse({ source: "measured", points: [
    { lambda: 0, cpu: 2, memGiB: 0, egressGBh: 0, storageGB: 0 },
    { lambda: 100, cpu: 3, memGiB: 16, egressGBh: 0, storageGB: 0 },
  ] }));
  // cpu/4 = 0.5 + 0.0025λ, mem/16 = 0.01λ → 동률 λ = 66.666...
  const g1 = gradientAt(p, f, S, 10, { respectMinNodes: false });
  const g2 = gradientAt(p, f, S, 90, { respectMinNodes: false });
  assert.deepEqual(g1.kStar, ["cpu"]);
  assert.deepEqual(g2.kStar, ["mem"]);
  assert.ok(approx(g1.nodeTerm, (0.2 / 4) * 0.01));
  assert.ok(approx(g2.nodeTerm, (0.2 / 16) * 0.16));
});

test("병목 동률: 미분 미정의 지점은 한쪽 미분으로 처리하고 수치 미분과 맞는다", () => {
  const p = P({ egressPerGB: 0 });
  const f = makeResourceFn(ResourceProfile.parse({ source: "measured", points: [
    { lambda: 0, cpu: 2, memGiB: 0, egressGBh: 0, storageGB: 0 },
    { lambda: 100, cpu: 3, memGiB: 16, egressGBh: 0, storageGB: 0 },
  ] }));
  const tie = 200 / 3;
  const g = gradientAt(p, f, S, tie, { respectMinNodes: false });
  assert.equal(g.tie, true);
  assert.deepEqual(new Set(g.kStar), new Set(["cpu", "mem"]));
  const cpuSlope = (0.2 / 4) * 0.01; const memSlope = (0.2 / 16) * 0.16;
  assert.ok(approx(g.leftDerivative, Math.min(cpuSlope, memSlope), 1e-6));
  assert.ok(approx(g.rightDerivative, Math.max(cpuSlope, memSlope), 1e-6));
  assert.equal(g.total, g.rightDerivative);
  const c = (l: number) => hourlyTilde(p, vendorResources(f, p, S, l), false).total;
  const h = 1e-3;
  assert.ok(Math.abs((c(tie + h) - c(tie)) / h - g.rightDerivative) < 1e-6);
  assert.ok(Math.abs((c(tie) - c(tie - h)) / h - g.leftDerivative) < 1e-6);
});

test("min 확장: 노드 종류 중 가장 싼 조합을 고르고 병목도 그 종류 기준이다", () => {
  const p = P({ egressPerGB: 0, nodeTypes: [
    { sku: "mem-heavy", hourly: 0.3, capacity: { cpu: 2, mem: 32, gpu: 0 } },
    { sku: "cpu-heavy", hourly: 0.15, capacity: { cpu: 8, mem: 8, gpu: 0 } },
  ] });
  const f = makeResourceFn(ResourceProfile.parse({ source: "measured", points: [{ lambda: 1, cpu: 4, memGiB: 12, egressGBh: 0, storageGB: 0 }] }));
  const c = hourlyCost(p, vendorResources(f, p, S, 1));
  // mem-heavy: max(2, 0.375)→2대 0.6 / cpu-heavy: max(0.5, 1.5)→2대 0.3
  assert.equal(c.nodeSku, "cpu-heavy");
  assert.equal(c.nodes, 2);
  assert.ok(approx(c.total, 0.3));
});

test("minNodes 바닥: 필요량이 0이어도 바닥 대수만큼 낸다, 기울기는 0", () => {
  const p = P({ minNodes: 2, egressPerGB: 0 });
  const r = vendorResources(fn, p, S, 10);
  assert.equal(nodeCount(p.nodeTypes[0]!, r, 2), 2);
  assert.ok(approx(hourlyCost(p, r).total, 0.4));
  const g = gradientAt(p, fn, S, 10);
  assert.equal(g.belowMinNodes, true);
  assert.equal(g.nodeTerm, 0);
});

test("거부: GPU가 필요한데 GPU 노드가 없으면 불가", () => {
  const p = P();
  const f = makeResourceFn(ResourceProfile.parse({ source: "measured", points: [{ lambda: 1, cpu: 1, memGiB: 1, egressGBh: 0, storageGB: 0, gpu: 1 }] }));
  const c = hourlyCost(p, vendorResources(f, p, S, 1));
  assert.equal(c.feasible, false);
  assert.equal(c.reason, "NO_NODE_FOR_RESOURCE");
  assert.equal(c.total, Infinity);
  // GPU 노드가 있으면 GPU가 병목이 된다
  const q = P({ nodeTypes: [{ sku: "gpu", hourly: 2, capacity: { cpu: 8, mem: 64, gpu: 1 } }], egressPerGB: 0 });
  const d = hourlyCost(q, vendorResources(f, q, S, 1));
  assert.equal(d.nodes, 1);
  assert.deepEqual(d.kStar, ["gpu"]);
});

test("거부: 노드 한도, 회선 한도, DB 등급 한도, DB 가격 없음", () => {
  const p = P({ maxNodes: 1, egressPerGB: 0 });
  assert.equal(hourlyCost(p, vendorResources(fn, p, S, 2000)).reason, "NODE_LIMIT_EXCEEDED");
  const q = P({ maxEgressGBh: 1 });
  assert.equal(hourlyCost(q, vendorResources(fn, q, S, 2000)).reason, "LINE_CAPACITY_EXCEEDED");
  const f = makeResourceFn(ResourceProfile.parse({ source: "measured", points: [{ lambda: 1, cpu: 1, memGiB: 1, egressGBh: 0, storageGB: 0, dbCpu: 64, dbMemGiB: 1 }] }));
  const s2 = Sizing.parse({});
  const r = P({ dbClasses: [{ sku: "small", hourly: 0.1, capacity: { cpu: 2, mem: 8 } }] });
  assert.equal(hourlyCost(r, vendorResources(f, r, s2, 1)).reason, "DB_CLASS_EXCEEDED");
  assert.equal(hourlyCost(P(), vendorResources(f, P(), s2, 1)).reason, "DB_PRICE_MISSING");
});

test("온프레 배치: DB가 노드 안에 들어가 r_v가 벤더마다 달라진다", () => {
  const f = makeResourceFn(ResourceProfile.parse({ source: "measured", points: [{ lambda: 1, cpu: 1, memGiB: 2, egressGBh: 0, storageGB: 10, dbCpu: 3, dbMemGiB: 4 }] }));
  const s = Sizing.parse({});
  const cloud = P({ dbClasses: [{ sku: "d", hourly: 0.1, capacity: { cpu: 4, mem: 16 } }] });
  const prem = P({ vendor: "onprem", dbOnNodes: true, dbReplicasOnNodes: 2 });
  const rc = vendorResources(f, cloud, s, 1); const rp = vendorResources(f, prem, s, 1);
  assert.equal(rc.N.cpu, 1); assert.equal(rc.dbUnits, 1);
  assert.equal(rp.N.cpu, 1 + 3 * 2); assert.equal(rp.N.mem, 2 + 4 * 2); assert.equal(rp.dbUnits, 0);
});

test("입력 검증: 잘못된 프로필과 가격을 거부한다", () => {
  const ok = { lambda: 1, cpu: 1, memGiB: 1, egressGBh: 0, storageGB: 0 };
  assert.throws(() => ResourceProfile.parse({ source: "x", points: [ok] }));
  assert.throws(() => ResourceProfile.parse({ source: "measured", points: [] }));
  assert.throws(() => ResourceProfile.parse({ source: "measured", points: [ok, ok] }), /순증가/);
  assert.throws(() => ResourceProfile.parse({ source: "measured", points: [{ ...ok, cpu: -1 }] }));
  assert.throws(() => ResourceProfile.parse({ source: "measured", points: [{ ...ok, cpu: NaN }] }));
  assert.throws(() => ResourceProfile.parse({ source: "measured", points: [{ ...ok, extra: 1 }] }));
  assert.throws(() => VendorPricing.parse({ ...pageVendor(), nodeTypes: [] }));
  assert.throws(() => VendorPricing.parse({ ...pageVendor(), vendor: "oracle" }));
  assert.throws(() => VendorPricing.parse(pageVendor({ nodeTypes: [{ sku: "z", hourly: 1, capacity: { cpu: 0, mem: 1, gpu: 0 } }] })));
});

test("단위: 월 730시간과 GB·월 → 시간 환산", () => {
  assert.equal(HOURS_PER_MONTH, 730);
  const p = P({ storagePerGBMonth: 0.131, egressPerGB: 0, dbClasses: [{ sku: "d", hourly: 0, capacity: { cpu: 1, mem: 1 } }] });
  const f = makeResourceFn(ResourceProfile.parse({ source: "measured", points: [{ lambda: 1, cpu: 0, memGiB: 0, egressGBh: 0, storageGB: 20 }] }));
  const c = hourlyCost(p, vendorResources(f, p, Sizing.parse({}), 1));
  assert.ok(approx(c.parts.storage * 730, 20 * 0.131));
});
