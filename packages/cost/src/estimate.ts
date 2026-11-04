import type { AppSpecV2, Provider } from "@svc/contracts";
import { HOURS_PER_MONTH, isStale, rowsFor, tieredCost } from "./catalog.js";
import { costShapeOf, nodesFor, requiredMemGiB, requiredVcpu, mauToRps } from "./load.js";
import { PROFILES, SECURITY_OPTIONS } from "./profile.js";
import {
  CostEstimateRequest, type CostEstimateRequestInput, type Breakpoint, type CostEstimate,
  type CostParts, type EnvEstimate, type LoadParams, type PriceCatalog, type PriceRow,
  type Recommendation,
  type SecurityProfileName,
} from "./schema.js";

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
// 단위를 보고 월 금액으로. 실제 가격 API는 DB도 시간당으로 준다 (AWS RDS, GCP Cloud SQL)
export const monthly = (r: PriceRow) => (r.unit === "hour" ? r.usd * HOURS_PER_MONTH : r.usd);
const sumParts = (p: CostParts) => p.cluster + p.nodes + p.db + p.storage + p.fixed;

// 계산용 내부 모양: 불가능한 안은 Infinity (밖으로 낼 때 null)
export type EnvCalc = Omit<EnvEstimate, "monthlyUsd" | "monthlyUsdNoCredit"> & {
  monthlyUsd: number; monthlyUsdNoCredit: number;
};

type EnvCtx = {
  catalog: PriceCatalog; region: string; spec: AppSpecV2; load: LoadParams;
  applyCredits: boolean; nodeSkus?: string[] | undefined;
};

// 환경 하나에서 노드 종류를 전부 계산해 가장 싼 안을 고른다 (전수 탐색).
export function estimateEnv(provider: Provider, rps: number, c: EnvCtx): EnvCalc {
  const unknown: string[] = [];
  const unverified = new Set<string>();
  const pick = (item: Parameters<typeof rowsFor>[3]) => rowsFor(c.catalog, provider, c.region, item);
  // 실제로 쓴 줄의 근거만 본다 (안 고른 노드 종류가 추정값이어도 배지를 달지 않는다)
  const used = (r: PriceRow | undefined) => {
    if (r && r.evidence !== "fact") unverified.add(r.item);
    return r;
  };

  let nodeRows = pick("node").filter((r) => r.attrs.vcpu && r.attrs.memGiB);
  if (c.nodeSkus) nodeRows = nodeRows.filter((r) => c.nodeSkus!.includes(r.sku));
  const empty: CostParts = { cluster: 0, nodes: 0, db: 0, storage: 0, fixed: 0 };
  if (nodeRows.length === 0) {
    return {
      provider, feasible: false, reason: "PRICE_MISSING", nodeSku: null, nodes: 0,
      monthlyUsd: Infinity, monthlyUsdNoCredit: Infinity, creditUsd: 0, parts: empty,
      unknown: ["node"], unverified: [], candidatesEvaluated: 0,
    };
  }

  const needVcpu = requiredVcpu(c.spec, rps, c.load);
  const needMem = requiredMemGiB(c.spec);
  const fixedRow = pick("fixed")[0];
  const capVcpu = fixedRow?.attrs.capVcpu;

  // 노드 외 덩어리는 노드 종류와 무관하다
  const base: Omit<CostParts, "nodes"> = { cluster: 0, db: 0, storage: 0, fixed: 0 };
  let credit = 0;
  if (provider === "onprem") {
    // 온프레: 고정비에 클러스터·DB(CloudNativePG)·스토리지가 다 들어 있다 【추정】
    if (used(fixedRow)) base.fixed = fixedRow!.usd; else unknown.push("fixed");
  } else {
    const cl = used(pick("cluster")[0]);
    if (cl) base.cluster = monthly(cl); else unknown.push("cluster");
    const cr = used(pick("cluster_credit")[0]);
    if (cr) credit = Math.min(cr.usd, base.cluster);
    const database = costShapeOf(c.spec).database;
    if (database) {
      const db = used(pick("db")[0]);
      if (db) base.db = monthly(db); else unknown.push("db");
      const st = pick("storage");
      if (st.length) { st.forEach(used); base.storage = tieredCost(st, database.storageGb); }
      else unknown.push("storage");
    }
  }

  let best: { row: PriceRow; nodes: number; nodeCost: number } | null = null;
  let evaluated = 0;
  for (const r of nodeRows) {
    evaluated++;
    const node = { vcpu: r.attrs.vcpu!, memGiB: r.attrs.memGiB! };
    const n = nodesFor(needVcpu, needMem, node, c.load);
    if (n > c.load.maxNodes) continue;
    if (capVcpu !== undefined && n * node.vcpu > capVcpu) continue; // 서버 증설 필요
    const nodeCost = n * r.usd * HOURS_PER_MONTH;
    if (!best || nodeCost < best.nodeCost) best = { row: r, nodes: n, nodeCost };
  }
  if (!best) {
    return {
      provider, feasible: false,
      reason: capVcpu !== undefined ? "ONPREM_CAPACITY_EXCEEDED" : "NODE_LIMIT_EXCEEDED",
      nodeSku: null, nodes: 0, monthlyUsd: Infinity, monthlyUsdNoCredit: Infinity, creditUsd: 0,
      parts: empty, unknown, unverified: [...unverified], candidatesEvaluated: evaluated,
    };
  }
  used(best.row);
  const parts: CostParts = { ...base, nodes: best.nodeCost };
  const noCredit = sumParts(parts);
  const applied = c.applyCredits ? credit : 0;
  return {
    provider, feasible: true, nodeSku: best.row.sku, nodes: best.nodes,
    monthlyUsd: noCredit - applied, monthlyUsdNoCredit: noCredit, creditUsd: applied,
    parts: { ...parts, cluster: parts.cluster - applied },
    unknown, unverified: [...unverified].sort(), candidatesEvaluated: evaluated,
  };
}

