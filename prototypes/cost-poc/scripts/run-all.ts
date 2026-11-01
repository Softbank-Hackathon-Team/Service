import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AppSpec, CostEstimate, CostEstimateRequest } from "@svc/contracts";
import { estimateCost, loadCatalog } from "@svc/cost";
import { estimateViaKross, priceFilesToCatalog } from "../src/adapter/team.js";
import { hourlyCost, hourlyTilde, HOURS_PER_MONTH, maxRatio } from "../src/core/cost.js";
import { curveActual, cheapestEnvelope, findCrossovers, curveApprox } from "../src/core/crossover.js";
import { estimate, type EstimateInput } from "../src/core/estimate.js";
import { gradientAt } from "../src/core/gradient.js";
import { layerProfiles, priceOnlyProfile } from "../src/core/layering.js";
import { makeResourceFn, vendorResources } from "../src/core/resource.js";
import { ResourceProfile, Sizing, VendorPricing, type ResourcePoint, type VendorId } from "../src/core/types.js";
import { collectOnprem, DEFAULT_ONPREM } from "../src/collect/onprem.js";
import { fileToPricing, loadPriceFiles, loadPricing, type MatchOptions } from "../src/match.js";
import { fitStages, growthPerRequest, mean, parseStages, toPoint, type StageRow } from "../src/measure-parse.js";

// DRAFT(ai): 원자료 → 세 갈래 비교, 역전점, 회수 기간, 민감도, 팀 코드 대조 → outputs/results.json
// 네트워크 없음. 같은 입력이면 같은 출력(시간 측정 제외).

const out = new URL("../outputs/", import.meta.url);
mkdirSync(out, { recursive: true });

export const CPU_SCALE = 2.5; // 가정: Apple M3 Pro 코어 1개 ≈ 클라우드 x86 vCPU(하이퍼스레드) 2.5개. 벤치마크 경향으로 잡은 값이며 이 POC에서 재지 않았다
const STORAGE_GB = 20;        // examples/shop AppSpec database.storageGb (프로비저닝 값)
const TRAIN = [10, 25, 50, 100, 200];
const HOLD = [150, 400];
const KNEE = [800, 1200, 1600, 2400, 4800]; // 8000은 SLO가 깨져 r 정의(SLO를 지킨 상태)에서 뺀다
const VENDORS: VendorId[] = ["aws", "gcp", "azure", "onprem"];
const PEAK = 100;

const spec = AppSpec.parse(JSON.parse(readFileSync(new URL("../vendor/team/examples/shop/spec/appspec.shop.json", import.meta.url), "utf8")));
const sizingInput = {
  targetUtil: 0.6, dbTargetUtil: 0.6,          // 팀 LoadParams.utilTarget 기본값과 같다
  cpuRequestFloor: 2 * 0.25, memRequestFloorGiB: 2 * 0.5, // AppSpec replicas 2 x 250m, 512Mi
  systemCpu: 0.2, systemMemGiB: 0.5,           // 가정: 클러스터 애드온 몫
};
const sizing = Sizing.parse(sizingInput);
const matchBase: MatchOptions = { nodeDiskGB: 50 };

const rows = parseStages(new URL("../data/measure/stages.jsonl", import.meta.url));
const target = rows.filter((r) => r.mix === "target");
const write = rows.filter((r) => r.mix === "write");
const idle = rows.filter((r) => r.mix === "idle");

const idlePoint: ResourcePoint = {
  lambda: 0, cpu: mean(idle.map((x) => x.appCpu + x.proxyCpu)) * CPU_SCALE, memGiB: mean(idle.map((x) => x.appMemGiB + x.proxyMemGiB)),
  egressGBh: 0, storageGB: STORAGE_GB, dbCpu: mean(idle.map((x) => x.dbCpu)) * CPU_SCALE, dbMemGiB: mean(idle.map((x) => x.dbMemGiB)),
};
const growthTarget = growthPerRequest(target.filter((r) => [...TRAIN, ...HOLD].includes(r.targetRps)));
const growthWrite = growthPerRequest(write);

