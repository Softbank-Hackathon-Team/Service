import type { PriceRowInput } from "../schema.js";
import { type PageFetcher, type PriceSource, type SkuRule, stubFetcher } from "./types.js";

// AWS Price List Query API (GetProducts) 응답 모양.
// 【사실】 PriceList는 JSON 문자열 배열, 엔드포인트는 us-east-1/eu-central-1/ap-south-1뿐,
// 한 페이지 최대 100건 (AWS Billing 문서, GetProducts API 문서).
type AwsProduct = {
  product: { sku: string; attributes: Record<string, string> };
  terms: { OnDemand?: Record<string, {
    priceDimensions: Record<string, {
      unit: string; beginRange?: string; pricePerUnit: { USD?: string };
    }>;
  }> };
};
type AwsPage = { PriceList: string[]; NextToken?: string };

const UNIT: Record<string, PriceRowInput["unit"]> = {
  Hrs: "hour", hours: "hour", "GB-Mo": "gb_month", Mo: "month",
};

// 순수 함수: 응답 한 페이지 -> 가격 줄
export function parseAwsPage(
  page: AwsPage, rules: SkuRule[], region: string, fetchedAt: string,
): PriceRowInput[] {
  const out: PriceRowInput[] = [];
  for (const s of page.PriceList) {
    const p = JSON.parse(s) as AwsProduct;
    const rule = rules.find((r) => r.match(p.product.attributes));
    if (!rule) continue;
    for (const term of Object.values(p.terms.OnDemand ?? {})) {
      for (const d of Object.values(term.priceDimensions)) {
        const usd = Number(d.pricePerUnit.USD);
        const unit = UNIT[d.unit];
        if (!Number.isFinite(usd) || !unit) continue;
        out.push({
          vendor: "aws", region, item: rule.item, sku: rule.sku, unit, usd,
          tierFrom: Number(d.beginRange ?? 0), attrs: rule.attrs ?? {},
          evidence: "fact", source: `aws-pricing GetProducts ${p.product.sku}`, fetchedAt,
        });
      }
    }
  }
  return out;
}

// DRAFT(ai): 서울 리전 이름은 GetProducts에서 attributes.regionCode로 거른다.
export const AWS_SEOUL_RULES: SkuRule[] = [
  { item: "node", sku: "t3.medium", attrs: { vcpu: 2, memGiB: 4 },
    match: (a) => a["instanceType"] === "t3.medium" && a["operatingSystem"] === "Linux"
      && a["tenancy"] === "Shared" && a["preInstalledSw"] === "NA" && a["capacitystatus"] === "Used" },
  { item: "cluster", sku: "eks-standard",
    match: (a) => a["servicecode"] === "AmazonEKS" && (a["usagetype"] ?? "").endsWith("AmazonEKS-Hours:perCluster") },
  { item: "db", sku: "rds-pg-db.t3.medium",
    match: (a) => a["instanceType"] === "db.t3.medium" && a["databaseEngine"] === "PostgreSQL"
      && a["deploymentOption"] === "Single-AZ" },
  { item: "storage", sku: "rds-gp3",
    match: (a) => a["servicecode"] === "AmazonRDS" && a["volumeApiName"] === "gp3"
      && a["deploymentOption"] === "Single-AZ" },
];

export function createAwsPriceSource(
  opts: { fetchPage?: PageFetcher; rules?: SkuRule[] } = {},
): PriceSource {
  const fetchPage = opts.fetchPage ?? stubFetcher("aws-price-list");
  const rules = opts.rules ?? AWS_SEOUL_RULES;
  return {
    vendor: "aws",
    async fetchRows(region, now) {
      const rows: PriceRowInput[] = [];
      let token: string | null = null;
      do {
        const page = (await fetchPage(token)) as AwsPage;
        rows.push(...parseAwsPage(page, rules, region, now.toISOString()));
        token = page.NextToken ?? null;
      } while (token);
      return rows;
    },
  };
}
