import type { PriceRowInput } from "../schema.js";
import { type PageFetcher, type PriceSource, type SkuRule, stubFetcher } from "./types.js";

// Azure Retail Prices API 응답 모양.
// 【사실】 인증 없음, $filter로 거름, 계단은 tierMinimumUnits (Microsoft Learn "Azure Retail Prices overview").
// Azure는 CLAUDE.md §0-1대로 모양과 Mock만 둔다. evidence는 항상 "mock".
type AzureItem = {
  currencyCode: string; retailPrice: number; tierMinimumUnits: number;
  armRegionName: string; serviceName: string; productName: string;
  skuName: string; meterName: string; unitOfMeasure: string; type: string;
};
type AzurePage = { Items: AzureItem[]; NextPageLink: string | null };

const UNIT: Record<string, PriceRowInput["unit"]> = {
  "1 Hour": "hour", "1 GB/Month": "gb_month", "1/Month": "month",
};

export function parseAzurePage(
  page: AzurePage, rules: SkuRule[], region: string, fetchedAt: string,
): PriceRowInput[] {
  const out: PriceRowInput[] = [];
  for (const it of page.Items) {
    if (it.armRegionName !== region || it.type !== "Consumption" || it.currencyCode !== "USD") continue;
    const rule = rules.find((r) => r.match({
      serviceName: it.serviceName, productName: it.productName,
      skuName: it.skuName, meterName: it.meterName,
    }));
    const unit = UNIT[it.unitOfMeasure];
    if (!rule || !unit) continue;
    out.push({
      vendor: "azure_mock", region, item: rule.item, sku: rule.sku, unit,
      usd: it.retailPrice, tierFrom: it.tierMinimumUnits, attrs: rule.attrs ?? {},
      evidence: "mock", source: `azure retail ${it.productName} ${it.skuName}`, fetchedAt,
    });
  }
  return out;
}

export const AZURE_KOREA_RULES: SkuRule[] = [
  { item: "node", sku: "Standard_B2s", attrs: { vcpu: 2, memGiB: 4 },
    match: (a) => a["serviceName"] === "Virtual Machines" && a["skuName"] === "B2s"
      && !/Windows/.test(a["productName"] ?? "") },
];

export function createAzurePriceSource(
  opts: { fetchPage?: PageFetcher; rules?: SkuRule[] } = {},
): PriceSource {
  const fetchPage = opts.fetchPage ?? stubFetcher("azure-retail-prices");
  const rules = opts.rules ?? AZURE_KOREA_RULES;
  return {
    vendor: "azure_mock",
    async fetchRows(region, now) {
      const rows: PriceRowInput[] = [];
      let link: string | null = null;
      do {
        const page = (await fetchPage(link)) as AzurePage;
        rows.push(...parseAzurePage(page, rules, region, now.toISOString()));
        link = page.NextPageLink;
      } while (link);
      return rows;
    },
  };
}
