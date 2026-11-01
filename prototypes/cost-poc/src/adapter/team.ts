import {
  type AppSpec, Breakpoint, CostEstimate, CostEstimateRequest, type CostEstimateRequestInput, type EnvEstimate,
  PriceCatalog, type PriceRowInput, type Provider,
} from "@svc/contracts";
import { type EnvCalc, cpuToVcpu, isStale, memToGiB, mauToRps, monthly, recommend, requiredMemGiB, requiredVcpu, rowsFor } from "@svc/cost";
import type { PriceFile, PriceLine } from "../collect/types.js";
import { HOURS_PER_MONTH } from "../core/cost.js";
import { cheapestEnvelope, curveActual } from "../core/crossover.js";
import { monthlyCost, type MonthlyResult } from "../core/monthly.js";
import { makeResourceFn, vendorResources } from "../core/resource.js";
import { hourlyCost } from "../core/cost.js";
import { ResourceProfile, Sizing, type ResourceProfileInput, VendorPricing, type VendorId, type VendorPricingInput } from "../core/types.js";

// DRAFT(ai): 팀 코드(@svc/contracts, @svc/cost)와의 얇은 어댑터. 팀 코드는 수정하지 않는다.
//   입력: CostEstimateRequest + PriceCatalog → POC 입력
//   출력: POC 결과 → CostEstimate (팀 스키마 parse 통과)
// 이 파일이 지금 계약의 빈칸을 어떻게 메우는지는 report.md "필요한 변경"에 있다.

export const toVendor = (p: Provider): VendorId => (p === "azure_mock" ? "azure" : p);
export const toProvider = (v: VendorId): Provider => (v === "azure" ? "azure_mock" : v);

// PriceCatalog → VendorPricing. 송신 단가는 PriceItem에 칸이 없어 0이고 unknownItems에 적는다.
export function catalogToPricing(
  catalog: PriceCatalog, region: string, providers: Provider[],
  load: { minNodes: number; maxNodes: number }, opts: { nodeSkus?: string[] | undefined; applyCredits?: boolean; egressPerGB?: Partial<Record<VendorId, number>> } = {},
): VendorPricingInput[] {
  return providers.map((prov) => {
    const pick = (item: Parameters<typeof rowsFor>[3]) => rowsFor(catalog, prov, region, item);
    let nodes = pick("node").filter((r) => r.attrs.vcpu && r.attrs.memGiB);
    if (opts.nodeSkus) nodes = nodes.filter((r) => opts.nodeSkus!.includes(r.sku));
    const fixedRow = pick("fixed")[0];
    const cluster = pick("cluster")[0];
    const db = pick("db")[0];
    const storage = pick("storage").sort((a, b) => a.tierFrom - b.tierFrom)[0];
    const credit = pick("cluster_credit")[0];
    const isPrem = prov === "onprem";
    const unknownItems: string[] = [];
    const eg = opts.egressPerGB?.[toVendor(prov)];
    if (eg === undefined) unknownItems.push("egress");
    if (!isPrem && !db) unknownItems.push("db");
    const fixedHourly = isPrem ? (fixedRow ? monthly(fixedRow) / HOURS_PER_MONTH : 0) : cluster ? monthly(cluster) / HOURS_PER_MONTH : 0;
    return {
      vendor: toVendor(prov), region, residency: "KR", fixedHourly,
      monthlyCreditUsd: opts.applyCredits && credit ? credit.usd : 0,
      nodeTypes: nodes.length > 0
        ? nodes.map((r) => ({ sku: r.sku, hourly: r.usd, capacity: { cpu: r.attrs.vcpu!, mem: r.attrs.memGiB!, gpu: 0 } }))
        : [{ sku: "__missing__", hourly: 0, capacity: { cpu: 1, mem: 1, gpu: 0 } }],
      // 팀 코드는 DB 등급을 고르지 않고 첫 줄을 쓴다. 호환을 위해 같은 줄 하나만, 용량 제한 없이 둔다
      dbClasses: db ? [{ sku: db.sku, hourly: monthly(db) / HOURS_PER_MONTH, capacity: { cpu: 1e9, mem: 1e9 } }] : [],
      dbOnNodes: isPrem,
      dbReplicasOnNodes: 1,
      storagePerGBMonth: isPrem ? 0 : storage?.usd ?? 0,
      egressPerGB: eg ?? 0,
      minNodes: load.minNodes,
      maxNodes: load.maxNodes,
      ...(fixedRow?.attrs.capVcpu ? { capVcpuTotal: fixedRow.attrs.capVcpu } : {}),
      unknownItems,
      evidence: {},
    };
  });
}

