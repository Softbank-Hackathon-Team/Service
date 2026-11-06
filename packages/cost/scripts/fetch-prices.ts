// 실행: npm run prices:fetch -w @svc/cost
// 가격 API를 불러 packages/cost/prices/*.json 캐시를 새로 쓴다. 네트워크가 없으면 있던 캐시를 그대로 쓴다.
// GCP는 환경 변수 GCP_BILLING_API_KEY가 있을 때만 부른다. 없으면 캐시, 캐시도 없으면 샘플값으로 seed 캐시를 만든다.
import type { Provider } from "@svc/contracts";
import {
  createAwsBulkSource, createGcpCatalogSource, createOnpremSource, estimateCost, fetchWithCache, fileLines,
  loadCatalog, loadSampleCatalog, readCache, vendorRegion, writeCache,
  type DetailedPriceSource, type LineSource, type PriceCatalog,
} from "../src/index.js";
import { spec as demoShop } from "../test/helpers.js";

const REGION = "ap-northeast-2";
const now = new Date();
const sample = loadSampleCatalog();

// AWS_BULK_DIR=<폴더> 면 그 폴더의 {서비스}.csv 를 읽는다 (같은 공개 파일을 curl -C - 로 이어 받아 둔 것).
//   11/06 이 맥에서 Node fetch 가 EC2 서울 CSV(약 200MB)를 6초쯤에서 끊었다(terminated). 출처 주소는 원래 공개 주소 그대로 남는다
const bulkDir = process.env["AWS_BULK_DIR"];
const awsLines: LineSource | undefined = bulkDir
  ? (url) => fileLines(`${bulkDir}/${url.split("/").at(-4)}.csv`)()
  : undefined;
const sources: DetailedPriceSource[] = [createAwsBulkSource(awsLines ? { lines: awsLines } : {}), createGcpCatalogSource(), createOnpremSource()];

for (const src of sources) {
  const t0 = performance.now();
  try {
    const r = await fetchWithCache(src, REGION, now);
    const ms = Math.round(performance.now() - t0);
    console.log(`${src.vendor}: ${r.from} ${r.rows.length}줄 ${ms}ms`
      + (r.missing.length ? ` 못 찾음=${r.missing.join(",")}` : "")
      + (r.error ? ` (실패 이유: ${r.error})` : ""));
  } catch (e) {
    // 받지도 못하고 캐시도 없음 -> 샘플 줄로 seed 캐시를 만든다 (evidence는 샘플 그대로)
    const vr = vendorRegion(src.vendor, REGION);
    const rows = sample.rows.filter((r) => r.vendor === src.vendor && r.region === vr);
    writeCache({
      vendor: src.vendor, region: vr, fetchedAt: sample.asOf, origin: "seed",
      note: `API 호출 실패(${(e as Error).message}). 샘플 가격표 값을 그대로 옮김. 【미확인】`,
      sources: [], missing: [], rows,
    });
    console.log(`${src.vendor}: seed ${rows.length}줄 (실패 이유: ${(e as Error).message})`);
  }
}

// ---- 비교: 샘플 가격표 vs 캐시 반영 가격표 ----
const catalog = loadCatalog();
const fmt = (x: number | null | undefined) => (x === null || x === undefined ? "-" : `$${x.toFixed(2)}`);

console.log("\n| 벤더 | 항목 | SKU | 샘플 | 캐시 | 단위 | 근거(캐시) |");
console.log("|---|---|---|---|---|---|---|");
for (const v of ["aws", "gcp", "onprem"] as Provider[]) {
  const c = readCache(v);
  for (const r of c?.rows ?? []) {
    const s = sample.rows.find((x) => x.vendor === v && x.item === r.item && x.sku === r.sku);
    const sUsd = s ? (s.unit === r.unit ? s.usd : s.unit === "month" && r.unit === "hour" ? s.usd / 730 : s.usd) : null;
    console.log(`| ${v} | ${r.item} | ${r.sku} | ${sUsd === null ? "없음" : sUsd.toFixed(4)} | ${r.usd.toFixed(4)} | ${r.unit} | ${r.evidence} |`);
  }
}

const spec = demoShop();   // 시험과 같은 명세: 서비스 1대 x 250m/512Mi + Postgres 20GB
const poc = ["t3.medium", "e2-medium", "k3s-vm-2c8g"];
const run = (cat: PriceCatalog, nodeSkus?: string[]) =>
  estimateCost({ spec, from: "aws", traffic: { peakRps: 10 }, ...(nodeSkus ? { nodeSkus } : {}) }, cat,
    { breakpoints: false });

console.log("\n| 환경 | 샘플 PoC 노드 | 캐시 PoC 노드 | 차이 | 캐시 전체 노드 탐색 |");
console.log("|---|---|---|---|---|");
const a = run(sample, poc), b = run(catalog, poc), c = run(catalog);
for (const e of a.envs) {
  const nb = b.envs.find((x) => x.provider === e.provider)!;
  const nc = c.envs.find((x) => x.provider === e.provider)!;
  const d = e.monthlyUsd !== null && nb.monthlyUsd !== null ? nb.monthlyUsd - e.monthlyUsd : null;
  console.log(`| ${e.provider} | ${fmt(e.monthlyUsd)} | ${fmt(nb.monthlyUsd)} | ${d === null ? "-" : `${d >= 0 ? "+" : ""}${d.toFixed(2)}`} | ${fmt(nc.monthlyUsd)} (${nc.nodeSku} ${nc.nodes}대) |`);
}
console.log(`\n절약(aws→최저): 샘플 ${fmt(a.savings?.monthlyUsd)} / 캐시 ${fmt(b.savings?.monthlyUsd)}. 가격 기준일 ${catalog.asOf}`);

// 합계에 안 넣은 AWS 항목 참고값 (ALB 1개 + LCU 1개, 노드 2대 x 루트 디스크 20GB)
const awsRow = (item: string) => catalog.rows.find((r) => r.vendor === "aws" && r.item === item);
const alb = awsRow("lb"), lcu = awsRow("lb_capacity"), vol = awsRow("volume");
if (alb && lcu && vol) {
  console.log(`참고(합계 제외): ALB ${fmt(alb.usd * 730)} + LCU 1개 ${fmt(lcu.usd * 730)} / EBS gp3 2x20GB ${fmt(vol.usd * 40)}`);
}
