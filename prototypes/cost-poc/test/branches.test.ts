import assert from "node:assert/strict";
import { test } from "node:test";
import { SECURITY_OPTIONS } from "@svc/cost";
import { decide, oneTimeCost } from "../src/core/decide.js";
import { estimate, mulberry32 } from "../src/core/estimate.js";
import { EVIDENCE_REL, layerProfiles, priceOnlyProfile } from "../src/core/layering.js";
import { makeResourceFn, fitLinear } from "../src/core/resource.js";
import { monthlyCost } from "../src/core/monthly.js";
import { applySecurityOverlay, applySecurityToMigration } from "../src/core/overlay.js";
import { KrossEstimate, MigrationParams, ResourceProfile, Sizing, Traffic, VendorPricing, type ResourcePoint, type VendorPricingInput } from "../src/core/types.js";
import { approx } from "./helpers.js";

const node = (sku: string, hourly: number, cpu: number, mem: number) => ({ sku, hourly, capacity: { cpu, mem, gpu: 0 } });
const db = (sku: string, hourly: number, cpu: number, mem: number) => ({ sku, hourly, capacity: { cpu, mem } });
const vendors: VendorPricingInput[] = [
  { vendor: "aws", region: "r", fixedHourly: 0.1, nodeTypes: [node("a2", 0.118, 2, 8)], dbClasses: [db("d", 0.25, 2, 8)], storagePerGBMonth: 0.13, egressPerGB: 0.126, minNodes: 2 },
  { vendor: "gcp", region: "r", fixedHourly: 0.1, nodeTypes: [node("g2", 0.086, 2, 8)], dbClasses: [db("d", 0.18, 2, 8)], storagePerGBMonth: 0.22, egressPerGB: 0.19, minNodes: 2 },
  { vendor: "azure", region: "r", fixedHourly: 0.1, nodeTypes: [node("z2", 0.118, 2, 8)], dbClasses: [db("d", 0.25, 2, 8)], storagePerGBMonth: 0.18, egressPerGB: 0.12, minNodes: 2 },
  { vendor: "onprem", region: "r", fixedHourly: 2.5, nodeTypes: [node("s", 0.55, 60, 240)], dbOnNodes: true, dbReplicasOnNodes: 2, storagePerGBMonth: 0, egressPerGB: 0, minNodes: 2 },
];
const sizing = { targetUtil: 0.6, dbTargetUtil: 0.6, cpuRequestFloor: 0.5, memRequestFloorGiB: 1 };
const lambdas = [10, 25, 50, 100, 200];
const pt = (lambda: number, s: { c: number; e: number; d: number }, extra: Partial<ResourcePoint> = {}): ResourcePoint => ({
  lambda, cpu: 0.05 + s.c * lambda, memGiB: 0.1, egressGBh: s.e * lambda, storageGB: 20, dbCpu: 0.02 + s.d * lambda, dbMemGiB: 0.1, ...extra,
});
const measured = ResourceProfile.parse({ source: "measured", points: lambdas.map((l) => pt(l, { c: 0.001, e: 0.0065, d: 0.0015 }, { p95Ms: 5, errorRate: 0 })), storageGrowthGBPerRequest: 1e-7 });
const sample = ResourceProfile.parse({ source: "sample", points: lambdas.map((l) => pt(l, { c: 0.002, e: 0.001, d: 0.004 })) });
const priceOnly = priceOnlyProfile({ lambdas: [0, 2000], baseCpu: 0.5, cpuPerRps: 0.01, memGiB: 1, bytesPerRequest: 20000, storageGB: 20, dbBaseCpu: 0.1, dbCpuPerRps: 0.002, dbMemGiB: 1 });
const observed: ResourcePoint[] = [pt(25, { c: 0.0011, e: 0.0068, d: 0.0016 })];
const traffic = { kind: "diurnal" as const, peak: 100, troughRatio: 0.2 };

const runBranch = (layers: Parameters<typeof layerProfiles>[0], seed = 1) => {
  const l = layerProfiles(layers, { peakLambda: 100 });
  return { l, out: estimate({ profile: l.profile, pricing: vendors, sizing, traffic, from: "aws", evidence: l.evidence, rel: l.rel, options: { draws: 50, seed, lambdaRange: [0, 5000] } }) };
};

const shapeOf = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.length ? [shapeOf(x[0])] : [];
  if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, shapeOf((x as Record<string, unknown>)[k])]));
  return typeof x;
};

