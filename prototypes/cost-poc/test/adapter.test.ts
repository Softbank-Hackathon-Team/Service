import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AppSpec, CostEstimate, CostEstimateRequest, type CostEstimateRequestInput, LoadParams, PriceCatalog, PriceRow, Provider, StoredCostEstimate,
} from "@svc/contracts";
import { estimateCost, findBreakpoints, loadCatalog, loadSampleCatalog } from "@svc/cost";
import { catalogToPricing, estimateViaKross, priceFilesToCatalog, profileFromRequest } from "../src/adapter/team.js";
import { loadPriceFiles } from "../src/match.js";
import { estimate } from "../src/core/estimate.js";

const shop = AppSpec.parse(JSON.parse(readFileSync(new URL("../vendor/team/examples/shop/spec/appspec.shop.json", import.meta.url), "utf8")));
const demoDir = new URL("../vendor/team/packages/cost/prices/", import.meta.url);
const teamCatalog = () => loadCatalog({ dir: demoDir });
const request = (over: Partial<CostEstimateRequestInput> = {}): CostEstimateRequestInput => ({
  spec: shop, from: "aws", traffic: { peakRps: 10 }, targets: ["aws", "gcp", "onprem"], ...over,
});

test("팀 스키마: examples/shop AppSpec과 요청이 parse를 통과한다", () => {
  assert.equal(CostEstimateRequest.parse(request()).spec.app.name, "shop");
});

test("어댑터 출력이 CostEstimate parse를 통과한다", () => {
  const out = estimateViaKross(request(), teamCatalog(), { now: new Date("2026-11-01T00:00:00Z") });
  assert.doesNotThrow(() => CostEstimate.parse(out));
  assert.deepEqual(out.envs.map((e) => e.provider), ["aws", "gcp", "onprem"]);
  // 저장 계약도 그대로 지난다
  assert.doesNotThrow(() => StoredCostEstimate.parse({
    id: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222", planId: null,
    request: CostEstimateRequest.parse(request()), estimate: out, priceSources: [], createdAt: "2026-11-01T00:00:00Z",
  }));
});

// 같은 계산 엔진이 팀 계산식을 재현하는지: 송신 0, 피크 고정, 같은 가격표
for (const [name, catalog] of [["샘플 가격표", loadSampleCatalog], ["캐시 가격표", teamCatalog]] as const) {
  for (const rps of [0, 10, 100, 300, 1000, 5000]) {
    test(`팀 estimateCost와 수치가 같다: ${name}, ${rps} rps`, () => {
      const req = request({ traffic: { peakRps: rps }, targets: [...Provider.options] });
      const team = estimateCost(req, catalog(), { now: new Date("2026-11-01T00:00:00Z"), breakpoints: false });
      const mine = estimateViaKross(req, catalog(), { now: new Date("2026-11-01T00:00:00Z"), breakpoints: false });
      const key = (e: (typeof team.envs)[number]) => [e.provider, e.feasible, e.monthlyUsd, e.monthlyUsdNoCredit, e.nodeSku, e.nodes, e.creditUsd, e.reason, e.parts, e.unverified, e.candidatesEvaluated];
      assert.deepEqual(mine.envs.map(key), team.envs.map(key));
      assert.equal(mine.cheapest, team.cheapest);
      assert.deepEqual(mine.savings, team.savings);
      assert.equal(mine.requiredVcpu, team.requiredVcpu);
      assert.deepEqual(mine.recommendations, team.recommendations);
    });
  }
}

test("팀 PoC 고정값 재현: t3.medium 2대 $227.5, e2-medium 2대 $146.9", () => {
  const spec = { ...shop, service: { ...shop.service, replicas: 1 } };
  const out = estimateViaKross({ spec, traffic: { peakRps: 10 }, from: "aws", nodeSkus: ["t3.medium", "e2-medium", "k3s-vm-2c8g"] }, loadSampleCatalog(), { breakpoints: false });
  const aws = out.envs.find((e) => e.provider === "aws")!;
  const gcp = out.envs.find((e) => e.provider === "gcp")!;
  assert.equal(aws.monthlyUsd, 227.5); assert.equal(aws.nodes, 2);
  assert.equal(gcp.monthlyUsd, 146.9); assert.equal(gcp.nodes, 2);
});

