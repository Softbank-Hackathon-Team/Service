import type { PriceFile, PriceLine } from "./types.js";

// DRAFT(ai): Azure Retail Prices API (공개, 자격 증명 없음). 한국 중부 koreacentral.
// 호출이 많으면 429가 나므로 간격을 두고 재시도한다.
const API = "https://prices.azure.com/api/retail/prices";
const REGION = "koreacentral";

type Item = {
  armSkuName: string; skuName: string; productName: string; meterName: string; serviceName: string;
  type: string; reservationTerm?: string; retailPrice: number; unitOfMeasure: string; tierMinimumUnits: number;
  armRegionName: string; meterId: string; skuId?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function query(filter: string): Promise<Item[]> {
  const items: Item[] = [];
  let url: string | null = `${API}?$filter=${encodeURIComponent(filter)}`;
  while (url) {
    let res: Response | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      res = await fetch(url);
      if (res.status !== 429 && res.status < 500) break;
      await sleep(5000 * (attempt + 1));
    }
    if (!res || !res.ok) throw new Error(`HTTP_${res?.status} ${filter}`);
    const body = (await res.json()) as { Items: Item[]; NextPageLink: string | null };
    items.push(...body.Items);
    url = body.NextPageLink;
    await sleep(1200);
  }
  return items;
}

// 매칭 규칙: x86, 종량, Linux. 범용 1:4(Dsv5), 컴퓨트 1:2(Fsv2), 메모리 1:8(Esv5), 버스터블(Bs)
// 기준 CPU 비율: https://learn.microsoft.com/azure/virtual-machines/sizes/general-purpose/bv1-series
export const AZURE_NODES: Record<string, { vcpu: number; memGiB: number; family: string; burstable?: boolean; baselinePct?: number }> = {
  Standard_D2s_v5: { vcpu: 2, memGiB: 8, family: "general" }, Standard_D4s_v5: { vcpu: 4, memGiB: 16, family: "general" },
  Standard_D8s_v5: { vcpu: 8, memGiB: 32, family: "general" }, Standard_D16s_v5: { vcpu: 16, memGiB: 64, family: "general" },
  Standard_F2s_v2: { vcpu: 2, memGiB: 4, family: "compute" }, Standard_F4s_v2: { vcpu: 4, memGiB: 8, family: "compute" },
  Standard_F8s_v2: { vcpu: 8, memGiB: 16, family: "compute" }, Standard_F16s_v2: { vcpu: 16, memGiB: 32, family: "compute" },
  Standard_E2s_v5: { vcpu: 2, memGiB: 16, family: "memory" }, Standard_E4s_v5: { vcpu: 4, memGiB: 32, family: "memory" }, Standard_E8s_v5: { vcpu: 8, memGiB: 64, family: "memory" },
  // 2024년부터 VM 전체 기준(0~100%)으로 표기: B2s 20%, B2ms 30%, B4ms 22.5%
  Standard_B2s: { vcpu: 2, memGiB: 4, family: "burstable", burstable: true, baselinePct: 20 },
  Standard_B2ms: { vcpu: 2, memGiB: 8, family: "burstable", burstable: true, baselinePct: 30 },
  Standard_B4ms: { vcpu: 4, memGiB: 16, family: "burstable", burstable: true, baselinePct: 22.5 },
};