const measuredProfile = ResourceProfile.parse({
  source: "measured", storageGrowthGBPerRequest: growthTarget,
  points: [idlePoint, ...TRAIN.map((l) => toPoint(target, l, CPU_SCALE, STORAGE_GB))],
  note: "로컬 도커 실측 (Apple M3 Pro, Postgres 16, 앱 복제본 1개). CPU는 CPU_SCALE을 곱한 값",
});
// 곡선·사례·민감도용: 다섯 단계 + 검증 단계 + 높은 단계 전부 (8000 제외). 앞의 measuredProfile은 예측 오차 검증과 세 갈래 비교용
const ALL_STAGES = [...TRAIN, ...HOLD, ...KNEE].sort((a, b) => a - b);
const measuredFull = ResourceProfile.parse({
  source: "measured", storageGrowthGBPerRequest: growthTarget,
  points: [idlePoint, ...ALL_STAGES.map((l) => toPoint(target, l, CPU_SCALE, STORAGE_GB))],
  note: "로컬 도커 실측 전체 (0~4800 req/s)",
});
const sampleProfile = ResourceProfile.parse({
  source: "sample", storageGrowthGBPerRequest: growthWrite,
  points: [idlePoint, ...[10, 50, 200].map((l) => toPoint(write, l, CPU_SCALE, STORAGE_GB))],
  note: "미리 한 번 잰 값: 쓰기 위주 데모 부하(writer.mjs와 같은 구성)",
});
const observedPoint: ResourcePoint[] = [toPoint(target.filter((r) => r.round === 1), 25, CPU_SCALE, STORAGE_GB)];
const priceOnly = priceOnlyProfile({
  lambdas: [0, 200, 2000], baseCpu: 0.5, cpuPerRps: 0.01, // 팀 LoadParams 기본값
  memGiB: 1, bytesPerRequest: 20000,                       // 가정: 응답 20KB
  storageGB: STORAGE_GB, dbBaseCpu: 0.1, dbCpuPerRps: 0.002, dbMemGiB: 1, // 가정
});

// 회귀 적합도 (라운드별 원자료)
const fits = fitStages(target, TRAIN, CPU_SCALE);
const fitTable = Object.fromEntries(Object.entries(fits).map(([k, f]) => [k, { intercept: f.intercept, slope: f.slope, r2: f.r2, rmse: f.rmse, n: f.n }]));
const atPeak = (k: keyof typeof fits) => Math.abs(fits[k].intercept + fits[k].slope * PEAK);
const fitRel = Object.fromEntries((Object.keys(fits) as (keyof typeof fits)[]).map((k) => [k, fits[k].rmse / Math.max(atPeak(k), 1e-9)]));
// 구간 차분
const seg = (f: (p: ResourcePoint) => number) => {
  const pts = measuredProfile.points;
  return pts.slice(1).map((p, i) => ({ from: pts[i]!.lambda, to: p.lambda, slope: (f(p) - f(pts[i]!)) / (p.lambda - pts[i]!.lambda) }));
};
const segments = { cpu: seg((p) => p.cpu), memGiB: seg((p) => p.memGiB), egressGBh: seg((p) => p.egressGBh), dbCpu: seg((p) => p.dbCpu ?? 0) };

const pricing = loadPricing(matchBase);
const trafficMain = { kind: "diurnal" as const, peak: PEAK, troughRatio: 0.2 };

// 로컬 코어를 클라우드 vCPU로 옮기는 배수의 불확실성(±40%, 가정)을 CPU 필드에 더한다
const addLocal = (rel: Record<string, number>) => ({ ...rel, cpu: Math.hypot(rel["cpu"] ?? 0, 0.4), dbCpu: Math.hypot(rel["dbCpu"] ?? 0, 0.4) });

const branch = (name: string, layers: Parameters<typeof layerProfiles>[0], extra: Partial<EstimateInput> = {}, fnMode: "segment" | "regression" = "segment", local = true) => {
  const l = layerProfiles(layers, { peakLambda: PEAK, ...(layers.measured ? { fitRel } : {}) });
  const rel = local ? addLocal(l.rel) : l.rel;
  const res = estimate({
    profile: l.profile, pricing, sizing: sizingInput, traffic: trafficMain, from: "aws",
    evidence: l.evidence, rel, warnings: l.warnings,
    options: { fnMode, draws: 400, seed: 20261101, perfSpread: 0.15, lambdaRange: [0, 8000] }, ...extra,
  });
  return { name, profile: l.profile, rel, res, fnMode };
};

