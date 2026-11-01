import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AmbiguousPrice, PriceRow, PriceSourceNotConfigured, createAwsBulkSource, createGcpCatalogSource,
  createOnpremSource, estimateCost, fetchWithCache, fileLines, loadCatalog, loadSampleCatalog,
  parseAwsBulkCsv, parseCsvLine, readCache, summarizePriceSources, writeCache,
  type DetailedPriceSource, type LineSource,
} from "../src/index.js";
import { POC_NODES, spec } from "./helpers.js";

// 네트워크 없이: AWS는 실제 서울 CSV에서 줄 몇 개를 잘라 둔 파일, GCP는 손으로 만든 응답.
const now = new Date("2026-11-01T00:00:00Z");
const fx = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const fixtureLines: LineSource = (url) => {
  const svc = /\/aws\/([A-Za-z0-9]+)\//.exec(url)?.[1];
  return fileLines(fx(`aws-bulk/${svc}.csv`))();
};
const tmp = () => pathToFileURL(`${mkdtempSync(join(tmpdir(), "prices-"))}/`);

test("CSV 한 줄: 따옴표 안 쉼표, 빈 칸, 이스케이프", () => {
  assert.deepEqual(parseCsvLine('"a,b",,"c ""d""",e'), ["a,b", "", 'c "d"', "e"]);
});

test("AWS Bulk: 서울 CSV에서 Linux 온디맨드만, vCPU·메모리는 CSV 열에서", async () => {
  const src = createAwsBulkSource({ lines: fixtureLines });
  const r = await src.fetchDetailed("ap-northeast-2", now);
  const got = (sku: string) => r.rows.find((x) => x.sku === sku);
  assert.equal(got("t3.medium")?.usd, 0.052);
  assert.deepEqual(got("t3.medium")?.attrs, { vcpu: 2, memGiB: 4 });
  assert.equal(got("eks-standard")?.usd, 0.1);         // Outposts 줄은 빠진다
  assert.equal(got("rds-pg-db.t3.medium")?.usd, 0.112); // UnusedBox·Multi-AZ 줄은 빠진다
  assert.equal(got("rds-pg-db.t3.medium")?.unit, "hour");
  assert.equal(got("rds-gp3")?.usd, 0.131);
  assert.equal(got("ebs-gp3")?.usd, 0.0912);
  assert.equal(got("alb")?.usd, 0.0225);
  assert.equal(got("alb-lcu")?.usd, 0.008);
  // 고정 CSV에 없는 노드 종류는 missing으로 알려 준다
  assert.ok(r.missing.includes("node/m6i.xlarge"));
  assert.equal(r.sources.length, 4);
  assert.ok(r.sources.every((s) => s.publishedAt && !s.url.includes("key=")));
  r.rows.forEach((x) => PriceRow.parse(x));
});

test("AWS Bulk 거부: 규칙이 덜 좁아 같은 SKU에 값이 둘이면 AMBIGUOUS_PRICE", async () => {
  const loose = [{ service: "AmazonEC2" as const, item: "node" as const, sku: "t3.medium",
    match: (r: Record<string, string>) => r["Instance Type"] === "t3.medium" }];
  await assert.rejects(
    parseAwsBulkCsv(fixtureLines("/aws/AmazonEC2/x"), loose, "ap-northeast-2", now.toISOString()),
    AmbiguousPrice);
});

test("GCP: 키가 없으면 PRICE_SOURCE_NOT_CONFIGURED (네트워크를 부르지 않음)", async () => {
  const src = createGcpCatalogSource({ apiKey: "" });
  const saved = process.env["GCP_BILLING_API_KEY"];
  delete process.env["GCP_BILLING_API_KEY"];
  try {
    await assert.rejects(src.fetchDetailed("asia-northeast3", now), PriceSourceNotConfigured);
  } finally {
    if (saved !== undefined) process.env["GCP_BILLING_API_KEY"] = saved;
  }
});

