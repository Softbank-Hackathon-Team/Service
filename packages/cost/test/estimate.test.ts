import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CostEstimate, estimateCost, loadSampleCatalog, mauToRps, tieredCost, type PriceRow,
} from "../src/index.js";
import { POC_NODES, spec } from "./helpers.js";

const catalog = loadSampleCatalog();
const byP = (r: CostEstimate, p: string) => r.envs.find((e) => e.provider === p)!;

test("PoC 장면 1: 10 rps에서 AWS $227.5, GCP $146.9, 절약 $80.6 중 크레딧 $73", () => {
  const r = estimateCost({ spec: spec(), from: "aws", traffic: { peakRps: 10 }, nodeSkus: POC_NODES },
    catalog, { breakpoints: false });
  assert.equal(byP(r, "aws").monthlyUsd, 227.5);
  assert.equal(byP(r, "gcp").monthlyUsd, 146.9);
  assert.equal(byP(r, "onprem").monthlyUsd, 250);
  assert.deepEqual(byP(r, "aws").parts, { cluster: 73, nodes: 75.9, db: 76, storage: 2.6, fixed: 0 });
  assert.deepEqual(r.savings, { from: "aws", to: "gcp", monthlyUsd: 80.6, creditPortionUsd: 73 });
  assert.equal(r.cheapest, "gcp");
});

test("크레딧을 빼면 절약은 $7.6", () => {
  const r = estimateCost({ spec: spec(), from: "aws", traffic: { peakRps: 10 }, applyCredits: false,
    nodeSkus: POC_NODES }, catalog, { breakpoints: false });
  assert.equal(r.savings?.monthlyUsd, 7.6);
  assert.equal(r.savings?.creditPortionUsd, 0);
  assert.equal(byP(r, "gcp").monthlyUsdNoCredit, 219.9);
});

test("PoC 장면 2: MAU가 늘면 최저 환경이 gcp -> gcp -> onprem -> gcp, 300만이면 온프레 불가", () => {
  const got = [20_000, 200_000, 1_000_000, 3_000_000].map((mau) =>
    estimateCost({ spec: spec(), traffic: { mau }, applyCredits: false, nodeSkus: POC_NODES },
      catalog, { breakpoints: false }));
  assert.deepEqual(got.map((r) => r.cheapest), ["gcp", "gcp", "onprem", "gcp"]);
  assert.equal(got[2]!.peakRps, 347.2);
  const on = byP(got[3]!, "onprem");
  assert.equal(on.feasible, false);
  assert.equal(on.reason, "ONPREM_CAPACITY_EXCEEDED");
  assert.equal(on.monthlyUsd, null);
});

test("PoC 장면 3: 최저 환경이 바뀌는 지점 0 gcp / 190 onprem / 911 gcp", () => {
  const r = estimateCost({ spec: spec(), traffic: { peakRps: 10 }, nodeSkus: POC_NODES }, catalog);
  assert.deepEqual(r.breakpoints, [
    { fromRps: 0, cheapest: "gcp", nodes: 2 },
    { fromRps: 190, cheapest: "onprem", nodes: 3 },
    { fromRps: 911, cheapest: "gcp", nodes: 9 },
  ]);
});

test("PoC 장면 4: 스타트업은 GCP 기본, 금융은 GCP 강화 (월 $110.8 더 냄)", () => {
  const run = (profile: "startup" | "finance") => estimateCost({
    spec: spec(), traffic: { peakRps: 10 }, targets: ["aws", "gcp"], profile, nodeSkus: POC_NODES,
  }, catalog, { breakpoints: false }).recommendations;
  const s = run("startup"), f = run("finance");
  assert.deepEqual([s[0]!.provider, s[0]!.security, s[0]!.score], ["gcp", "basic", 0.479]);
  assert.equal(s[1]!.score, 0.624);
  assert.deepEqual([f[0]!.provider, f[0]!.security, f[0]!.score], ["gcp", "hardened", 0.414]);
  assert.equal(f[1]!.score, 0.46);
  assert.equal(Math.round((f[0]!.monthlyUsd - s[0]!.monthlyUsd) * 10) / 10, 110.8);
});