test("역전 구간: 팀 findBreakpoints의 결과와 같다 (전수 탐색 없이)", () => {
  const req = CostEstimateRequest.parse(request({ targets: ["aws", "gcp", "onprem"] }));
  const cat = teamCatalog();
  const team = findBreakpoints({ catalog: cat, region: req.region, spec: req.spec, load: req.load, applyCredits: false }, req.targets, 2000, 1);
  const mine = estimateViaKross(req, cat, { breakpoints: { maxRps: 2000 } }).breakpoints;
  assert.deepEqual(mine.map((b) => b.cheapest), team.map((b) => b.cheapest));
  // 정수 경계에서 1 rps 차이가 날 수 있다. 팀 nodesFor는 (0.5+0.01x190)/(2x0.6)=2.0000000000000004를 그대로 올림해 3대로 본다.
  // 이 POC는 올림 전에 1e-9를 빼서 수학적 값(2대)을 쓴다. 그래서 190(팀) 대 191(POC)이다.
  for (let i = 0; i < team.length; i++) assert.ok(Math.abs(mine[i]!.fromRps - team[i]!.fromRps) <= 1, `${mine[i]!.fromRps} vs ${team[i]!.fromRps}`);
});

test("거부: 잘못된 요청은 팀 스키마가 ZodError로 막는다", () => {
  assert.throws(() => estimateViaKross({ ...request(), targets: [] }, teamCatalog()));
  assert.throws(() => estimateViaKross({ ...request(), traffic: { peakRps: -1 } } as CostEstimateRequestInput, teamCatalog()));
  assert.throws(() => estimateViaKross({ ...request(), from: "oracle" } as unknown as CostEstimateRequestInput, teamCatalog()));
});

test("가격 없음: 노드 가격이 없으면 PRICE_MISSING으로 팀과 같게 처리한다", () => {
  const cat = PriceCatalog.parse({ asOf: "2026-11-01T00:00:00Z", rows: [] });
  const out = estimateViaKross(request({ targets: ["aws"] }), cat, { breakpoints: false });
  assert.equal(out.envs[0]!.feasible, false);
  assert.equal(out.envs[0]!.reason, "PRICE_MISSING");
  assert.equal(out.cheapest, null);
});

test("PriceCatalog 재사용: 팀 가격표 줄이 POC 입력이 되고 송신은 unknown으로 드러난다", () => {
  const p = catalogToPricing(teamCatalog(), "ap-northeast-2", ["aws", "gcp"], { minNodes: 2, maxNodes: 20 });
  assert.ok(p[0]!.nodeTypes.length >= 7);
  assert.deepEqual(p[0]!.unknownItems, ["egress"]);
  assert.equal(p[0]!.egressPerGB, 0);
});

test("POC 가격 → 팀 PriceCatalog: parse 통과, 송신·NAT 줄은 담을 수 없어 빠진다", () => {
  const { catalog, dropped } = priceFilesToCatalog(loadPriceFiles(), "2026-11-01T00:00:00.000Z");
  assert.ok(catalog.rows.length > 50);
  assert.ok(dropped.length > 0);
  assert.ok(dropped.some((l) => l.item === "egress"));
  assert.ok(dropped.every((l) => l.item === "egress" || l.item === "nat"));
});

// 지금 그대로 붙일 때 깨지는 것 (계약이 바뀌면 이 시험이 실패해서 알려 준다)
test("현재 계약의 빈칸: 송신 가격 줄과 추가 필드를 거부한다", () => {
  const row = { vendor: "aws", region: "ap-northeast-2", sku: "x", unit: "hour", usd: 1, evidence: "fact", source: "t", fetchedAt: "2026-11-01T00:00:00Z", attrs: {} };
  assert.throws(() => PriceRow.parse({ ...row, item: "egress" }), "PriceItem에 egress가 없다");
  assert.throws(() => PriceRow.parse({ ...row, item: "storage", unit: "gb" }), "PriceUnit에 gb가 없다");
  assert.throws(() => Provider.parse("azure"), "Provider는 azure_mock뿐이다");
  assert.throws(() => LoadParams.parse({ source: "sample" }), "LoadParams.source는 preset|measured뿐이다");
  const est = estimateViaKross(request(), teamCatalog(), { breakpoints: false });
  // strict: 필드를 몰래 추가하면 parse가 실패한다. buildCostView는 이때 조용히 미리보기로 내려간다
  assert.equal(CostEstimate.safeParse({ ...est, crossovers: [] }).success, false);
  assert.equal(CostEstimate.safeParse({ ...est, envs: [{ ...est.envs[0], parts: { ...est.envs[0]!.parts, egress: 1 } }] }).success, false);
});

test("같은 요청이 전체 엔진(estimate)으로도 돌아간다", () => {
  const req = CostEstimateRequest.parse(request());
  const pricing = catalogToPricing(teamCatalog(), req.region, ["aws", "gcp", "onprem"], req.load);
  const out = estimate({ profile: profileFromRequest(req), pricing, sizing: { targetUtil: req.load.utilTarget }, traffic: { kind: "constant", lambda: 10 }, from: "aws" });
  assert.equal(out.source, "price-only");
  assert.equal(out.vendors.length, 3);
  assert.ok(out.vendors.every((v) => v.unknownItems.includes("egress")), "송신 가격이 없다는 사실이 출력에 남는다");
});
