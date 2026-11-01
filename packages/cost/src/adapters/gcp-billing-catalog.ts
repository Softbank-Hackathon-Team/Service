import type { PriceRowInput } from "../schema.js";
import { type PageFetcher, type PriceSource, type SkuRule, stubFetcher } from "./types.js";

// GCP Cloud Billing Catalog API (services/{id}/skus) 응답 모양.
// 【사실】 API 키로 호출, tieredRates에 계단 시작 사용량과 단가, 한 페이지 최대 5,000건
// (Google Cloud 문서 "Get Google Cloud pricing information").
type GcpMoney = { currencyCode: string; units?: string; nanos?: number };
type GcpSku = {
  skuId: string; description: string;
  category: { resourceFamily: string; resourceGroup: string; usageType: string };
  serviceRegions: string[];
  pricingInfo: { pricingExpression: {
    usageUnit: string;
    tieredRates: { startUsageAmount: number; unitPrice: GcpMoney }[];
  } }[];
};
type GcpPage = { skus: GcpSku[]; nextPageToken?: string };

const UNIT: Record<string, PriceRowInput["unit"]> = {
  h: "hour", "GiBy.mo": "gb_month", mo: "month",
};

export const moneyToUsd = (m: GcpMoney) => Number(m.units ?? 0) + (m.nanos ?? 0) / 1e9;

export function parseGcpPage(
  page: GcpPage, rules: SkuRule[], region: string, fetchedAt: string,
): PriceRowInput[] {
  const out: PriceRowInput[] = [];
  for (const s of page.skus) {
    if (!s.serviceRegions.includes(region)) continue;
    if (s.category.usageType !== "OnDemand") continue;
    const flat = {
      description: s.description, resourceFamily: s.category.resourceFamily,
      resourceGroup: s.category.resourceGroup,
    };
    const rule = rules.find((r) => r.match(flat));
    const expr = s.pricingInfo[0]?.pricingExpression;
    if (!rule || !expr) continue;
    const unit = UNIT[expr.usageUnit];
    if (!unit) continue;
    for (const t of expr.tieredRates) {
      if (t.unitPrice.currencyCode !== "USD") continue;
      out.push({
        vendor: "gcp", region, item: rule.item, sku: rule.sku, unit,
        usd: moneyToUsd(t.unitPrice), tierFrom: t.startUsageAmount, attrs: rule.attrs ?? {},
        evidence: "fact", source: `cloudbilling skus ${s.skuId}`, fetchedAt,
      });
    }
  }
  return out;
}

// DRAFT(ai): e2-medium은 SKU 하나가 아니라 "E2 Instance Core"+"E2 Instance Ram" 두 줄을 합쳐야 정확하다.
// 스켈레톤에선 미리 합친 SKU가 있다고 보고 description으로 고른다. TODO(human): 합산 규칙 확정.
export const GCP_SEOUL_RULES: SkuRule[] = [
  { item: "node", sku: "e2-medium", attrs: { vcpu: 2, memGiB: 4 },
    match: (a) => a["resourceFamily"] === "Compute" && /E2 Medium/i.test(a["description"] ?? "") },
  { item: "cluster", sku: "gke-management",
    match: (a) => /Kubernetes Clusters/i.test(a["description"] ?? "") },
  { item: "storage", sku: "cloudsql-ssd",
    match: (a) => /Cloud SQL.*SSD/i.test(a["description"] ?? "") },
];

export function createGcpPriceSource(
  opts: { fetchPage?: PageFetcher; rules?: SkuRule[] } = {},
): PriceSource {
  const fetchPage = opts.fetchPage ?? stubFetcher("gcp-billing-catalog");
  const rules = opts.rules ?? GCP_SEOUL_RULES;
  return {
    vendor: "gcp",
    async fetchRows(region, now) {
      const rows: PriceRowInput[] = [];
      let token: string | null = null;
      do {
        const page = (await fetchPage(token)) as GcpPage;
        rows.push(...parseGcpPage(page, rules, region, now.toISOString()));
        token = page.nextPageToken || null;
      } while (token);
      return rows;
    },
  };
}