test("세 갈래: 같은 엔진을 지나고 출력 계약이 같다", () => {
  const a = runBranch({ priceOnly }).out;
  const b = runBranch({ sample, observed }).out;
  const c = runBranch({ measured }).out;
  for (const o of [a, b, c]) assert.doesNotThrow(() => KrossEstimate.parse(o));
  assert.deepEqual([a.source, b.source, c.source], ["price-only", "observed", "measured"]);
  // 벤더 줄의 키 구성이 같다 (값 타입 포함)
  const pick = (o: typeof a) => shapeOf({ v: o.vendors[0], d: o.decision, g: o.gradients[0], e: o.evidence[0] });
  assert.deepEqual(pick(a), pick(c));
  assert.deepEqual(pick(b), pick(c));
  assert.deepEqual(Object.keys(a).sort(), Object.keys(c).sort());
});

test("세 갈래: 갈래가 바뀌어도 C_v는 그대로다 (가격은 같고 r만 다르다)", () => {
  // 같은 r을 넣으면 프로필 라벨과 상관없이 비용이 같다
  const asSample = ResourceProfile.parse({ ...measured, source: "sample" });
  const asPrice = ResourceProfile.parse({ ...measured, source: "price-only" });
  const asObs = ResourceProfile.parse({ ...measured, source: "observed" });
  const s = Sizing.parse(sizing); const tr = Traffic.parse(traffic);
  for (const v of vendors) {
    const p = VendorPricing.parse(v);
    const totals = [measured, asSample, asPrice, asObs].map((pr) => monthlyCost(p, makeResourceFn(pr), s, tr).totalUsd);
    assert.ok(totals.every((x) => x === totals[0]));
  }
});

test("층 쌓기 우선순위: 모양은 measured > sample > price-only", () => {
  assert.equal(layerProfiles({ measured, sample, priceOnly }).profile.source, "measured");
  assert.equal(layerProfiles({ sample, priceOnly }).profile.source, "sample");
  assert.equal(layerProfiles({ priceOnly }).profile.source, "price-only");
  const l = layerProfiles({ measured, sample, priceOnly });
  assert.deepEqual(l.profile.points.map((p) => p.cpu), measured.points.map((p) => p.cpu));
  assert.ok(l.evidence.every((e) => e.shape === "measured" && e.level === "measured"));
});

test("층 쌓기: 운영 지표는 수준을 비율로 보정하고 모양은 유지한다", () => {
  const l = layerProfiles({ sample, observed });
  const fn = makeResourceFn(l.profile);
  // λ=25에서 관측값을 지난다
  assert.ok(approx(fn.at(25).cpu, observed[0]!.cpu));
  assert.ok(approx(fn.at(25).egressGBh, observed[0]!.egressGBh));
  // 기울기 비는 샘플과 같다 (비율 보정이라 모양 유지)
  const base = makeResourceFn(sample);
  const ratio = (x: number, y: number) => x / y;
  assert.ok(approx(ratio(fn.at(100).cpu, fn.at(25).cpu), ratio(base.at(100).cpu, base.at(25).cpu)));
  const e = l.evidence.find((x) => x.field === "cpu")!;
  assert.equal(e.shape, "sample"); assert.equal(e.level, "observed");
  assert.ok(e.calibration !== undefined);
});

test("층 쌓기: 운영 지표가 샌드박스 실측도 보정한다, 라벨은 measured", () => {
  const l = layerProfiles({ measured, observed });
  assert.equal(l.profile.source, "measured");
  const e = l.evidence.find((x) => x.field === "egressGBh")!;
  assert.equal(e.shape, "measured"); assert.equal(e.level, "observed");
  assert.ok(approx(makeResourceFn(l.profile).at(25).egressGBh, observed[0]!.egressGBh));
});

test("층 쌓기: 범위가 넓은 운영 지표 여러 점이면 모양까지 운영 지표가 맡는다", () => {
  const obs = [pt(10, { c: 0.002, e: 0.002, d: 0.002 }), pt(100, { c: 0.002, e: 0.002, d: 0.002 })];
  const l = layerProfiles({ sample, observed: obs });
  assert.equal(l.evidence[0]!.shape, "observed");
  const fn = makeResourceFn(l.profile);
  assert.ok(approx(fn.at(100).cpu, obs[1]!.cpu));
  assert.equal(l.profile.source, "observed");
});