const branches = [
  branch("1. 공개 가격표만 (price-only)", { priceOnly }, {}, "segment", false),
  branch("2. 현재 사용량 + 미리 잰 값 (observed + sample)", { sample: sampleProfile, observed: observedPoint }),
  branch("3. 부하 테스트 실측 (measured)", { measured: measuredProfile }, {}, "regression"),
];

// 예측 대 관측: 검증 단계는 회귀에 넣지 않았다
const parsedPricing = pricing.map((p) => VendorPricing.parse(p));
const truthLambdas = [...HOLD, ...KNEE.filter((l) => target.some((r) => r.targetRps === l))];
const fieldsForErr = ["cpu", "memGiB", "egressGBh", "dbCpu", "dbMemGiB"] as const;
const predictionErrors = branches.map((b) => {
  const fn = makeResourceFn(b.profile, b.fnMode);
  return {
    name: b.name,
    points: truthLambdas.map((l) => {
      const truth = toPoint(target, l, CPU_SCALE, STORAGE_GB);
      const pred = fn.at(l);
      const fields = Object.fromEntries(fieldsForErr.map((f) => {
        const t = truth[f] ?? 0;
        return [f, { pred: pred[f], obs: t, ape: t > 0 ? Math.abs(pred[f] - t) / t : null }];
      }));
      const truthFn = makeResourceFn(ResourceProfile.parse({ source: "measured", points: [truth] }));
      const cost = Object.fromEntries(parsedPricing.map((p) => {
        const c0 = hourlyCost(p, vendorResources(truthFn, p, sizing, l)).total;
        const c1 = hourlyCost(p, vendorResources(fn, p, sizing, l)).total;
        return [p.vendor, { obs: c0, pred: c1, ape: Math.abs(c1 - c0) / c0 }];
      }));
      return { lambda: l, inRange: l <= 200, p95Ms: truth.p95Ms, errorRate: truth.errorRate, fields, cost };
    }),
  };
});

// 비용 곡선 (실측 갈래)
const fnMeasured = makeResourceFn(measuredFull, "regression");
const fitsFull = fitStages(target, ALL_STAGES, CPU_SCALE);
const fitFullTable = Object.fromEntries(Object.entries(fitsFull).map(([k, f]) => [k, { intercept: f.intercept, slope: f.slope, r2: f.r2, rmse: f.rmse, n: f.n }]));
const fitRelFull = Object.fromEntries((Object.keys(fitsFull) as (keyof typeof fitsFull)[]).map((k) => [k, fitsFull[k].rmse / Math.max(Math.abs(fitsFull[k].intercept + fitsFull[k].slope * 1000), 1e-9)]));
const kneeRow = target.filter((r) => r.targetRps >= 4800).map((r) => ({ rps: r.targetRps, achieved: r.achievedRps, p95Ms: r.p95Ms, errorRate: r.errorRate }));
const LMAX = 8000;
const grid = Array.from({ length: 801 }, (_, i) => (i * LMAX) / 800);
const curves = parsedPricing.map((p) => ({
  vendor: p.vendor,
  actual: grid.map((l) => { const c = hourlyCost(p, vendorResources(fnMeasured, p, sizing, l)); return c.feasible ? c.total : null; }),
  approx: grid.map((l) => { const c = hourlyTilde(p, vendorResources(fnMeasured, p, sizing, l)); return c.feasible ? c.total : null; }),
  nodes: grid.map((l) => hourlyCost(p, vendorResources(fnMeasured, p, sizing, l)).nodes),
  sku: grid.map((l) => hourlyCost(p, vendorResources(fnMeasured, p, sizing, l)).nodeSku),
}));
const lmaxCurves = parsedPricing.map((p) => curveActual(p, fnMeasured, sizing, 0, LMAX));
const tmaxCurves = parsedPricing.map((p) => curveApprox(p, fnMeasured, sizing));
const cross = { actual: [] as ReturnType<typeof findCrossovers>, approx: [] as ReturnType<typeof findCrossovers> };
for (let i = 0; i < lmaxCurves.length; i++) for (let j = i + 1; j < lmaxCurves.length; j++) {
  cross.actual.push(...findCrossovers(lmaxCurves[i]!, lmaxCurves[j]!, 0, LMAX, { extraPoints: fnMeasured.knots }));
  cross.approx.push(...findCrossovers(tmaxCurves[i]!, tmaxCurves[j]!, 0, LMAX, { extraPoints: grid, samples: 2 }));
}
const envelope = cheapestEnvelope(lmaxCurves, 0, LMAX, { extraPoints: fnMeasured.knots });
const tildeEnvelope = cheapestEnvelope(tmaxCurves, 0, LMAX, { extraPoints: grid });

