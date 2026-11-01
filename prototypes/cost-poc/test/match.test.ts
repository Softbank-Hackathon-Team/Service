import assert from "node:assert/strict";
import { test } from "node:test";
import { hourlyCost, HOURS_PER_MONTH } from "../src/core/cost.js";
import { monthlyCost } from "../src/core/monthly.js";
import { makeResourceFn, vendorResources } from "../src/core/resource.js";
import { ResourceProfile, Sizing, Traffic, VendorPricing } from "../src/core/types.js";
import type { PriceFile } from "../src/collect/types.js";
import { DEFAULT_ONPREM, onpremLines } from "../src/collect/onprem.js";
import { fileToPricing, loadPriceFiles, loadPricing, reservedCpuAks, reservedCpuTiered, reservedMemAks, reservedMemEks, reservedMemGke } from "../src/match.js";
import { approx } from "./helpers.js";

// 수집일 2026-11-01 가격을 손으로 옮겨 검산한다. 가격을 다시 모아 값이 바뀌면 이 시험도 함께 고친다.
const pricing = () => loadPricing({ nodeDiskGB: 50 }).map((p) => VendorPricing.parse(p));
const idle = makeResourceFn(ResourceProfile.parse({ source: "price-only", points: [{ lambda: 0, cpu: 0, memGiB: 0, egressGBh: 0, storageGB: 20, dbCpu: 0, dbMemGiB: 0 }] }));
const sizing = Sizing.parse({ cpuRequestFloor: 0.5, memRequestFloorGiB: 1, systemCpu: 0.2, systemMemGiB: 0.5, targetUtil: 0.6, dbTargetUtil: 0.6 });
const flat = Traffic.parse({ kind: "constant", lambda: 0 });

test("손 검산: 서울 공개 가격으로 빈 앱의 월 비용", () => {
  const p = pricing();
  const month = (v: string) => monthlyCost(p.find((x) => x.vendor === v)!, idle, sizing, flat);
  // AWS: EKS 0.10 x 730 = 73, t3.medium 2대 2 x (0.052 + 50 x 0.0912/730) x 730 = 2 x (37.96 + 4.56) = 85.04,
  //      db.t3.medium 0.112 x 730 = 81.76, gp3 20 x 0.131 = 2.62 → 242.42
  const aws = month("aws");
  assert.equal(aws.nodeSku, "t3.medium"); assert.equal(aws.dbSku, "db.t3.medium");
  assert.ok(approx(aws.totalUsd, 73 + 85.04 + 81.76 + 2.62, 1e-6), `${aws.totalUsd}`);
  // GCP: GKE 73, e2-medium 2 x (0.04298286 x 730 + 50 x 0.13) = 2 x (31.3774878 + 6.5) = 75.7549756,
  //      Cloud SQL 2 vCPU 4 GiB (2 x 0.0537 + 4 x 0.0091) x 730 = 0.1438 x 730 = 104.974, SSD 20 x 0.221 = 4.42 → 258.1489756
  const gcp = month("gcp");
  assert.equal(gcp.nodeSku, "e2-medium");
  assert.ok(approx(gcp.totalUsd, 73 + 75.7549756 + 104.974 + 4.42, 1e-6), `${gcp.totalUsd}`);
  // Azure: AKS 73, B2s 2 x (0.052 x 730 + 50 x 0.075) = 2 x (37.96 + 3.75) = 83.42,
  //        PG B2s 0.104 x 730 = 75.92, 스토리지 20 x 0.18225 = 3.645 → 235.985
  const az = month("azure");
  assert.equal(az.nodeSku, "Standard_B2s");
  assert.ok(approx(az.totalUsd, 73 + 83.42 + 75.92 + 3.645, 1e-6), `${az.totalUsd}`);
  // 온프레: 서버 2대 + 회선·운영. 서버 1대 = 15000/60 = 250 + 전기 0.35 x 1.54 x 182/1430 x 730 + 상면 2 x 70000/1430
  const server = 250 + 0.35 * 1.54 * (182 / 1430) * 730 + (2 * 70000) / 1430;
  const line = 1000000 / 1430 + (0.25 * 80000000) / 1430 / 12;
  const prem = month("onprem");
  assert.ok(Math.abs(prem.totalUsd - (2 * server + line)) < 0.01, `${prem.totalUsd} vs ${2 * server + line}`);
});