test("층 쌓기 거부: 입력이 없거나 모양이 없으면 실패, 보정이 범위를 벗어나면 경고", () => {
  assert.throws(() => layerProfiles({}), /LAYER_EMPTY/);
  assert.throws(() => layerProfiles({ observed }), /LAYER_NO_SHAPE/);
  const wild = [pt(25, { c: 1, e: 1, d: 1 })];
  const l = layerProfiles({ sample, observed: wild });
  assert.ok(l.warnings.length > 0);
  assert.ok(l.evidence.some((e) => e.calibration === 10));
});

test("근거 수준: 불확실성은 price-only > sample > measured", () => {
  for (const f of ["cpu", "egressGBh"]) {
    assert.ok(EVIDENCE_REL["price-only"]![f]! > EVIDENCE_REL.sample![f]!);
    assert.ok(EVIDENCE_REL.sample![f]! > EVIDENCE_REL.measured![f]!);
  }
  const width = (o: ReturnType<typeof runBranch>["out"]) => { const r = o.vendors.find((v) => v.vendor === "aws")!.monthlyUsd!; return (r.high - r.low) / r.base; };
  assert.ok(width(runBranch({ priceOnly }).out) > width(runBranch({ measured }).out));
});

test("재현성: 같은 씨앗이면 결과가 바이트까지 같고, 씨앗이 다르면 범위가 달라질 수 있다", () => {
  assert.equal(JSON.stringify(runBranch({ measured }, 7).out), JSON.stringify(runBranch({ measured }, 7).out));
  assert.equal(mulberry32(1)(), mulberry32(1)());
});

test("이전 판단: 절감이 작으면 옮기지 마세요 (회수 기간 초과)", () => {
  const { out } = runBranch({ measured });
  assert.ok(out.decision);
  assert.equal(out.decision!.from, "aws");
  assert.equal(out.decision!.verdict, "stay");
  assert.equal(out.decision!.reason, "PAYBACK_TOO_LONG");
  assert.ok(out.decision!.paybackMonths! > 12);
  assert.ok(out.decision!.oneTimeUsd! > 3000, "엔지니어 80h x $40 = $3,200이 바닥");
});

test("이전 판단 규칙: 표로 고정", () => {
  const p = MigrationParams.parse({ maxPaybackMonths: 12 });
  const one = { total: 1200, breakdown: { engineering: 1200 } };
  const c = (base: number, low: number) => [{ vendor: "gcp" as const, monthly: { base: 100, low: 90, high: 110 }, oneTime: one, saving: { base, low, high: base * 2 } }];
  const cur = { base: 200, low: 180, high: 220 };
  assert.equal(decide("aws", cur, c(200, 50), p).verdict, "move");
  assert.equal(decide("aws", cur, c(200, 50), p).paybackMonths, 6);
  assert.equal(decide("aws", cur, c(50, 10), p).reason, "PAYBACK_TOO_LONG");
  assert.equal(decide("aws", cur, c(-5, -10), p).reason, "NO_SAVING");
  assert.equal(decide("aws", cur, c(200, -50), p).verdict, "insufficient-evidence");
  assert.equal(decide("aws", cur, [], p).reason, "NO_FEASIBLE_TARGET");
  assert.equal(decide("aws", null, c(200, 50), p).reason, "CURRENT_ENV_NOT_PRICED");
});

test("일회성 비용 손 검산: 항목 합, 송신료 면제", () => {
  const p = MigrationParams.parse({ engineerHours: 80, engineerUsdPerHour: 40, parallelRunDays: 7, sandboxHours: 8, llmUsd: 20 });
  const o = oneTimeCost({ params: p, targetHourlyUsd: 0.5, sourceEgressPerGB: 0.126, dataGB: 100 });
  assert.equal(o.breakdown["engineering"], 3200);
  assert.equal(o.breakdown["parallelRun"], 84);
  assert.equal(o.breakdown["sandbox"], 4);
  assert.ok(approx(o.breakdown["dataTransfer"]!, 12.6));
  assert.ok(approx(o.total, 3200 + 84 + 4 + 12.6 + 20));
  const w = oneTimeCost({ params: MigrationParams.parse({ egressWaived: true }), targetHourlyUsd: 0, sourceEgressPerGB: 0.126, dataGB: 100 });
  assert.equal(w.breakdown["dataTransfer"], 0);
});