// 기울기 분해
const gradLambdas = [10, 100, 1000, 5000];
const gradients = gradLambdas.map((l) => ({ lambda: l, byVendor: parsedPricing.map((p) => gradientAt(p, fnMeasured, sizing, l)) }));
const onpremNoFloor = parsedPricing.map((p) => gradientAt(p, fnMeasured, sizing, 1000, { respectMinNodes: false }));

// 이전 판단 사례
const scenario = (name: string, from: VendorId, peak: number, extra: Partial<EstimateInput> = {}, profile = measuredFull) => {
  const l = layerProfiles({ measured: profile }, { peakLambda: peak, fitRel: fitRelFull });
  const res = estimate({
    profile: l.profile, pricing, sizing: sizingInput, traffic: { kind: "diurnal", peak, troughRatio: 0.2 }, from,
    evidence: l.evidence, rel: addLocal(l.rel), warnings: l.warnings,
    options: { fnMode: "regression", draws: 200, seed: 7, perfSpread: 0.15, lambdaRange: [0, Math.max(peak * 3, 8000)] }, ...extra,
  });
  return { name, from, peak, best: res.best, decision: res.decision, monthly: Object.fromEntries(res.vendors.map((v) => [v.vendor, v.monthlyUsd])), probBest: Object.fromEntries(res.vendors.map((v) => [v.vendor, v.probBest])), warnings: res.warnings };
};
const priceOnlyScenario = (name: string, from: VendorId, peak: number) => {
  const l = layerProfiles({ priceOnly }, { peakLambda: peak });
  const res = estimate({ profile: l.profile, pricing, sizing: sizingInput, traffic: { kind: "diurnal", peak, troughRatio: 0.2 }, from,
    evidence: l.evidence, rel: l.rel, options: { draws: 200, seed: 7, perfSpread: 0.15, lambdaRange: [0, 8000] } });
  return { name, from, peak, best: res.best, decision: res.decision, monthly: Object.fromEntries(res.vendors.map((v) => [v.vendor, v.monthlyUsd])), probBest: Object.fromEntries(res.vendors.map((v) => [v.vendor, v.probBest])), warnings: res.warnings };
};
const scenarios = [
  scenario("A. AWS에서 소규모 (피크 100 req/s)", "aws", 100),
  scenario("B. GCP에서 중간 규모 (피크 1000 req/s)", "gcp", 1000),
  scenario("C. AWS에서 대규모 (피크 5000 req/s)", "aws", 5000),
  scenario("D. 온프레에서 소규모 (피크 100 req/s)", "onprem", 100),
  scenario("E. GCP에서 소규모 (피크 100 req/s)", "gcp", 100),
  scenario("F. AWS에서 중간 규모 (피크 1000 req/s)", "aws", 1000),
  scenario("G. GCP에서 대규모 (피크 5000 req/s)", "gcp", 5000),
  scenario("H. AWS에서 초대규모 (피크 8000 req/s, 외삽)", "aws", 8000),
  // 같은 질문을 근거만 바꿔 묻는다: 가격표만이면 옮기라고 하고, 실측이면 옮기지 말라고 한다
  priceOnlyScenario("I. GCP에서 피크 300 req/s, 가격표만 (실측 없음)", "gcp", 300),
  scenario("J. GCP에서 피크 300 req/s, 실측", "gcp", 300),
  priceOnlyScenario("K. AWS에서 피크 500 req/s, 가격표만 (실측 없음)", "aws", 500),
  scenario("L. AWS에서 피크 5650 req/s, 실측 (경계 부근)", "aws", 5650),
];
const paybackSweep = [10, 25, 50, 100, 200, 400, 700, 1000, 1500, 2000, 3000, 4000, 5000, 5650, 6000, 8000].flatMap((peak) =>
  (["aws", "gcp"] as VendorId[]).map((from) => {
    const s = scenario(`${from}-${peak}`, from, peak, { options: { fnMode: "regression", draws: 40, seed: 11, perfSpread: 0.15, lambdaRange: [0, 8000] } });
    return { from, peak, verdict: s.decision!.verdict, reason: s.decision!.reason, to: s.decision!.to, saving: s.decision!.monthlySavingUsd, oneTime: s.decision!.oneTimeUsd, payback: s.decision!.paybackMonths };
  }));

