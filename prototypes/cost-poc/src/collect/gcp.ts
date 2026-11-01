import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { PriceFile, PriceLine } from "./types.js";

// DRAFT(ai): GCP는 키 없는 공식 API가 없다(Cloud Billing Catalog는 키 필요, 403 확인).
//   노드·디스크·NAT: Cyclenerd google-cloud-pricing-cost-calculator pricing.yml (공식 카탈로그에서 생성한 2차 자료, Apache-2.0)
//   Cloud SQL·송신·GKE: 공식 가격 페이지를 브라우저에서 서울로 선택해 옮겨 적은 표 (data/prices/gcp-official-transcript.json)
// 교차 확인: e2-standard-2 서울 0.08596572 = 공식 페이지 값과 일치.
const PRICING_YML = "https://raw.githubusercontent.com/Cyclenerd/google-cloud-pricing-cost-calculator/master/pricing.yml";
const REGION = "asia-northeast3";

// 매칭 규칙: x86, 온디맨드. 범용 1:4(e2-standard, n2-standard), 컴퓨트(e2-highcpu 1:1), 메모리(e2-highmem 1:8), 버스터블(e2-medium)
export const GCP_NODES: Record<string, { vcpu: number; memGiB: number; family: string; burstable?: boolean; sustainedVcpu?: number }> = {
  "e2-medium": { vcpu: 2, memGiB: 4, family: "burstable", burstable: true, sustainedVcpu: 1 },
  "e2-standard-2": { vcpu: 2, memGiB: 8, family: "general" }, "e2-standard-4": { vcpu: 4, memGiB: 16, family: "general" },
  "e2-standard-8": { vcpu: 8, memGiB: 32, family: "general" }, "e2-standard-16": { vcpu: 16, memGiB: 64, family: "general" },
  "e2-highcpu-2": { vcpu: 2, memGiB: 2, family: "compute" }, "e2-highcpu-4": { vcpu: 4, memGiB: 4, family: "compute" },
  "e2-highcpu-8": { vcpu: 8, memGiB: 8, family: "compute" }, "e2-highcpu-16": { vcpu: 16, memGiB: 16, family: "compute" },
  "e2-highmem-2": { vcpu: 2, memGiB: 16, family: "memory" }, "e2-highmem-4": { vcpu: 4, memGiB: 32, family: "memory" },
  "n2-standard-2": { vcpu: 2, memGiB: 8, family: "general-n2" }, "n2-standard-4": { vcpu: 4, memGiB: 16, family: "general-n2" },
  "n2-standard-8": { vcpu: 8, memGiB: 32, family: "general-n2" },
};

type Transcript = {
  capturedAt: string;
  method: string;
  cloudSql: { url: string; section: string; vcpuHourly: number; memGiBHourly: number; vcpuHourlyCud1y: number; memGiBHourlyCud1y: number; ssdGiBHour: number; hdHaMultiplierNote: string };
  egress: { url: string; tier: string; to: string; tiers: { fromGiB: number; usd: number }[]; standardTier: { fromGiB: number; usd: number }[]; note: string };
  gke: { url: string; clusterHourly: number; freeTierMonthlyCredit: number; note: string };
  dbClasses: { sku: string; vcpu: number; memGiB: number }[];
};