test("제약: 레지던시와 SLO가 후보를 거른다, 전부 걸러지면 best가 없다", () => {
  const kr = estimate({ profile: measured, pricing: vendors, sizing, traffic, constraints: { residency: ["JP"] } });
  assert.equal(kr.best, null);
  assert.ok(kr.vendors.every((v) => v.reason === "RESIDENCY"));
  const only = estimate({ profile: measured, pricing: vendors.map((v) => ({ ...v, residency: v.vendor === "onprem" ? "KR" : "US" })), sizing, traffic, constraints: { residency: ["KR"] } });
  assert.equal(only.best, "onprem");
  const slo = estimate({ profile: measured, pricing: vendors, sizing, traffic, constraints: { p95Ms: 1 } });
  assert.ok(slo.vendors.every((v) => v.reason === "SLO_P95"));
  const perVendor = estimate({ profile: measured, pricing: vendors, sizing, traffic, constraints: { p95Ms: 50, vendorSlo: { gcp: { p95Ms: 60 } } } });
  assert.equal(perVendor.vendors.find((v) => v.vendor === "gcp")!.reason, "SLO_P95");
  assert.ok(perVendor.vendors.find((v) => v.vendor === "aws")!.feasible);
  const err = estimate({ profile: measured, pricing: vendors, sizing, traffic, constraints: { errorRate: 0.01 } });
  assert.ok(err.vendors.every((v) => v.feasible));
  const noData = estimate({ profile: priceOnly, pricing: vendors, sizing, traffic, constraints: { p95Ms: 50 } });
  assert.ok(noData.vendors[0]!.constraintNotes.includes("p95 미측정"));
});

test("입력 거부: 벤더 없음, 중복 벤더", () => {
  assert.throws(() => estimate({ profile: measured, pricing: [], traffic }), /NO_VENDORS/);
  assert.throws(() => estimate({ profile: measured, pricing: [vendors[0]!, vendors[0]!], traffic }), /DUPLICATE_VENDOR/);
  assert.throws(() => estimate({ profile: { source: "measured", points: [] }, pricing: vendors, traffic }));
});

test("외삽 경고: 피크가 측정 범위 밖이면 표시한다", () => {
  const out = estimate({ profile: measured, pricing: vendors, sizing, traffic: { kind: "constant", lambda: 900 } });
  assert.ok(out.warnings.some((w) => w.includes("외삽")));
});

test("보안 프로필: 식을 안 바꾸고 파라미터로 얹힌다, 추가비는 팀 값과 같다", () => {
  const s = Sizing.parse(sizing); const tr = Traffic.parse({ kind: "constant", lambda: 50 });
  const fn = makeResourceFn(measured);
  const base = VendorPricing.parse(vendors[0]!);
  const hard = VendorPricing.parse(applySecurityOverlay(vendors[0]!, "hardened"));
  const m0 = monthlyCost(base, fn, s, tr, { applyEgressTiers: false }); const m1 = monthlyCost(hard, fn, s, tr, { applyEgressTiers: false });
  const teamExtra = SECURITY_OPTIONS.find((o) => o.level === "hardened")!.extraMonthly({ db: m0.parts.db });
  assert.ok(approx(m1.totalUsd - m0.totalUsd, teamExtra));
  assert.equal(applySecurityOverlay(vendors[0]!, "basic"), vendors[0]);
  const a = estimate({ profile: measured, pricing: vendors, sizing, traffic, from: "aws" });
  const b = estimate({ profile: measured, pricing: vendors.map((v) => applySecurityOverlay(v, "hardened")), sizing, traffic, from: "aws", migration: applySecurityToMigration({}, "hardened") });
  assert.deepEqual(shapeOf(a.vendors[0]), shapeOf(b.vendors[0]));
  assert.ok(b.vendors[0]!.monthlyUsd!.base > a.vendors[0]!.monthlyUsd!.base);
});

test("회귀: 적합도와 직선 복원", () => {
  const f = fitLinear([1, 2, 3, 4], [3, 5, 7, 9]);
  assert.ok(approx(f.slope, 2)); assert.ok(approx(f.intercept, 1)); assert.ok(approx(f.r2, 1)); assert.ok(f.rmse < 1e-9);
  const g = fitLinear([5], [7]);
  assert.equal(g.slope, 0); assert.equal(g.intercept, 7);
  assert.throws(() => fitLinear([], []));
  const noisy = fitLinear([1, 2, 3, 4], [1, 3, 2, 5]);
  assert.ok(noisy.r2 < 1 && noisy.r2 > 0.5);
  const pr = makeResourceFn(measured, "regression");
  assert.ok(pr.fits!.cpu.r2 > 0.999);
  assert.ok(approx(pr.at(300).cpu, 0.05 + 0.001 * 300, 1e-6), "직선 데이터면 외삽도 정확");
});