// 민감도: 사례 F (AWS, 피크 1000)
const sens = (name: string, match: MatchOptions, opts: { sizing?: typeof sizingInput; profile?: ResourceProfile; overrides?: (p: VendorPricing[]) => VendorPricing[] } = {}) => {
  let pr = loadPricing({ ...matchBase, ...match }).map((p) => VendorPricing.parse(p));
  if (opts.overrides) pr = opts.overrides(pr);
  const res = estimate({
    profile: opts.profile ?? measuredFull, pricing: pr, sizing: opts.sizing ?? sizingInput, traffic: { kind: "diurnal", peak: 1000, troughRatio: 0.2 }, from: "aws",
    options: { fnMode: "regression", draws: 0, lambdaRange: [0, 2000] },
  });
  return { name, best: res.best, monthly: Object.fromEntries(res.vendors.map((v) => [v.vendor, v.monthlyUsd?.base ?? null])), verdict: res.decision!.verdict, reason: res.decision!.reason, to: res.decision!.to, payback: res.decision!.paybackMonths };
};
const scaleCpu = (p: ResourceProfile, f: number) => ({ ...p, points: p.points.map((x) => ({ ...x, cpu: x.cpu * f, dbCpu: (x.dbCpu ?? 0) * f })) });
const premOverride = (a: typeof DEFAULT_ONPREM) => (pr: VendorPricing[]) => pr.map((p) => {
  if (p.vendor !== "onprem") return p;
  return VendorPricing.parse(fileToPricing(collectOnprem(a, new Date("2026-11-01T00:00:00Z")), matchBase));
});
const gcpStd = (pr: VendorPricing[]) => pr.map((p) => (p.vendor === "gcp" ? { ...p, egressPerGB: 0.119, egressTiers: [{ fromGB: 0, usdPerGB: 0 }, { fromGB: 200, usdPerGB: 0.119 }, { fromGB: 10240, usdPerGB: 0.109 }, { fromGB: 153600, usdPerGB: 0.097 }] } : p));
const azureInet = (pr: VendorPricing[]) => pr.map((p) => (p.vendor === "azure" ? { ...p, egressPerGB: 0.11, egressTiers: [{ fromGB: 0, usdPerGB: 0 }, { fromGB: 100, usdPerGB: 0.11 }, { fromGB: 10100, usdPerGB: 0.075 }, { fromGB: 50100, usdPerGB: 0.07 }, { fromGB: 150100, usdPerGB: 0.06 }] } : p));
const sensitivity = [
  sens("기준 (온디맨드, 디스크 50GB, LB 제외, 버스터블 포함)", {}),
  sens("1년 약정 단가", { useCommit1y: true }),
  sens("로드 밸런서 포함 (ALB만 수집)", { includeLb: true }),
  sens("NAT 경유 (비공개 서브넷 + cloudflared 터널)", { includeNat: true }),
  sens("노드 디스크 0GB (팀 계산과 같게)", { nodeDiskGB: 0 }),
  sens("GKE 무료 크레딧 포함", { applyGkeCredit: true }),
  sens("버스터블 제외", { excludeBurstable: true }),
  sens("GCP 송신 Standard Tier", {}, { overrides: gcpStd }),
  sens("Azure 송신 Internet 라우팅", {}, { overrides: azureInet }),
  sens("AWS 성능 +15%", { cpuPerf: { aws: 1.15 } }),
  sens("GCP 성능 -15%", { cpuPerf: { gcp: 0.85 } }),
  sens("로컬→클라우드 CPU 배수 1.5", {}, { profile: ResourceProfile.parse(scaleCpu(measuredFull, 1.5 / CPU_SCALE)) }),
  sens("로컬→클라우드 CPU 배수 4", {}, { profile: ResourceProfile.parse(scaleCpu(measuredFull, 4 / CPU_SCALE)) }),
  sens("여유분 targetUtil 0.8", {}, { sizing: { ...sizingInput, targetUtil: 0.8, dbTargetUtil: 0.8 } }),
  sens("온프레 운영 인력 0 (이미 있는 인력으로 봄)", {}, { overrides: premOverride({ ...DEFAULT_ONPREM, opsFte: 0 }) }),
  sens("온프레 서버 $22,000", {}, { overrides: premOverride({ ...DEFAULT_ONPREM, server: { ...DEFAULT_ONPREM.server, capexUsd: 22000 } }) }),
  sens("온프레 감가 36개월", {}, { overrides: premOverride({ ...DEFAULT_ONPREM, server: { ...DEFAULT_ONPREM.server, amortMonths: 36 } }) }),
];