export async function collectAzure(now: Date): Promise<PriceFile> {
  const fetchedAt = now.toISOString();
  const out: PriceLine[] = [];
  const url = `${API} (armRegionName=${REGION})`;
  const add = (l: Omit<PriceLine, "vendor" | "region" | "evidence" | "fetchedAt" | "sourceUrl">) =>
    out.push({ vendor: "azure", region: REGION, evidence: "public", fetchedAt, sourceUrl: url, ...l });
  const missing: string[] = [];

  // 노드: 시리즈별로 한 번에 받는다
  const vmItems: Item[] = [];
  for (const sku of Object.keys(AZURE_NODES)) {
    vmItems.push(...await query(`serviceName eq 'Virtual Machines' and armRegionName eq '${REGION}' and armSkuName eq '${sku}'`));
  }
  for (const [sku, meta] of Object.entries(AZURE_NODES)) {
    const rows = vmItems.filter((i) => i.armSkuName === sku && !/Windows|Spot|Low Priority/.test(`${i.productName} ${i.skuName}`));
    const od = rows.find((i) => i.type === "Consumption");
    if (!od) { missing.push(`node/${sku}`); continue; }
    // 1년 예약은 1년 총액이 시간 단위 표기로 온다: 총액 / 8760
    const r1 = rows.find((i) => i.type === "Reservation" && i.reservationTerm === "1 Year");
    add({
      item: "node", sku, unit: "hour", usd: od.retailPrice,
      attrs: { vcpu: meta.vcpu, memGiB: meta.memGiB, family: meta.family, ...(meta.burstable ? { burstable: true, sustainedVcpu: meta.vcpu * meta.baselinePct! / 100 } : {}) },
      ...(r1 ? { commit1yHourly: Math.round(r1.retailPrice / 8760 * 1e6) / 1e6 } : {}),
      sourceDetail: `Virtual Machines ${od.productName} / ${od.skuName} meterId ${od.meterId}`,
    });
  }

  // AKS: Standard 등급 업타임 SLA (Free 등급은 0이지만 SLA가 없다. 운영 비교 기준은 Standard)
  const aks = await query(`serviceName eq 'Azure Kubernetes Service' and armRegionName eq '${REGION}'`);
  const aksStd = aks.find((i) => i.meterName === "Standard Uptime SLA" && i.type === "Consumption");
  if (aksStd) add({ item: "cluster", sku: "aks-standard", unit: "hour", usd: aksStd.retailPrice, sourceDetail: `AKS ${aksStd.productName} / ${aksStd.meterName}` });
  else missing.push("cluster/aks-standard");

  // Azure Database for PostgreSQL Flexible Server
  // Ddsv5: 2~16 vCore. 메모리는 vCore당 4GiB. 1년 예약은 vCore당 연 총액.
  const pg = await query(`serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '${REGION}'`);
  const DDS = "Azure Database for PostgreSQL Flexible Server General Purpose Ddsv5 Series Compute";
  const dds = pg.filter((i) => i.productName === DDS);
  const ddsR1 = dds.find((i) => i.type === "Reservation" && i.reservationTerm === "1 Year");
  for (const v of [2, 4, 8, 16]) {
    const i = dds.find((x) => x.type === "Consumption" && x.skuName === `${v} vCore`);
    if (!i) { missing.push(`db/pg-flex-D${v}ds_v5`); continue; }
    add({
      item: "db", sku: `pg-flex-D${v}ds_v5`, unit: "hour", usd: i.retailPrice,
      attrs: { vcpu: v, memGiB: v * 4, family: "general" },
      ...(ddsR1 ? { commit1yHourly: Math.round(ddsR1.retailPrice * v / 8760 * 1e6) / 1e6 } : {}),
      sourceDetail: `${i.productName} / ${i.skuName} meterId ${i.meterId}`,
    });
  }
  const b2s = pg.find((i) => i.productName.endsWith("Burstable BS Series Compute") && i.skuName === "B2S" && i.type === "Consumption");
  if (b2s) add({ item: "db", sku: "pg-flex-B2s", unit: "hour", usd: b2s.retailPrice, attrs: { vcpu: 2, memGiB: 4, family: "burstable", burstable: true, sustainedVcpu: 0.4 }, sourceDetail: `${b2s.productName} / ${b2s.skuName} meterId ${b2s.meterId}` });
  else missing.push("db/pg-flex-B2s");
  const st = pg.find((i) => i.productName === "Azure Database for PostgreSQL Flex Server Storage" && i.type === "Consumption" && /Storage Data Stored/i.test(i.meterName) && !/ZRS/i.test(i.skuName));
  if (st) add({ item: "storage", sku: "pg-flex-ssd", unit: "gb_month", usd: st.retailPrice, sourceDetail: `${st.productName} / ${st.skuName} / ${st.meterName} (${st.unitOfMeasure})` });
  else missing.push("storage/pg-flex-ssd");

  // 인터넷 송신: 기본 라우팅(Microsoft 글로벌 네트워크) 계단. 첫 100GB 무료
  const bw = await query(`serviceName eq 'Bandwidth' and armRegionName eq '${REGION}'`);
  const mgn = bw.filter((i) => i.productName === "Rtn Preference: MGN" && i.meterName === "Standard Data Transfer Out");
  for (const i of mgn) add({ item: "egress", sku: "internet-out", unit: "gb", usd: i.retailPrice, tierFromGB: i.tierMinimumUnits, sourceDetail: `Bandwidth ${i.productName} / ${i.meterName} (${i.unitOfMeasure})` });
  if (mgn.length === 0) missing.push("egress/internet-out");

  // 노드 디스크: Standard SSD E6 (64GB 고정가)
  const disk = await query(`serviceName eq 'Storage' and armRegionName eq '${REGION}' and contains(skuName,'E6 LRS') and contains(meterName,'Disk')`);
  const e6 = disk.find((i) => i.meterName === "E6 LRS Disk" && i.type === "Consumption");
  if (e6) add({ item: "disk", sku: "standard-ssd-e6-64gb", unit: "gb_month", usd: Math.round(e6.retailPrice / 64 * 1e6) / 1e6, attrs: { note: `E6 64GB 고정가 ${e6.retailPrice}/month를 GB로 나눔` }, sourceDetail: `Storage ${e6.productName} / ${e6.meterName}` });
  else missing.push("disk/standard-ssd-e6-64gb");

  // NAT Gateway (합계 기본 제외, 민감도용)
  // NAT는 지역별 줄이 없고 Global 한 줄로 나온다
  const nat = await query(`serviceName eq 'NAT Gateway' and armRegionName eq 'Global'`);
  const natH = nat.find((i) => i.meterName === "Standard Gateway" && i.type === "Consumption");
  const natD = nat.find((i) => i.meterName === "Standard Data Processed" && i.type === "Consumption");
  if (natH) add({ item: "nat", sku: "nat-hour", unit: "hour", usd: natH.retailPrice, sourceDetail: `${natH.productName} / ${natH.meterName}` }); else missing.push("nat/nat-hour");
  if (natD) add({ item: "nat", sku: "nat-data", unit: "gb", usd: natD.retailPrice, sourceDetail: `${natD.productName} / ${natD.meterName}` }); else missing.push("nat/nat-data");

  return { vendor: "azure", region: REGION, fetchedAt, sources: [{ url: API, note: `filter armRegionName=${REGION}, serviceName=Virtual Machines|Azure Kubernetes Service|Azure Database for PostgreSQL|Bandwidth|Storage|NAT Gateway` }], missing, lines: out };
}
