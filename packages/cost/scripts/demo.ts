// 실행: npm run demo -w @svc/cost
// 샘플 가격표로 PoC(cost_poc.py) 네 장면을 다시 보여 준다. 네트워크 없음.
import { estimateCost, loadSampleCatalog } from "../src/index.js";
import { spec as demoShop } from "../test/helpers.js";

const catalog = loadSampleCatalog();
const spec = demoShop();   // 시험과 같은 명세: 서비스 1대 x 250m/512Mi + Postgres 20GB
// PoC와 같은 노드 종류만 (전수 탐색 끄고 비교)
const poc = ["t3.medium", "e2-medium", "k3s-vm-2c8g"];

const fmt = (x: number | null) => (x === null ? "불가" : `$${x.toFixed(1)}`);

console.log("# 1) 피크 10 rps, 노드 2대 + DB + 20GB");
const a = estimateCost({ spec, from: "aws", traffic: { peakRps: 10 }, nodeSkus: poc }, catalog,
  { breakpoints: false });
for (const e of a.envs) console.log(`${e.provider}: ${e.nodeSku} ${e.nodes}대 월 ${fmt(e.monthlyUsd)}`, e.parts);
console.log("절약", a.savings);

console.log("\n# 2) MAU 시나리오 (크레딧 없음)");
for (const mau of [20_000, 200_000, 1_000_000, 3_000_000]) {
  const r = estimateCost({ spec, traffic: { mau }, applyCredits: false, nodeSkus: poc }, catalog,
    { breakpoints: false });
  console.log(`MAU ${mau} 피크 ${r.peakRps}rps: ${r.envs.map((e) => `${e.provider} ${fmt(e.monthlyUsd)}`).join(" / ")} -> ${r.cheapest}`);
}

console.log("\n# 3) 최저 환경이 바뀌는 지점");
const t0 = performance.now();
const b = estimateCost({ spec, traffic: { peakRps: 10 }, nodeSkus: poc }, catalog);
console.log(b.breakpoints, `${(performance.now() - t0).toFixed(1)}ms`);

console.log("\n# 4) 프로필별 추천 (aws, gcp만)");
for (const profile of ["startup", "finance"] as const) {
  const r = estimateCost({ spec, traffic: { peakRps: 10 }, targets: ["aws", "gcp"], profile, nodeSkus: poc },
    catalog, { breakpoints: false });
  console.log(profile, r.recommendations.slice(0, 2));
}

console.log("\n# 5) 전수 탐색 (노드 종류 전부, 300 rps)");
const f = estimateCost({ spec, from: "aws", traffic: { peakRps: 300 } }, catalog, { breakpoints: false });
for (const e of f.envs) console.log(`${e.provider}: ${e.nodeSku} ${e.nodes}대 월 ${fmt(e.monthlyUsd)} 후보 ${e.candidatesEvaluated}개, 미확인 ${e.unverified.join(",")}`);