// 팀 코드 대조
const teamCatalog = loadCatalog({ dir: new URL("../vendor/team/packages/cost/prices/", import.meta.url) });
const teamReq = { spec, from: "aws" as const, targets: ["aws", "gcp", "onprem", "azure_mock"] as const, traffic: { peakRps: 10 } } as const;
const teamNow = estimateCost({ ...teamReq, targets: [...teamReq.targets] }, teamCatalog, { breakpoints: { maxRps: 2000, step: 1 } });
const kAdapter = estimateViaKross({ ...teamReq, targets: [...teamReq.targets] }, teamCatalog);
const files = loadPriceFiles();
const { catalog: pocCatalog, dropped } = priceFilesToCatalog(files, "2026-11-01T00:00:00.000Z");
const teamWithNewPrices = estimateCost({ ...teamReq, targets: ["aws", "gcp", "azure_mock"] }, pocCatalog, { breakpoints: false });
const measuredForTeam = (() => {
  // 팀 LoadParams로 실측 기울기를 넘기면 어디까지 되는가
  const f = fitsFull;
  return { baseVcpu: Math.max(0, f.cpu.intercept), vcpuPerRps: Math.max(0, f.cpu.slope), source: "measured" as const };
})();
const teamMeasured = estimateCost({ ...teamReq, targets: ["aws", "gcp", "azure_mock"], load: measuredForTeam }, pocCatalog, { breakpoints: false });
const adapterWithPoc = estimateViaKross({ spec, from: "aws", targets: ["aws", "gcp", "azure_mock", "onprem"], traffic: { peakRps: PEAK } },
  pocCatalog, { pricing, profile: measuredFull, sizing: sizingInput, breakpoints: { maxRps: 8000 } });
CostEstimate.parse(adapterWithPoc);
CostEstimateRequest.parse({ ...teamReq, targets: [...teamReq.targets] });

// 데모 대본의 숫자 다시 보기: 10 rps, 같은 AppSpec, 같은 노드 후보 범위. 하나씩 바꿔 본다
const demoRecheck = (() => {
  const row = (name: string, match: MatchOptions, prof: ResourceProfile) => {
    const pr = loadPricing({ nodeDiskGB: 0, ...match });
    const res = estimate({ profile: prof, pricing: pr, sizing: sizingInput, traffic: { kind: "constant", lambda: 10 }, options: { fnMode: "regression", draws: 0, lambdaRange: [0, 100] } });
    const m = (v: VendorId) => res.vendors.find((x) => x.vendor === v)!.monthlyUsd!.base;
    return { name, aws: m("aws"), gcp: m("gcp"), azure: m("azure"), savingAwsToGcp: m("aws") - m("gcp") };
  };
  const noEgress = ResourceProfile.parse({ ...measuredFull, points: measuredFull.points.map((p) => ({ ...p, egressGBh: 0 })), storageGrowthGBPerRequest: 0 });
  return [
    row("서울 공개 가격, 송신 제외, GKE 크레딧 포함", { applyGkeCredit: true }, noEgress),
    row("서울 공개 가격, 송신 제외, 크레딧 제외", {}, noEgress),
    row("서울 공개 가격, 실측 송신 포함, 크레딧 제외", {}, measuredFull),
    row("같은 조건 + 노드 디스크 50GB", { nodeDiskGB: 50 }, measuredFull),
  ];
})();

// 계산 시간
const time = (f: () => unknown, n: number) => { const t0 = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - t0) / n; };
const timing = {
  teamEstimateCostMs: time(() => estimateCost({ ...teamReq, targets: [...teamReq.targets] }, teamCatalog), 20),
  adapterMs: time(() => estimateViaKross({ ...teamReq, targets: [...teamReq.targets] }, teamCatalog), 20),
  fullEstimateNoDrawsMs: time(() => estimate({ profile: measuredProfile, pricing, sizing: sizingInput, traffic: trafficMain, from: "aws", options: { fnMode: "regression", draws: 0, lambdaRange: [0, 8000] } }), 3),
  fullEstimate400DrawsMs: time(() => branch("t", { measured: measuredProfile }, {}, "regression"), 1),
};