// 갈래 1(price-only): 요청의 LoadParams와 AppSpec으로 프로필을 만든다
export function profileFromRequest(req: CostEstimateRequest, maxLambda = 2000): ResourceProfile {
  const load = req.load;
  const mem = requiredMemGiB(req.spec);
  const floor = req.spec.service.replicas * cpuToVcpu(req.spec.service.cpu);
  const storage = req.spec.database?.storageGb ?? 0;
  const knots = new Set<number>([0, maxLambda]);
  if (load.vcpuPerRps > 0 && floor > load.baseVcpu) knots.add((floor - load.baseVcpu) / load.vcpuPerRps);
  const lambdas = [...knots].filter((l) => l >= 0).sort((a, b) => a - b);
  return ResourceProfile.parse({
    source: load.source === "measured" ? "measured" : "price-only",
    points: lambdas.map((lambda) => ({
      lambda, cpu: requiredVcpu(req.spec, lambda, load), memGiB: mem, egressGBh: 0, storageGB: storage,
    })),
    note: "팀 CostEstimateRequest의 LoadParams와 AppSpec에서 만든 프로필 (송신량 없음)",
  });
}

export const peakRpsOf = (req: CostEstimateRequest) => ("peakRps" in req.traffic ? req.traffic.peakRps : mauToRps(req.traffic));

const r1 = (x: number) => Math.round(x * 10) / 10;

function toEnv(p: VendorPricing, m: MonthlyResult, prov: Provider, candidates: number, unverified: string[]): EnvEstimate {
  if (!m.feasible) {
    return { provider: prov, feasible: false, reason: m.reason ?? "INFEASIBLE", nodeSku: null, nodes: 0, monthlyUsd: null, monthlyUsdNoCredit: null,
      creditUsd: 0, parts: { cluster: 0, nodes: 0, db: 0, storage: 0, fixed: 0 }, unknown: [...p.unknownItems], unverified, candidatesEvaluated: candidates };
  }
  const isPrem = prov === "onprem";
  const fixedPart = m.parts.fixed;
  const egressNet = m.parts.egress + m.egressTierAdjustUsd;
  // parts에 송신 칸이 없다: 합계가 맞도록 fixed에 넣고 unverified에 표시한다
  const parts = {
    cluster: r1(isPrem ? 0 : fixedPart - m.creditUsd), nodes: r1(m.parts.nodes), db: r1(m.parts.db), storage: r1(m.parts.storage),
    fixed: r1((isPrem ? fixedPart : 0) + egressNet),
  };
  return {
    provider: prov, feasible: true, nodeSku: m.nodeSku, nodes: m.peakNodes,
    monthlyUsd: r1(m.totalUsd), monthlyUsdNoCredit: r1(m.totalUsd + m.creditUsd), creditUsd: r1(m.creditUsd), parts,
    unknown: [...p.unknownItems], unverified: egressNet > 0 ? [...unverified, "egress-in-parts.fixed"] : unverified, candidatesEvaluated: candidates,
  };
}

export type ViaKrossOptions = {
  now?: Date;
  profile?: ResourceProfileInput;
  pricing?: VendorPricingInput[];
  sizing?: Parameters<typeof Sizing.parse>[0];
  breakpoints?: { maxRps: number } | false;
};

