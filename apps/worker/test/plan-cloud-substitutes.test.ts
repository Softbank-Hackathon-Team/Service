// 클라우드 → 클라우드 계획서: 관리형 캐시·큐·버킷·DB 가 다른 상품이 되면 자원마다 substitute 확인 항목 (계획 작업이 부르는 buildPlanDoc 그대로)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlanCostSummary, Provider } from "@svc/contracts";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { SUBSTITUTE_SPEC } from "./substitute-fixture.js";

const cost: PlanCostSummary = { currency: "USD", monthlyTarget: 80, monthlySource: 100, deltaMonthly: -20, unknownFields: [] };
const plan = (source: Provider, target: Provider) => buildPlanDoc({
  planId: "7f000000-0000-4000-8000-0000000000c3", migrationId: "4a8c0000-0000-4000-8000-0000000000c3", spec: SUBSTITUTE_SPEC,
  target: { envId: "33333333-3333-4333-8333-333333333333", provider: target, region: "default" },
  precheck: [], now: new Date("2026-11-07T00:00:00Z"), source: { provider: source }, costSummary: cost,
}, {});
const substitutes = (source: Provider, target: Provider) => (plan(source, target).acknowledgements ?? []).filter((a) => a.kind === "substitute");

test("AWS→GCP 계획서: 캐시·큐·버킷·DB 마다 substitute:<id> 항목, 출발·도착 상품과 앱 코드 변경 여부를 싣는다", () => {
  const acks = substitutes("aws", "gcp");
  assert.deepEqual(acks.map((a) => [a.id, a.from, a.to, a.appChange]), [
    ["substitute:shop-assets", "S3", "Cloud Storage", true],
    ["substitute:shop-cache", "ElastiCache (redis)", "Memorystore (redis)", false],
    ["substitute:shop-db", "RDS for PostgreSQL", "Cloud SQL for PostgreSQL", false],
    ["substitute:shop-orders", "SQS FIFO", "Pub/Sub 토픽 + 구독", true],
  ]);
  const cache = acks.find((a) => a.id === "substitute:shop-cache")!;
  assert.deepEqual(cache.lost?.map((x) => x.replace(/ \(.*$/, "")), ["AUTH 비밀번호", "TLS 서버 CA 인증서", "캐시 데이터"]);
  assert.match(cache.text, /^ElastiCache \(redis\) → Memorystore \(redis\) · 옮기지 못하는 것: AUTH/);
});

test("GCP→AWS 계획서: 같은 자원이 반대 방향 상품으로", () => {
  assert.deepEqual(substitutes("gcp", "aws").map((a) => [a.id, a.from, a.to, a.appChange]), [
    ["substitute:shop-assets", "Cloud Storage", "S3", true],
    ["substitute:shop-cache", "Memorystore (redis)", "ElastiCache (redis)", false],
    ["substitute:shop-db", "Cloud SQL for PostgreSQL", "RDS for PostgreSQL", false],
    ["substitute:shop-orders", "Pub/Sub 토픽 + 구독", "SQS FIFO", true],
  ]);
});

test("같은 클라우드 계획서에는 substitute 항목이 없다", () => {
  for (const p of ["aws", "gcp"] as const) assert.deepEqual(substitutes(p, p), [], p);
});