test("전수 탐색: 노드 종류를 전부 계산하고, 메모리가 크면 노드 수가 늘어난다", () => {
  const r = estimateCost({ spec: spec({ replicas: 10, memMiB: 2048 }), traffic: { peakRps: 10 } },
    catalog, { breakpoints: false });
  const aws = byP(r, "aws");
  assert.equal(aws.candidatesEvaluated, 3);
  assert.equal(aws.nodeSku, "t3.medium");
  assert.equal(aws.nodes, 9); // 20GiB / (4GiB x 0.6) = 8.3 -> 9
  assert.deepEqual(aws.unverified, ["storage"]); // 고른 t3.medium은 사실값
});

test("DB 없는 명세는 DB·스토리지 0원", () => {
  const r = estimateCost({ spec: spec({}, false), traffic: { peakRps: 10 }, nodeSkus: POC_NODES },
    catalog, { breakpoints: false });
  assert.equal(byP(r, "aws").parts.db, 0);
  assert.equal(byP(r, "aws").parts.storage, 0);
  assert.equal(byP(r, "aws").monthlyUsd, 148.9);
});

test("거부: 명세에 모르는 칸이 있거나 rps가 음수면 parse 오류", () => {
  const bad = structuredClone(spec()) as unknown as { components: Array<{ props: Record<string, unknown> }> };
  bad.components[0]!.props["privileged"] = true;
  assert.throws(() => estimateCost({ spec: bad as never, traffic: { peakRps: 1 } }, catalog));
  assert.throws(() => estimateCost({ spec: spec(), traffic: { peakRps: -1 } }, catalog));
});

test("가격이 없는 벤더는 PRICE_MISSING, 순위에서 빠진다", () => {
  const noGcp = { ...catalog, rows: catalog.rows.filter((r) => r.vendor !== "gcp") };
  const r = estimateCost({ spec: spec(), traffic: { peakRps: 10 } }, noGcp, { breakpoints: false });
  assert.equal(byP(r, "gcp").reason, "PRICE_MISSING");
  assert.ok(r.recommendations.every((x) => x.provider !== "gcp"));
  assert.equal(r.cheapest, "aws");
});

test("가격표가 7일 넘으면 priceStale=true (승인은 막지 않음)", () => {
  const at = (d: string) => estimateCost({ spec: spec(), traffic: { peakRps: 1 } }, catalog,
    { breakpoints: false, now: new Date(d) }).priceStale;
  assert.equal(at("2026-11-06T00:00:00Z"), false);
  assert.equal(at("2026-11-08T00:00:01Z"), true);
});

test("출력은 CostEstimate 스키마를 통과하고 JSON으로 그대로 직렬화된다", () => {
  const r = estimateCost({ spec: spec(), from: "aws", traffic: { mau: 3_000_000 } }, catalog);
  const again = CostEstimate.parse(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(again, r);
});

test("MAU -> rps, 계단식 가격", () => {
  assert.equal(Math.round(mauToRps({ mau: 200_000, dauRatio: 0.2, reqPerUserDay: 50, peakFactor: 3 }) * 10) / 10, 69.4);
  const row = (tierFrom: number, usd: number) => ({ tierFrom, usd } as PriceRow);
  assert.equal(tieredCost([row(0, 0), row(10, 0.2)], 25), 3);
  assert.equal(tieredCost([row(0, 0.131)], 20), 0.131 * 20);
});

test("측정: 0~2000 rps x 3환경 경계 찾기 5회", () => {
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    estimateCost({ spec: spec(), traffic: { peakRps: 10 } }, catalog);
    ms.push(Math.round((performance.now() - t) * 10) / 10);
  }
  console.log(`breakpoints 6,003 envs x all node types: ${ms.join(" / ")} ms`);
  assert.ok(Math.min(...ms) < 500);
});
