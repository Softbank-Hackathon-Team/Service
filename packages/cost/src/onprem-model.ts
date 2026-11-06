import type { CostGap, CostLine } from "@svc/contracts";
import { fill, usdText, type Lang } from "./evidence-text.js";

// 온프레 월 비용 모형. 가격표가 없어 항마다 출처 있는 가정으로 나눈다 (모든 항 evidence: assumed).
// 값은 비용 POC(11/01)에서 출처와 함께 정한 것을 옮겼다. 회선·운영 인력은 회사마다 크게 달라 합계에서 빼고 참고값만 보인다.
// DRAFT(ai): 환율 1,460원/달러 — 2026-11 시세를 찾지 못해 2026-07 공개 시세(1,454~1,478) 가운데 값. 바뀌면 이 상수만 고친다
export const KRW_PER_USD = 1460;

export const ONPREM_SERVER = {
  vcpu: 64, memGiB: 256,                       // 32코어 64스레드·256 GiB 서버 1대 【가정】
  priceUsd: 15000, months: 60,                 // 구성가 $15,000 / 60개월 감가 【가정, 상한 참고: Dell R7625 구성가】
  watts: 350, pue: 1.54, krwPerKwh: 182,       // 평균 350W 【가정】, PUE 1.54 (Uptime 2025 평균), 산업용 전기 182원/kWh
  rackUnits: 2, krwPerUnitMonth: 70000,        // 2U x 7만 원/월 (국내 IDC 상면, 공개 글 1건)
  lineKrwMonth: 1_000_000,                     // 회선 1 Gbps 100만 원/월 (같은 글) — 합계 밖
  opsFte: 0.25, opsKrwYear: 80_000_000,        // 운영 0.25명 x 연 8천만 원 【가정】 — 합계 밖
} as const;

const SRC = {
  server: "https://www.dell.com/en-sg/work/shop/cty/pdp/spd/poweredge-r7625",
  power: "https://en.sedaily.com/finance/2026/06/05/korea-minister-signals-cut-in-industrial-electricity-rates",
  pue: "https://mgrid.org/2025/10/01/uptime-institute-data-center-pue-stagnation-2025-liquid-cooling/",
  space: "https://tilnote.io/pages/6ad7925d19114ceafa1fa5fe",
};

const r2 = (x: number) => Math.round(x * 100) / 100;
const usdOfKrw = (krw: number) => krw / KRW_PER_USD;

export const onpremMonthly = {
  server: () => ONPREM_SERVER.priceUsd / ONPREM_SERVER.months,
  power: () => usdOfKrw((ONPREM_SERVER.watts / 1000) * ONPREM_SERVER.pue * 730 * ONPREM_SERVER.krwPerKwh),
  space: () => usdOfKrw(ONPREM_SERVER.rackUnits * ONPREM_SERVER.krwPerUnitMonth),
};

/** 서버 수 = vCPU·메모리 합을 서버 사양으로 나눠 올림 (최소 1대) */
export const serversFor = (vcpu: number, memGiB: number) =>
  Math.max(1, Math.ceil(vcpu / ONPREM_SERVER.vcpu), Math.ceil(memGiB / ONPREM_SERVER.memGiB));

export function onpremLines(lang: Lang, servers: number, basis: CostLine["basis"], asOf: string): { lines: CostLine[]; gaps: CostGap[] } {
  const s = ONPREM_SERVER;
  const mk = (id: string, label: string, unitUsd: number, source: string, sourceUrl: string): CostLine => ({
    id: `onprem:${id}`, group: "fixed", label, quantity: servers, quantityUnit: fill(lang, "uServers").trim() || "",
    hours: null, monthlyUsd: r2(servers * unitUsd),
    formula: `${servers}${fill(lang, "uServers")} x ${usdText(r2(unitUsd))}${fill(lang, "perMonth")}`,
    basis,
    price: { item: "fixed", sku: `onprem-${id}`, unitUsd: r2(unitUsd), unit: "month", evidence: "assumed", sourceKind: "assumption",
      source, sourceUrl, fetchedAt: asOf },
  });
  const lines = [
    mk("server", fill(lang, "onpremServer"), onpremMonthly.server(),
      `$${s.priceUsd.toLocaleString("en-US")} / ${s.months}개월 감가 (서버 ${s.vcpu} 스레드·${s.memGiB} GiB, 구성가 상한 참고)`, SRC.server),
    mk("power", fill(lang, "onpremPower"), onpremMonthly.power(),
      `${s.watts}W x PUE ${s.pue} x 730시간 x ${s.krwPerKwh}원/kWh ÷ ${KRW_PER_USD}원/$ (전기요금 보도, PUE: Uptime 2025 평균)`, SRC.power),
    mk("space", fill(lang, "onpremSpace"), onpremMonthly.space(),
      `${s.rackUnits}U x ${s.krwPerUnitMonth.toLocaleString("en-US")}원/월 ÷ ${KRW_PER_USD}원/$ (국내 IDC 상면 공개 글)`, SRC.space),
  ];
  const gaps: CostGap[] = [
    { id: "onprem:line", label: fill(lang, "gOnpremLine"), reason: fill(lang, "gOnpremWhy"), estimateUsd: r2(usdOfKrw(s.lineKrwMonth)) },
    { id: "onprem:ops", label: fill(lang, "gOnpremOps"), reason: fill(lang, "gOnpremWhy"), estimateUsd: r2(usdOfKrw((s.opsFte * s.opsKrwYear) / 12)) },
  ];
  return { lines, gaps };
}