test("GCP: E2 core+ram 합산 (e2-medium = vCPU 1개 값 + 4GiB), 서울·온디맨드만", async () => {
  const pages = JSON.parse(readFileSync(fx("gcp-catalog-pages.json"), "utf8")) as Record<string, unknown>;
  const src = createGcpCatalogSource({ fetchPage: async (svc) => pages[svc] as never });
  const r = await src.fetchDetailed("asia-northeast3", now);
  const usd = (sku: string) => r.rows.find((x) => x.sku === sku)?.usd;
  assert.equal(usd("e2-medium"), 0.043);          // 0.028 + 4 x 0.00375
  assert.equal(usd("e2-standard-2"), 0.086);      // 2 x 0.028 + 8 x 0.00375
  assert.equal(usd("e2-standard-4"), 0.172);
  assert.equal(usd("gke-management"), 0.1);       // serviceRegions global도 받는다
  assert.equal(usd("cloudsql-pg-2vcpu-4gb"), 0.134); // 2 x 0.05 + 4 x 0.0085, 시간당
  assert.deepEqual(r.missing, ["storage/cloudsql-ssd"]);
});

test("캐시 폴백: 받기 실패 -> 캐시 읽기, 성공 -> 캐시 쓰기, 둘 다 없으면 원래 오류", async () => {
  const dir = tmp();
  try {
    const failing: DetailedPriceSource = {
      vendor: "onprem",
      fetchRows: async () => { throw new Error("offline"); },
      fetchDetailed: async () => { throw new Error("offline"); },
    };
    await assert.rejects(fetchWithCache(failing, "ap-northeast-2", now, { dir }), /offline/);

    const ok = await fetchWithCache(createOnpremSource(), "ap-northeast-2", now, { dir });
    assert.equal(ok.from, "live");
    assert.equal(readCache("onprem", dir)?.fetchedAt, now.toISOString());

    const back = await fetchWithCache(failing, "ap-northeast-2", new Date(), { dir });
    assert.equal(back.from, "cache");
    assert.equal(back.error, "offline");
    assert.equal(back.rows.find((r) => r.item === "fixed")?.usd, 250);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCatalog: 캐시 줄이 샘플을 덮고, 캐시에 없는 줄(GKE 크레딧)은 샘플 값", () => {
  const dir = tmp();
  try {
    const sample = loadSampleCatalog();
    writeCache({
      vendor: "aws", region: "ap-northeast-2", fetchedAt: now.toISOString(), origin: "live",
      sources: [{ url: "test" }], missing: [],
      rows: [PriceRow.parse({ vendor: "aws", region: "ap-northeast-2", item: "db", sku: "rds-pg-db.t3.medium",
        unit: "hour", usd: 0.112, evidence: "fact", source: "test", fetchedAt: now.toISOString() })],
    }, dir);
    const cat = loadCatalog({ dir });
    assert.equal(cat.asOf, now.toISOString());
    const db = cat.rows.filter((r) => r.sku === "rds-pg-db.t3.medium");
    assert.equal(db.length, 1);
    assert.equal(db[0]!.usd, 0.112);
    assert.equal(cat.rows.filter((r) => r.item === "cluster_credit").length, 1);
    assert.equal(cat.rows.length, sample.rows.length);
    // DB가 시간당이어도 월 금액으로 바꿔 더한다: 0.112 x 730 = 81.76 (화면용 parts는 소수 1자리)
    const e = estimateCost({ spec: spec(), traffic: { peakRps: 10 }, targets: ["aws"], nodeSkus: POC_NODES },
      cat, { breakpoints: false });
    assert.equal(e.envs[0]!.parts.db, 81.8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("저장된 캐시(packages/cost/prices) 그대로: 10 rps AWS $233.3 / GCP $146.9 / 온프레 $250", () => {
  const cat = loadCatalog();
  const e = estimateCost({ spec: spec(), from: "aws", traffic: { peakRps: 10 }, nodeSkus: POC_NODES },
    cat, { breakpoints: false });
  const m = Object.fromEntries(e.envs.map((x) => [x.provider, x.monthlyUsd]));
  assert.deepEqual(m, { aws: 233.3, gcp: 146.9, onprem: 250 });
  assert.equal(readCache("aws")?.origin, "live");
  assert.equal(readCache("gcp")?.origin, "seed");
});

test("출처 요약: 저장된 캐시 기준 aws live / gcp seed / 캐시 없는 azure_mock은 sample", () => {
  const s = Object.fromEntries(summarizePriceSources().map((x) => [x.vendor, x.origin]));
  assert.deepEqual(s, { aws: "live", gcp: "seed", onprem: "live", azure_mock: "sample" });
  assert.ok(summarizePriceSources().every((x) => x.urls.every((u) => !u.includes("key="))));
});
