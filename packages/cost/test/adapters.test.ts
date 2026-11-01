import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AWS_SEOUL_RULES, GCP_SEOUL_RULES, AZURE_KOREA_RULES, createAwsPriceSource, createGcpPriceSource,
  createAzurePriceSource, loadSampleCatalog, parseGcpPage, refreshCatalog, PriceRow,
  type PriceSource,
} from "../src/index.js";
import { fixture } from "./helpers.js";

const now = new Date("2026-11-01T00:00:00Z");

test("AWS GetProducts: 두 페이지를 따라가고 Linux t3.medium, EKS, gp3만 남긴다", async () => {
  const pages: Record<string, unknown> = {
    first: fixture("aws-getproducts-page1"), page2: fixture("aws-getproducts-page2"),
  };
  const src = createAwsPriceSource({ fetchPage: async (t) => pages[t ?? "first"], rules: AWS_SEOUL_RULES });
  const rows = (await src.fetchRows("ap-northeast-2", now)).map((r) => PriceRow.parse(r));
  assert.deepEqual(rows.map((r) => [r.item, r.sku, r.unit, r.usd]), [
    ["node", "t3.medium", "hour", 0.052],
    ["cluster", "eks-standard", "hour", 0.1],
    ["storage", "rds-gp3", "gb_month", 0.131],
  ]);
});

test("GCP skus: 서울·온디맨드만, nanos를 달러로, 계단 두 줄", () => {
  const rows = parseGcpPage(fixture("gcp-skus") as never, GCP_SEOUL_RULES, "asia-northeast3",
    now.toISOString()).map((r) => PriceRow.parse(r));
  assert.deepEqual(rows.map((r) => [r.sku, r.usd, r.tierFrom]), [
    ["e2-medium", 0.043, 0],
    ["cloudsql-ssd", 0, 0],
    ["cloudsql-ssd", 0.221, 10],
  ]);
});

test("Azure Retail: Linux 소비 가격만, evidence는 mock", async () => {
  const src = createAzurePriceSource({ fetchPage: async () => fixture("azure-retail"), rules: AZURE_KOREA_RULES });
  const rows = await src.fetchRows("koreacentral", now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.usd, 0.0496);
  assert.equal(rows[0]!.evidence, "mock");
});

test("가격 새로 받기: 실패한 벤더는 어제 값 유지, 성공한 줄만 교체", async () => {
  const prev = loadSampleCatalog();
  const okGcp = createGcpPriceSource({ fetchPage: async () => fixture("gcp-skus") });
  const failAws = createAwsPriceSource(); // STUB fetcher -> 던짐
  const { catalog, report } = await refreshCatalog(prev, [failAws, okGcp], "ap-northeast-2", now);
  assert.deepEqual(report.map((r) => [r.vendor, r.ok]), [["aws", false], ["gcp", true]]);
  assert.match(report[0]!.error ?? "", /STUB/);
  assert.equal(catalog.asOf, now.toISOString());
  const aws = (sku: string) => catalog.rows.filter((r) => r.vendor === "aws" && r.sku === sku);
  assert.deepEqual(aws("t3.medium"), prev.rows.filter((r) => r.vendor === "aws" && r.sku === "t3.medium"));
  const ssd = catalog.rows.filter((r) => r.sku === "cloudsql-ssd");
  assert.equal(ssd.length, 2);
  assert.ok(ssd.every((r) => r.evidence === "fact"));
  // 못 받은 GCP DB 줄은 남아 있다
  assert.equal(catalog.rows.filter((r) => r.sku === "cloudsql-pg-2vcpu-4gb").length, 1);
});

test("거부: 모든 벤더가 실패하면 기준일은 그대로", async () => {
  const prev = loadSampleCatalog();
  const none: PriceSource = { vendor: "gcp", fetchRows: async () => [] };
  const { catalog, report } = await refreshCatalog(prev, [none, createAwsPriceSource()], "ap-northeast-2", now);
  assert.equal(catalog.asOf, prev.asOf);
  assert.deepEqual(report.map((r) => r.ok), [false, false]);
  assert.equal(report[0]!.error, "NO_ROWS");
});