const nodeAtPeak = (b: (typeof branches)[number]) => b.res.vendors.map((v) => ({ vendor: v.vendor, sku: v.nodeSku, peakNodes: v.peakNodes, avgNodes: v.avgNodes, db: v.dbSku }));

const results = {
  generatedFrom: { prices: files.map((f) => ({ vendor: f.vendor, fetchedAt: f.fetchedAt, sources: f.sources })), teamCommit: readFileSync(new URL("../vendor/team/COMMIT", import.meta.url), "utf8").trim(), cpuScale: CPU_SCALE },
  env: readFileSync(new URL("../data/measure/env.txt", import.meta.url), "utf8").trim().split("\n"),
  stages: rows,
  fitTable, fitFullTable, fitRel, fitRelFull, kneeRow, segments, growth: { target: growthTarget, write: growthWrite },
  profiles: Object.fromEntries(branches.map((b) => [b.name, b.profile])),
  branches: branches.map((b) => ({ name: b.name, rel: b.rel, source: b.res.source, best: b.res.best, vendors: b.res.vendors, decision: b.res.decision, evidence: b.res.evidence, crossovers: b.res.crossovers, envelope: b.res.envelope, gradients: b.res.gradients, warnings: b.res.warnings, nodes: nodeAtPeak(b) })),
  predictionErrors,
  curves: { grid, series: curves, cross, envelope, tildeEnvelope },
  gradients, onpremNoFloor,
  scenarios, paybackSweep, sensitivity,
  team: { demoRecheck, teamNow, kAdapter, teamWithNewPrices, teamMeasured, adapterWithPoc, droppedLines: dropped.map((d) => `${d.vendor}/${d.sku}`) },
  timing,
  pricing: parsedPricing,
};
writeFileSync(new URL("results.json", out), `${JSON.stringify(results, null, 1)}\n`);