export async function collectGcp(now: Date, transcriptPath: URL): Promise<PriceFile> {
  const fetchedAt = now.toISOString();
  const res = await fetch(PRICING_YML);
  if (!res.ok) throw new Error(`HTTP_${res.status} ${PRICING_YML}`);
  const d = YAML.parse(await res.text()) as {
    about: { generated: string };
    compute: {
      instance: Record<string, { cost: Record<string, { hour: number; month_1y?: number }> }>;
      storage: Record<string, { cost: Record<string, { month: number }> }>;
      network: { nat: { gateway: { cost: Record<string, { hour: number }> }; data: { cost: Record<string, { month: number }> } } };
    };
  };
  const generated = d.about.generated;
  const out: PriceLine[] = [];
  const missing: string[] = [];
  for (const [sku, meta] of Object.entries(GCP_NODES)) {
    const c = d.compute.instance[sku]?.cost[REGION];
    if (!c) { missing.push(`node/${sku}`); continue; }
    out.push({
      vendor: "gcp", region: REGION, item: "node", sku, unit: "hour", usd: c.hour,
      attrs: { vcpu: meta.vcpu, memGiB: meta.memGiB, family: meta.family, ...(meta.burstable ? { burstable: true, sustainedVcpu: meta.sustainedVcpu! } : {}) },
      // month_1y는 1년 약정 월가 / 730
      ...(c.month_1y !== undefined ? { commit1yHourly: Math.round(c.month_1y / 730 * 1e6) / 1e6 } : {}),
      evidence: "public-secondary", sourceUrl: PRICING_YML,
      sourceDetail: `pricing.yml compute.instance.${sku}.cost.${REGION}`, fetchedAt, publishedAt: generated,
    });
  }
  const bal = d.compute.storage["balanced"]?.cost[REGION];
  if (bal) out.push({ vendor: "gcp", region: REGION, item: "disk", sku: "pd-balanced", unit: "gb_month", usd: bal.month, evidence: "public-secondary", sourceUrl: PRICING_YML, sourceDetail: `pricing.yml compute.storage.balanced.cost.${REGION}`, fetchedAt, publishedAt: generated });
  else missing.push("disk/pd-balanced");

  const natH = d.compute.network.nat.gateway.cost[REGION];
  const natD = d.compute.network.nat.data.cost[REGION];
  if (natH) out.push({ vendor: "gcp", region: REGION, item: "nat", sku: "nat-hour", unit: "hour", usd: natH.hour, evidence: "public-secondary", sourceUrl: PRICING_YML, sourceDetail: `pricing.yml compute.network.nat.gateway.cost.${REGION}`, fetchedAt, publishedAt: generated });
  if (natD) out.push({ vendor: "gcp", region: REGION, item: "nat", sku: "nat-data", unit: "gb", usd: natD.month, evidence: "public-secondary", sourceUrl: PRICING_YML, sourceDetail: `pricing.yml compute.network.nat.data.cost.${REGION}`, fetchedAt, publishedAt: generated });

  const t = JSON.parse(readFileSync(transcriptPath, "utf8")) as Transcript;
  const base = { vendor: "gcp" as const, region: REGION, evidence: "public" as const, fetchedAt: t.capturedAt };
  out.push({ ...base, item: "cluster", sku: "gke-management", unit: "hour", usd: t.gke.clusterHourly, sourceUrl: t.gke.url, sourceDetail: t.gke.note });
  for (const c of t.dbClasses) {
    const usd = c.vcpu * t.cloudSql.vcpuHourly + c.memGiB * t.cloudSql.memGiBHourly;
    const u1 = c.vcpu * t.cloudSql.vcpuHourlyCud1y + c.memGiB * t.cloudSql.memGiBHourlyCud1y;
    out.push({
      ...base, item: "db", sku: c.sku, unit: "hour", usd: Math.round(usd * 1e6) / 1e6, commit1yHourly: Math.round(u1 * 1e6) / 1e6,
      attrs: { vcpu: c.vcpu, memGiB: c.memGiB, family: "general" }, sourceUrl: t.cloudSql.url,
      sourceDetail: `${t.cloudSql.section}: ${c.vcpu} x ${t.cloudSql.vcpuHourly} + ${c.memGiB} x ${t.cloudSql.memGiBHourly}`,
    });
  }
  out.push({ ...base, item: "storage", sku: "cloudsql-ssd", unit: "gb_month", usd: Math.round(t.cloudSql.ssdGiBHour * 730 * 1e6) / 1e6, sourceUrl: t.cloudSql.url, sourceDetail: `SSD storage capacity ${t.cloudSql.ssdGiBHour}/GiB-hour x 730` });
  for (const tier of t.egress.tiers) out.push({ ...base, item: "egress", sku: "internet-out", unit: "gb", usd: tier.usd, tierFromGB: tier.fromGiB, sourceUrl: t.egress.url, sourceDetail: `${t.egress.tier} ${t.egress.to} (GiB 단위 표기)` });

  return {
    vendor: "gcp", region: REGION, fetchedAt,
    sources: [
      { url: PRICING_YML, publishedAt: generated, note: "공식 Billing Catalog에서 생성한 2차 자료" },
      { url: t.cloudSql.url, note: t.method }, { url: t.egress.url, note: t.method }, { url: t.gke.url, note: "페이지 본문" },
    ],
    missing, lines: out,
  };
}