export function cheapestOf(envs: EnvCalc[]): EnvCalc | null {
  const ok = envs.filter((e) => e.feasible);
  if (ok.length === 0) return null;
  return ok.reduce((a, b) => (b.monthlyUsd < a.monthlyUsd ? b : a));
}

// 보안 단계까지 곱한 후보를 세 점수 가중합으로 줄 세운다 (PoC recommend()).
export function recommend(envs: EnvCalc[], profile: SecurityProfileName): Recommendation[] {
  const w = PROFILES[profile];
  const cands = envs.filter((e) => e.feasible).flatMap((e) =>
    SECURITY_OPTIONS.map((s) => ({
      provider: e.provider, security: s.level,
      cost: e.monthlyUsd + s.extraMonthly({ db: e.parts.db }),
      sec: s.securityScore, time: s.timeFactor,
    })));
  if (cands.length === 0) return [];
  const maxC = Math.max(...cands.map((x) => x.cost)) || 1;
  const maxT = Math.max(...cands.map((x) => x.time));
  return cands
    .map((x) => {
      const sp = { cost: w.cost * x.cost / maxC, risk: w.risk * (1 - x.sec), time: w.time * x.time / maxT };
      return { ...x, score: round(sp.cost + sp.risk + sp.time, 3), sp };
    })
    .sort((a, b) => a.score - b.score)
    .map((x, i) => ({
      rank: i + 1, provider: x.provider, security: x.security, monthlyUsd: round(x.cost, 1),
      score: x.score,
      scoreParts: { cost: round(x.sp.cost, 3), risk: round(x.sp.risk, 3), time: round(x.sp.time, 3) },
    }));
}

// 트래픽을 step씩 올리며 최저 환경이 바뀌는 지점 (설계 초안 6장). 크레딧 없이 본다.
export function findBreakpoints(
  ctx: EnvCtx, targets: Provider[], maxRps = 2000, step = 1,
): Breakpoint[] {
  const out: Breakpoint[] = [];
  let prev: Provider | null = null;
  const c = { ...ctx, applyCredits: false };
  for (let rps = 0; rps <= maxRps; rps += step) {
    const best = cheapestOf(targets.map((t) => estimateEnv(t, rps, c)));
    if (best && best.provider !== prev) {
      out.push({ fromRps: rps, cheapest: best.provider, nodes: best.nodes });
      prev = best.provider;
    }
  }
  return out;
}

// 공개 진입점: 명세 + 가정 -> 환경별 월 비용과 추천.
export function estimateCost(
  input: CostEstimateRequestInput, catalog: PriceCatalog,
  opts: { now?: Date; breakpoints?: { maxRps: number; step: number } | false } = {},
): CostEstimate {
  const req = CostEstimateRequest.parse(input);
  const peakRps = "peakRps" in req.traffic ? req.traffic.peakRps : mauToRps(req.traffic);
  const ctx: EnvCtx = {
    catalog, region: req.region, spec: req.spec, load: req.load,
    applyCredits: req.applyCredits, nodeSkus: req.nodeSkus,
  };
  const targets = [...new Set(req.from ? [req.from, ...req.targets] : req.targets)];
  const envs = targets.map((t) => estimateEnv(t, peakRps, ctx));
  const best = cheapestOf(envs.filter((e) => req.targets.includes(e.provider)));

  let savings: CostEstimate["savings"] = null;
  const cur = req.from ? envs.find((e) => e.provider === req.from) : undefined;
  if (cur?.feasible && best && best.provider !== cur.provider) {
    savings = {
      from: cur.provider, to: best.provider,
      monthlyUsd: round(cur.monthlyUsd - best.monthlyUsd, 1),
      creditPortionUsd: round(best.creditUsd - cur.creditUsd, 1),
    };
  }

  const bp = opts.breakpoints ?? { maxRps: 2000, step: 1 };
  const outEnvs = envs.map((e) => ({
    ...e,
    monthlyUsd: Number.isFinite(e.monthlyUsd) ? round(e.monthlyUsd, 1) : null,
    monthlyUsdNoCredit: Number.isFinite(e.monthlyUsdNoCredit) ? round(e.monthlyUsdNoCredit, 1) : null,
    creditUsd: round(e.creditUsd, 1),
    parts: Object.fromEntries(Object.entries(e.parts).map(([k, v]) => [k, round(v, 1)])) as CostParts,
  }));

  return {
    priceAsOf: catalog.asOf,
    priceStale: isStale(catalog, opts.now ?? new Date()),
    peakRps: round(peakRps, 1),
    requiredVcpu: round(requiredVcpu(req.spec, peakRps, req.load), 2),
    load: req.load,
    profile: req.profile,
    envs: outEnvs,
    cheapest: best?.provider ?? null,
    savings,
    recommendations: recommend(envs.filter((e) => req.targets.includes(e.provider)), req.profile),
    breakpoints: bp ? findBreakpoints(ctx, req.targets, bp.maxRps, bp.step) : [],
  };
}
