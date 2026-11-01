import type { PriceFile, PriceLine } from "./types.js";

// DRAFT(ai): 온프레는 가격표가 없다. 모든 값은 `가정`이며 파라미터로 바꿀 수 있다.
// 근거가 있는 항목은 출처를 붙였지만, 이 사양과 이 회사의 실제 견적이 아니다.
export type OnpremAssumption = {
  server: { sku: string; capexUsd: number; amortMonths: number; vcpu: number; memGiB: number; avgWatts: number; rackUnits: number };
  usdPerKrw: number;
  electricityKrwPerKwh: number;
  pue: number;
  colocationKrwPerUMonth: number;
  lineKrwPerMonth: number;
  lineCapacityGbps: number;
  opsFte: number;
  opsKrwPerFteYear: number;
  minServers: number;
};

export const DEFAULT_ONPREM: OnpremAssumption = {
  // 2U 32코어 64스레드, 256GiB. 신품 견적이 아니다. 공개 범위: 중고 2x32코어 256GB 약 £11,790(ebay), Dell 싱가포르 R7625 구성가 from SGD 환산 약 $21,987 표기
  server: { sku: "server-32c64t-256g", capexUsd: 15000, amortMonths: 60, vcpu: 64, memGiB: 256, avgWatts: 350, rackUnits: 2 },
  usdPerKrw: 1 / 1430,          // 팀 가이드 환율 1,430원
  electricityKrwPerKwh: 182,    // 2025 산업용 평균 판매단가 181.9원 보도(sedaily), 2026-06 장관 발언 약 182원
  pue: 1.54,                    // Uptime Institute 2025 조사 평균
  colocationKrwPerUMonth: 70000,// 국내 IDC 1U 월 7만원부터(블로그 1건, 공식 견적 아님)
  lineKrwPerMonth: 1000000,     // 1Gbps 월 100만원 이상(같은 블로그 1건, 공식 견적 아님)
  lineCapacityGbps: 1,
  opsFte: 0.25,                 // 가정: 인프라 엔지니어 0.25명
  opsKrwPerFteYear: 80000000,   // 가정: 인건비 포함 연 8천만원
  minServers: 2,                // 가정: k3s + CloudNativePG 이중화 최소 2대
};

export const ONPREM_SOURCES = [
  { url: "assumption:onprem", note: "서버 감가·운영 인력은 가정" },
  { url: "https://en.sedaily.com/finance/2026/06/05/korea-minister-signals-cut-in-industrial-electricity-rates", note: "산업용 전기요금 약 182원/kWh" },
  { url: "https://mgrid.org/2025/10/01/uptime-institute-data-center-pue-stagnation-2025-liquid-cooling/", note: "Uptime 2025 PUE 평균 1.54 (2차 보도)" },
  { url: "https://tilnote.io/pages/6ad7925d19114ceafa1fa5fe", note: "국내 IDC 상면·회선 가격 (블로그 1건, 공식 견적 아님)" },
  { url: "https://www.dell.com/en-sg/work/shop/cty/pdp/spd/poweredge-r7625", note: "서버 구성가 상한 참고" },
];

export function onpremLines(a: OnpremAssumption, now: Date): PriceLine[] {
  const fetchedAt = now.toISOString();
  const base = { vendor: "onprem" as const, region: "local", evidence: "assumed" as const, fetchedAt, sourceUrl: "assumption:onprem" };
  const s = a.server;
  const amortHourly = s.capexUsd / s.amortMonths / 730;
  const powerHourly = (s.avgWatts / 1000) * a.pue * a.electricityKrwPerKwh * a.usdPerKrw;
  const colocHourly = s.rackUnits * a.colocationKrwPerUMonth * a.usdPerKrw / 730;
  const lineHourly = a.lineKrwPerMonth * a.usdPerKrw / 730;
  const opsHourly = a.opsFte * a.opsKrwPerFteYear * a.usdPerKrw / 12 / 730;
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return [
    { ...base, item: "node", sku: s.sku, unit: "hour", usd: r(amortHourly + powerHourly + colocHourly),
      attrs: { vcpu: s.vcpu, memGiB: s.memGiB, family: "server", note: `감가 ${r(amortHourly)} + 전기 ${r(powerHourly)} + 상면 ${r(colocHourly)}` },
      sourceDetail: `가정: 서버 $${s.capexUsd} / ${s.amortMonths}개월, ${s.avgWatts}W x PUE ${a.pue} x ${a.electricityKrwPerKwh}원, ${s.rackUnits}U x ${a.colocationKrwPerUMonth}원` },
    { ...base, item: "cluster", sku: "ops-and-line", unit: "hour", usd: r(lineHourly + opsHourly),
      attrs: { note: `회선 ${r(lineHourly)} + 운영 ${r(opsHourly)}` },
      sourceDetail: `가정: 회선 ${a.lineCapacityGbps}Gbps ${a.lineKrwPerMonth}원/월, 운영 ${a.opsFte}명 x ${a.opsKrwPerFteYear}원/년` },
    { ...base, item: "storage", sku: "local-nvme", unit: "gb_month", usd: 0, sourceDetail: "가정: 서버 안 NVMe. 비용은 서버 감가에 포함, 용량 한도는 범위 밖" },
    { ...base, item: "egress", sku: "committed-line", unit: "gb", usd: 0, tierFromGB: 0, sourceDetail: `가정: 고정 회선 안. ${a.lineCapacityGbps}Gbps 한도 초과는 불가로 처리` },
  ];
}

export function collectOnprem(a: OnpremAssumption, now: Date): PriceFile {
  return { vendor: "onprem", region: "local", fetchedAt: now.toISOString(), sources: ONPREM_SOURCES, missing: [], lines: onpremLines(a, now) };
}