// POST /cost/estimate와 같은 시그니처: 같은 입력을 받아 같은 모양을 낸다
export function estimateViaKross(input: CostEstimateRequestInput, catalog: PriceCatalog, o: ViaKrossOptions = {}): CostEstimate {
  const req = CostEstimateRequest.parse(input);
  const peak = peakRpsOf(req);
  const targets = [...new Set(req.from ? [req.from, ...req.targets] : req.targets)];
  const pricingAll = (o.pricing ?? catalogToPricing(catalog, req.region, targets, req.load, { nodeSkus: req.nodeSkus, applyCredits: req.applyCredits }))
    .map((p) => VendorPricing.parse(p));
  const prof = o.profile ? ResourceProfile.parse(o.profile) : profileFromRequest(req, Math.max(2000, peak * 2));
  const fn = makeResourceFn(prof);
  const sizing = Sizing.parse(o.sizing ?? { targetUtil: req.load.utilTarget, dbTargetUtil: 1, hasDatabase: !!req.spec.database });
  // 팀 방식은 피크 고정: 일정 트래픽 적분과 같다
  const tr = { kind: "constant" as const, lambda: peak };
  const runs = targets.map((prov) => {
    const p = pricingAll.find((x) => x.vendor === toVendor(prov));
    if (!p) throw new Error(`PRICING_MISSING ${prov}`);
    const noNode = p.nodeTypes[0]?.sku === "__missing__";
    const m: MonthlyResult = noNode ? { ...monthlyCost(p, fn, sizing, tr), feasible: false, reason: "PRICE_MISSING" } : monthlyCost(p, fn, sizing, tr);
    return { prov, p, m, candidates: noNode ? 0 : p.nodeTypes.length };
  });
  // 화면의 미확인 배지: 실제로 쓴 줄 중 evidence가 fact가 아닌 항목 (팀 estimateEnv와 같은 규칙). POC 가격을 넘기면 evidence는 pricing 쪽에 있다
  const unverifiedOf = (prov: Provider, m: MonthlyResult): string[] => {
    if (o.pricing || m.reason === "PRICE_MISSING") return [];
    const out = new Set<string>();
    const mark = (r: { evidence: string; item: string } | undefined) => { if (r && r.evidence !== "fact") out.add(r.item); };
    const pick = (item: Parameters<typeof rowsFor>[3]) => rowsFor(catalog, prov, req.region, item);
    if (prov === "onprem") mark(pick("fixed")[0]);
    else {
      mark(pick("cluster")[0]); mark(pick("cluster_credit")[0]);
      if (req.spec.database) { mark(pick("db")[0]); pick("storage").forEach(mark); }
    }
    mark(pick("node").find((r) => r.sku === m.nodeSku));
    return [...out].sort();
  };
  const envs = runs.map(({ prov, p, m, candidates }) => toEnv(p, m, prov, candidates, unverifiedOf(prov, m)));

  const inTargets = envs.filter((e) => req.targets.includes(e.provider) && e.feasible);
  const best = inTargets.length === 0 ? null : inTargets.reduce((a, b) => ((b.monthlyUsd ?? Infinity) < (a.monthlyUsd ?? Infinity) ? b : a));
  const cur = req.from ? envs.find((e) => e.provider === req.from) : undefined;
  const rawTotal = (prov: Provider) => runs.find((r) => r.prov === prov)!.m.totalUsd;
  const rawCredit = (prov: Provider) => runs.find((r) => r.prov === prov)!.m.creditUsd;
  const savings = cur?.feasible && best && best.provider !== cur.provider ? {
    from: cur.provider, to: best.provider, monthlyUsd: r1(rawTotal(cur.provider) - rawTotal(best.provider)),
    creditPortionUsd: r1(rawCredit(best.provider) - rawCredit(cur.provider)),
  } : null;

  const recInput: EnvCalc[] = runs.filter((r) => req.targets.includes(r.prov)).map(({ prov, p, m, candidates }) => {
    const env = toEnv(p, m, prov, candidates, []);
    // recommend()는 반올림 전 parts.db를 쓴다
    return { ...env, parts: { ...env.parts, db: m.parts.db }, monthlyUsd: m.feasible ? m.totalUsd : Infinity, monthlyUsdNoCredit: m.feasible ? m.totalUsd + m.creditUsd : Infinity };
  });

  const bpOpt = o.breakpoints === undefined ? { maxRps: 2000 } : o.breakpoints;
  let breakpoints: Breakpoint[] = [];
  if (bpOpt) {
    const noCredit = runs.filter((r) => req.targets.includes(r.prov)).map((r) => ({ ...r.p, monthlyCreditUsd: 0 }));
    const curves = noCredit.map((p) => curveActual(p, fn, sizing, 0, bpOpt.maxRps));
    const env = cheapestEnvelope(curves, 0, bpOpt.maxRps, { extraPoints: fn.knots });
    breakpoints = env.filter((s) => s.vendor !== null).map((s, i) => {
      // 팀 형식은 정수 rps에서 새 최저가 시작되는 지점. 왼쪽 연속이라 경계값은 앞 구간에 속한다
      const fromRps = i === 0 ? 0 : Math.floor(s.fromLambda + 1e-6) + 1;
      const prov = toProvider(s.vendor!);
      const p = noCredit.find((x) => x.vendor === s.vendor)!;
      return { fromRps, cheapest: prov, nodes: hourlyCost(p, vendorResources(fn, p, sizing, fromRps)).nodes };
    });
  }

  return CostEstimate.parse({
    priceAsOf: catalog.asOf,
    priceStale: isStale(catalog, o.now ?? new Date()),
    peakRps: r1(peak),
    requiredVcpu: Math.round(requiredVcpu(req.spec, peak, req.load) * 100) / 100,
    load: req.load,
    profile: req.profile,
    envs,
    cheapest: best?.provider ?? null,
    savings,
    recommendations: recommend(recInput, req.profile),
    breakpoints,
  });
}

