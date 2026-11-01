import { PriceSourceNotConfigured } from "../adapters/types.js";
import { moneyToUsd } from "../adapters/gcp-billing-catalog.js";
import type { PriceRowInput } from "../schema.js";
import { type DetailedPriceSource, type FetchResult, type SourceRef, toPriceSource } from "./types.js";

// GCP Cloud Billing Catalog API.
// 【사실】 API 키(또는 OAuth)가 있어야 부를 수 있다. 10/31 이 컨테이너에서 키 없이 부르면
//   403 "Method doesn't allow unregistered callers" 응답.
// 키는 환경 변수 GCP_BILLING_API_KEY에서만 읽는다. 캐시 파일·로그에 남기는 url에는 키를 빼고 적는다.
export const GCP_BILLING_BASE = "https://cloudbilling.googleapis.com/v1";
export const GCP_SERVICES = {
  compute: "6F81-5844-456A",   // Compute Engine 【사실】 공개 서비스 ID
  gke: "CCD8-9BF1-090E",       // Kubernetes Engine 【사실】
  cloudsql: "9662-B51E-5089",  // Cloud SQL 【사실】
} as const;
type Svc = keyof typeof GCP_SERVICES;

type GcpSku = {
  skuId: string; description: string;
  category: { resourceFamily: string; resourceGroup: string; usageType: string };
  serviceRegions: string[];
  pricingInfo: { pricingExpression: {
    usageUnit: string;
    tieredRates: { startUsageAmount: number; unitPrice: { currencyCode: string; units?: string; nanos?: number } }[];
  } }[];
};
type GcpPage = { skus?: GcpSku[]; nextPageToken?: string };

// 한 페이지 받기. 테스트는 고정 응답을 넣는다.
export type GcpPageFetcher = (svc: Svc, pageToken: string | null) => Promise<GcpPage>;