test("손 검산: 할당 가능량 공식", () => {
  // GKE e2-standard-2: CPU 6% + 1% = 0.07, 메모리 25% x 4 + 20% x 4 + 100MiB = 1.8 + 0.09765625
  assert.ok(approx(reservedCpuTiered(2), 0.07));
  assert.ok(approx(reservedMemGke(8), 1.8 + 100 / 1024));
  assert.ok(approx(reservedCpuTiered(8), 0.06 + 0.01 + 0.01 + 0.01));
  // AKS D2s_v5: CPU 100m, 메모리 min(650MB, 2GB) + 100MiB
  assert.equal(reservedCpuAks(2), 0.1);
  assert.ok(approx(reservedMemAks(8), 0.65 + 100 / 1024));
  assert.ok(approx(reservedMemAks(2), 0.5 + 100 / 1024), "작은 노드는 25% 쪽이 작다");
  // EKS m6i.large: 11 x 29 + 255 + 100 = 674 MiB
  assert.ok(approx(reservedMemEks("m6i.large"), 674 / 1024));
  assert.ok(approx(reservedMemEks("t3.medium"), (11 * 17 + 355) / 1024));
});

test("매칭: 버스터블은 지속 용량이 낮고 요청량 용량은 그대로다", () => {
  const aws = pricing().find((p) => p.vendor === "aws")!;
  const t3 = aws.nodeTypes.find((t) => t.sku === "t3.medium")!;
  assert.equal(t3.capacity.cpu, 0.4);
  assert.ok(approx(t3.capacity.cpuRequested!, 2 - 0.07));
  const m6 = aws.nodeTypes.find((t) => t.sku === "m6i.large")!;
  assert.ok(approx(m6.capacity.cpu, 2 - 0.07));
  // 지속 사용량이 커지면 t3가 탈락한다: cpu 2 vCPU → t3 5대(0.26) vs m6i 2대(약 0.25)
  const f = makeResourceFn(ResourceProfile.parse({ source: "measured", points: [{ lambda: 1, cpu: 1.2, memGiB: 0.2, egressGBh: 0, storageGB: 20, dbCpu: 0, dbMemGiB: 0 }] }));
  const c = hourlyCost(aws, vendorResources(f, aws, Sizing.parse({ targetUtil: 0.6, dbTargetUtil: 0.6 }), 1));
  assert.notEqual(c.nodeSku, "t3.medium");
});

test("매칭: 옵션이 가격에 반영된다", () => {
  const base = loadPricing({ nodeDiskGB: 0 }).map((p) => VendorPricing.parse(p));
  const commit = loadPricing({ nodeDiskGB: 0, useCommit1y: true }).map((p) => VendorPricing.parse(p));
  const nat = loadPricing({ nodeDiskGB: 0, includeNat: true }).map((p) => VendorPricing.parse(p));
  const noB = loadPricing({ nodeDiskGB: 0, excludeBurstable: true }).map((p) => VendorPricing.parse(p));
  const a = (xs: VendorPricing[]) => xs.find((p) => p.vendor === "aws")!;
  assert.equal(a(base).nodeTypes.find((t) => t.sku === "m6i.large")!.hourly, 0.118);
  assert.equal(a(commit).nodeTypes.find((t) => t.sku === "m6i.large")!.hourly, 0.07718);
  assert.ok(a(nat).fixedHourly > a(base).fixedHourly);
  assert.ok(a(nat).egressPerGB > a(base).egressPerGB);
  assert.ok(!a(noB).nodeTypes.some((t) => t.sku.startsWith("t3.")));
  assert.equal(a(base).egressPerGB, 0.126);
  assert.deepEqual(a(base).egressTiers.slice(0, 2), [{ fromGB: 0, usdPerGB: 0 }, { fromGB: 100, usdPerGB: 0.126 }]);
  const gcp = base.find((p) => p.vendor === "gcp")!;
  assert.equal(gcp.egressPerGB, 0.19);
});

test("가격 파일: 줄마다 출처와 수집일, 온프레는 전부 가정", () => {
  const files = loadPriceFiles() as PriceFile[];
  for (const f of files) {
    assert.ok(f.lines.length > 0, f.vendor);
    assert.deepEqual(f.missing, [], `${f.vendor} 빠진 항목`);
    for (const l of f.lines) {
      assert.ok(l.sourceUrl && l.sourceDetail && l.fetchedAt, `${l.vendor}/${l.sku}`);
      assert.ok(["public", "public-secondary", "assumed"].includes(l.evidence));
    }
  }
  assert.ok(onpremLines(DEFAULT_ONPREM, new Date(0)).every((l) => l.evidence === "assumed"));
  assert.ok(files.find((f) => f.vendor === "onprem")!.lines.every((l) => l.evidence === "assumed"));
  assert.ok(files.find((f) => f.vendor === "aws")!.lines.every((l) => l.evidence === "public"));
});

test("단위: 730시간 기준이 팀 HOURS_PER_MONTH와 같다", async () => {
  const team = await import("@svc/cost");
  assert.equal(team.HOURS_PER_MONTH, HOURS_PER_MONTH);
});