// 콘솔 요약
const f2 = (x: number | null | undefined) => (x === null || x === undefined ? "-" : x.toFixed(2));
console.log("회귀 적합도 (라운드별 원자료)");
for (const [k, f] of Object.entries(fitTable)) console.log(`  ${k}: ${f.intercept.toFixed(4)} + ${f.slope.toExponential(3)} λ, R²=${f.r2.toFixed(4)}, RMSE=${f.rmse.toFixed(4)}, n=${f.n}`);
console.log(`  저장 증가 ${growthTarget.toExponential(3)} GB/요청`);
console.log("회귀 적합도 (전체 단계)");
for (const [k, f] of Object.entries(fitFullTable)) console.log(`  ${k}: ${f.intercept.toFixed(4)} + ${f.slope.toExponential(3)} λ, R²=${f.r2.toFixed(4)}, RMSE=${f.rmse.toFixed(4)}, n=${f.n}`);
console.log("무릎", JSON.stringify(kneeRow));
for (const b of branches) {
  console.log(`\n${b.name}: 추천 ${b.res.best}`);
  for (const v of b.res.vendors) console.log(`  ${v.vendor}: 월 $${f2(v.monthlyUsd?.base)} [${f2(v.monthlyUsd?.low)}, ${f2(v.monthlyUsd?.high)}], 노드 ${v.nodeSku} 평균 ${v.avgNodes}대(최대 ${v.peakNodes}), DB ${v.dbSku}, P(최저) ${v.probBest.toFixed(2)}, 송신 $${f2(v.parts.egress + v.egressTierAdjustUsd)}`);
  const d = b.res.decision!;
  console.log(`  판단: ${d.verdict} (${d.reason}) → ${d.to}, 절감 ${f2(d.monthlySavingUsd?.base)} [${f2(d.monthlySavingUsd?.low)}, ${f2(d.monthlySavingUsd?.high)}], 일회성 ${f2(d.oneTimeUsd)}, 회수 ${f2(d.paybackMonths)}개월`);
}
console.log("\n역전점 (실측 갈래, 0~8000 req/s)");
const fmt = (c: (typeof cross.actual)[number]) => `${c.a}-${c.b} λ=${c.lambda.toFixed(1)} ${c.kind} ${c.before}→${c.after}`;
console.log(`  실제 C ${cross.actual.length}개: ${cross.actual.slice(0, 30).map(fmt).join("; ")}`);
console.log(`  근사 C̃ ${cross.approx.length}개: ${cross.approx.map(fmt).join("; ")}`);
console.log(`  최저 구간 C: ${envelope.map((e) => `${e.vendor}[${e.fromLambda.toFixed(0)}~${e.toLambda.toFixed(0)}]`).join(" ")}`);
console.log(`  최저 구간 C̃: ${tildeEnvelope.map((e) => `${e.vendor}[${e.fromLambda.toFixed(0)}~${e.toLambda.toFixed(0)}]`).join(" ")}`);
console.log("\n사례");
for (const s of scenarios) { const d = s.decision!; console.log(`  ${s.name}: ${d.verdict}/${d.reason} → ${d.to}, 절감 ${f2(d.monthlySavingUsd?.base)} [${f2(d.monthlySavingUsd?.low)},${f2(d.monthlySavingUsd?.high)}], 일회성 ${f2(d.oneTimeUsd)}, 회수 ${f2(d.paybackMonths)} | ${VENDORS.map((v) => `${v} ${f2(s.monthly[v]?.base)}`).join(" ")}`); }
console.log("\n예측 오차 (평균 절대 백분율)");
for (const p of predictionErrors) {
  const pts = p.points.filter((x) => x.lambda <= 400);
  const ape = (f: (typeof fieldsForErr)[number]) => mean(pts.map((x) => x.fields[f]!.ape ?? 0));
  const costApe = mean(pts.flatMap((x) => Object.values(x.cost).map((c) => c.ape)));
  console.log(`  ${p.name}: cpu ${(ape("cpu") * 100).toFixed(1)}% mem ${(ape("memGiB") * 100).toFixed(1)}% egress ${(ape("egressGBh") * 100).toFixed(1)}% dbCpu ${(ape("dbCpu") * 100).toFixed(1)}% | 시간당 비용 ${(costApe * 100).toFixed(1)}%`);
}
console.log("\n회수 기간 훑기");
for (const r of paybackSweep) console.log(`  ${r.from} 피크 ${r.peak}: ${r.verdict}/${r.reason} → ${r.to} 절감 ${f2(r.saving?.base)} [${f2(r.saving?.low)},${f2(r.saving?.high)}] 일회성 ${f2(r.oneTime)} 회수 ${f2(r.payback)}`);
console.log("\n민감도 (AWS, 피크 1000)");
for (const s of sensitivity) console.log(`  ${s.name}: ${VENDORS.map((v) => `${v} ${f2(s.monthly[v])}`).join(" ")} → 최저 ${s.best}, ${s.verdict}/${s.reason} ${s.to} 회수 ${f2(s.payback)}`);
console.log("\n팀 코드");
console.log(`  현재(10 rps): ${teamNow.envs.map((e) => `${e.provider} ${e.monthlyUsd}`).join(" ")} cheapest ${teamNow.cheapest}, bp ${JSON.stringify(teamNow.breakpoints)}`);
console.log(`  어댑터(10 rps): ${kAdapter.envs.map((e) => `${e.provider} ${e.monthlyUsd}`).join(" ")} cheapest ${kAdapter.cheapest}`);
for (const r of demoRecheck) console.log(`  재계산 10 rps [${r.name}]: aws ${f2(r.aws)} gcp ${f2(r.gcp)} azure ${f2(r.azure)} AWS→GCP 절감 ${f2(r.savingAwsToGcp)}`);
console.log(`  팀 계산 + POC 가격(10 rps): ${teamWithNewPrices.envs.map((e) => `${e.provider} ${e.monthlyUsd} ${e.nodeSku}`).join(" ")}, 뺀 줄 ${dropped.length}`);
console.log(`  어댑터 + POC 가격 + 실측(${PEAK} rps): ${adapterWithPoc.envs.map((e) => `${e.provider} ${e.monthlyUsd} ${e.nodeSku}x${e.nodes} db ${e.parts.db} eg-in-fixed ${e.parts.fixed}`).join(" | ")}`);
console.log("\n계산 시간 ms", JSON.stringify(timing));