export const httpGcpPages = (apiKey: string): GcpPageFetcher => async (svc, token) => {
  const u = new URL(`${GCP_BILLING_BASE}/services/${GCP_SERVICES[svc]}/skus`);
  u.searchParams.set("currencyCode", "USD");
  u.searchParams.set("pageSize", "5000");
  if (token) u.searchParams.set("pageToken", token);
  u.searchParams.set("key", apiKey);
  const res = await fetch(u, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP_${res.status} cloudbilling ${svc}`);
  return (await res.json()) as GcpPage;
};

// 단가 부품 하나 (예: E2 vCPU 1시간). 노드·DB 가격은 부품을 더해서 만든다.
type Part = { key: string; svc: Svc; unit: string; match: RegExp };
export const GCP_PARTS: Part[] = [
  { key: "e2-core", svc: "compute", unit: "h", match: /^E2 Instance Core running in /i },
  { key: "e2-ram", svc: "compute", unit: "GiBy.h", match: /^E2 Instance Ram running in /i },
  { key: "gke-zonal", svc: "gke", unit: "h", match: /^Zonal Kubernetes Clusters/i },
  { key: "sql-pg-cpu", svc: "cloudsql", unit: "h", match: /^Cloud SQL for PostgreSQL: Zonal - vCPU in /i },
  { key: "sql-pg-ram", svc: "cloudsql", unit: "GiBy.h", match: /^Cloud SQL for PostgreSQL: Zonal - RAM in /i },
  { key: "sql-ssd", svc: "cloudsql", unit: "GiBy.mo", match: /^Cloud SQL for PostgreSQL: Zonal - Standard storage in /i },
];

// 부품 -> 우리 가격 줄. 【추정】 E2 공유 코어(e2-medium)는 vCPU 2개로 보이지만 vCPU 1개 값으로 청구된다
// (us-central1 공개 단가 core 0.021811 + ram 4 x 0.002923 = 0.0335 = e2-medium 공개가와 같음).
// 이 규칙으로 기존 TODO(human) "E2 core+ram 합산 규칙"을 정한다. 키가 생기면 서울 값으로 한 번 더 확인.
export const GCP_COMPOSE = [
  { item: "node", sku: "e2-medium", attrs: { vcpu: 2, memGiB: 4 }, unit: "hour", sum: { "e2-core": 1, "e2-ram": 4 } },
  { item: "node", sku: "e2-standard-2", attrs: { vcpu: 2, memGiB: 8 }, unit: "hour", sum: { "e2-core": 2, "e2-ram": 8 } },
  { item: "node", sku: "e2-standard-4", attrs: { vcpu: 4, memGiB: 16 }, unit: "hour", sum: { "e2-core": 4, "e2-ram": 16 } },
  { item: "cluster", sku: "gke-management", attrs: {}, unit: "hour", sum: { "gke-zonal": 1 } },
  { item: "db", sku: "cloudsql-pg-2vcpu-4gb", attrs: {}, unit: "hour", sum: { "sql-pg-cpu": 2, "sql-pg-ram": 4 } },
  { item: "storage", sku: "cloudsql-ssd", attrs: {}, unit: "gb_month", sum: { "sql-ssd": 1 } },
] as const satisfies readonly {
  item: PriceRowInput["item"]; sku: string; attrs: PriceRowInput["attrs"];
  unit: PriceRowInput["unit"]; sum: Record<string, number>;
}[];

// 순수 함수: 서비스별 SKU 목록 -> 부품 단가 (계단이 있으면 가장 마지막 유료 계단을 쓴다)
export function pickGcpParts(skus: { svc: Svc; sku: GcpSku }[], region: string) {
  const parts = new Map<string, { usd: number; skuId: string }>();
  for (const { svc, sku } of skus) {
    if (sku.category.usageType !== "OnDemand") continue;
    if (!sku.serviceRegions.includes(region) && !sku.serviceRegions.includes("global")) continue;
    const part = GCP_PARTS.find((p) => p.svc === svc && p.match.test(sku.description));
    const expr = sku.pricingInfo[0]?.pricingExpression;
    if (!part || !expr || expr.usageUnit !== part.unit || parts.has(part.key)) continue;
    const paid = expr.tieredRates.filter((t) => t.unitPrice.currencyCode === "USD");
    const last = paid[paid.length - 1];
    if (last) parts.set(part.key, { usd: moneyToUsd(last.unitPrice), skuId: sku.skuId });
  }
  return parts;
}

export function composeGcpRows(
  parts: Map<string, { usd: number; skuId: string }>, region: string, fetchedAt: string,
): { rows: PriceRowInput[]; missing: string[] } {
  const rows: PriceRowInput[] = [];
  const missing: string[] = [];
  for (const c of GCP_COMPOSE) {
    const keys = Object.keys(c.sum) as (keyof typeof c.sum)[];
    if (keys.some((k) => !parts.has(k))) { missing.push(`${c.item}/${c.sku}`); continue; }
    const usd = keys.reduce((s, k) => s + parts.get(k)!.usd * (c.sum[k] as number), 0);
    rows.push({
      vendor: "gcp", region, item: c.item, sku: c.sku, unit: c.unit,
      usd: Math.round(usd * 1e6) / 1e6, attrs: { ...c.attrs },
      evidence: "fact",
      source: `GCP Cloud Billing Catalog ${keys.map((k) => `${k}=${parts.get(k)!.skuId}x${c.sum[k]}`).join("+")}`,
      fetchedAt,
    });
  }
  return { rows, missing };
}

export function createGcpCatalogSource(
  opts: { apiKey?: string | undefined; fetchPage?: GcpPageFetcher } = {},
): DetailedPriceSource {
  return toPriceSource({
    vendor: "gcp",
    async fetchDetailed(region, now): Promise<FetchResult> {
      const key = opts.apiKey ?? process.env["GCP_BILLING_API_KEY"];
      const fetchPage = opts.fetchPage ?? (key ? httpGcpPages(key) : null);
      if (!fetchPage) throw new PriceSourceNotConfigured("GCP_BILLING_API_KEY 없음 → 캐시 사용");
      const all: { svc: Svc; sku: GcpSku }[] = [];
      const sources: SourceRef[] = [];
      for (const svc of Object.keys(GCP_SERVICES) as Svc[]) {
        let token: string | null = null;
        do {
          const page: GcpPage = await fetchPage(svc, token);
          for (const sku of page.skus ?? []) all.push({ svc, sku });
          token = page.nextPageToken || null;
        } while (token);
        sources.push({ url: `${GCP_BILLING_BASE}/services/${GCP_SERVICES[svc]}/skus?currencyCode=USD` });
      }
      const { rows, missing } = composeGcpRows(pickGcpParts(all, region), region, now.toISOString());
      return { rows, sources, missing };
    },
  });
}
