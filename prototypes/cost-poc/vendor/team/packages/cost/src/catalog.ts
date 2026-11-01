import { readFileSync } from "node:fs";
import type { Provider } from "@svc/contracts";
import { PriceCatalog, type PriceItem, type PriceRow } from "./schema.js";

export const HOURS_PER_MONTH = 730; // 24 x 365 / 12
export const STALE_AFTER_DAYS = 7;  // 설계 초안 11장

// DRAFT(ai): 요청 리전(AWS 이름) -> 벤더별 리전. 지금은 서울만.
const REGION_MAP: Record<string, Record<Provider, string>> = {
  "ap-northeast-2": {
    aws: "ap-northeast-2", gcp: "asia-northeast3",
    azure_mock: "koreacentral", onprem: "local",
  },
};

export function vendorRegion(vendor: Provider, region: string): string {
  return REGION_MAP[region]?.[vendor] ?? region;
}

// 네트워크 없이 쓰는 샘플 가격표. 테스트와 데모 기본값.
export function loadSampleCatalog(): PriceCatalog {
  const url = new URL("./data/sample-prices.json", import.meta.url);
  const raw = JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
  delete raw["_note"];
  return PriceCatalog.parse(raw);
}

export function rowsFor(
  catalog: PriceCatalog, vendor: Provider, region: string, item: PriceItem,
): PriceRow[] {
  const r = vendorRegion(vendor, region);
  return catalog.rows.filter(
    (x) => x.vendor === vendor && x.region === r && x.item === item);
}

// 계단식 가격: tierFrom 기준으로 구간마다 단가를 곱해 더한다.
export function tieredCost(rows: PriceRow[], qty: number): number {
  if (rows.length === 0 || qty <= 0) return 0;
  const tiers = [...rows].sort((a, b) => a.tierFrom - b.tierFrom);
  let total = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i]!;
    const start = t.tierFrom;
    const end = tiers[i + 1]?.tierFrom ?? Infinity;
    if (qty <= start) break;
    total += (Math.min(qty, end) - start) * t.usd;
  }
  return total;
}

export function isStale(catalog: PriceCatalog, now: Date): boolean {
  const age = now.getTime() - new Date(catalog.asOf).getTime();
  return age > STALE_AFTER_DAYS * 24 * 3600 * 1000;
}