const EVIDENCE_MAP: Record<PriceLine["evidence"], PriceRowInput["evidence"]> = {
  public: "fact", "public-secondary": "unverified", assumed: "assumed",
};
const ITEM_MAP: Partial<Record<PriceLine["item"], PriceRowInput["item"]>> = {
  node: "node", db: "db", storage: "storage", cluster: "cluster", lb: "lb", disk: "volume",
};

// POC 가격 → 팀 PriceRow. 지금 계약으로 담을 수 없는 줄(송신)은 dropped로 돌려준다.
export function priceFilesToCatalog(files: PriceFile[], asOf: string): { catalog: PriceCatalog; dropped: PriceLine[] } {
  const rows: PriceRowInput[] = [];
  const dropped: PriceLine[] = [];
  for (const f of files) {
    for (const l of f.lines) {
      const item = ITEM_MAP[l.item];
      if (!item) { dropped.push(l); continue; }
      const onpremFixed = f.vendor === "onprem" && l.item === "cluster";
      rows.push({
        vendor: toProvider(f.vendor), region: l.region, item: onpremFixed ? "fixed" : item, sku: l.sku,
        unit: l.unit === "gb" ? "gb_month" : l.unit === "gb_month" ? "gb_month" : onpremFixed ? "hour" : "hour",
        usd: l.usd, tierFrom: 0,
        attrs: {
          ...(l.attrs?.vcpu ? { vcpu: l.attrs.vcpu } : {}), ...(l.attrs?.memGiB ? { memGiB: l.attrs.memGiB } : {}),
        },
        evidence: EVIDENCE_MAP[l.evidence], source: `${l.sourceDetail} (${l.sourceUrl})`, fetchedAt: l.fetchedAt,
      });
    }
  }
  return { catalog: PriceCatalog.parse({ asOf, rows }), dropped };
}

export const specMemFloor = (spec: AppSpec) => spec.service.replicas * memToGiB(spec.service.memory);
export const specCpuFloor = (spec: AppSpec) => spec.service.replicas * cpuToVcpu(spec.service.cpu);
