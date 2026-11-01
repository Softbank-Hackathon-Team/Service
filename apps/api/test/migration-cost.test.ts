// 작업 Z2: GET /migrations/:id/cost (DB 없이, 읽기 함수를 바꿔 끼워 시험)
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { estimateCost, loadSampleCatalog } from "@svc/cost";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import {
  buildCostView, DEMO_SPEC, MigrationCostView, migrationCostRoutes, pairDelta, previewRequest,
  type CostLoader,
} from "../src/routes/migration-cost.js";

const T = "11111111-1111-4111-8111-111111111111";
const M = "44444444-4444-4444-8444-444444444444";
const SRC = { id: "22222222-2222-4222-8222-222222222222", provider: "aws" as const, name: "dev-aws" };
const DST = { id: "33333333-3333-4333-8333-333333333333", provider: "gcp" as const, name: "dev-gcp" };
const H = { "x-dev-tenant": T };

// 샘플 가격표(캐시 없음) + PoC 노드 → 설계 초안 숫자 AWS 227.5 / GCP 146.9 / 온프레 250
const sampleEstimate = () => estimateCost(
  { ...previewRequest(DEMO_SPEC, "aws"), nodeSkus: ["t3.medium", "e2-medium", "k3s-vm-2c8g", "Standard_B2s"] },
  loadSampleCatalog());

test("pairDelta: 출발 aws → 도착 gcp 차이와 크레딧 몫 (샘플 가격, PoC 숫자)", () => {
  const d = pairDelta(sampleEstimate(), "aws", "gcp");
  assert.equal(d.sourceMonthlyUsd, 227.5);
  assert.equal(d.targetMonthlyUsd, 146.9);
  assert.equal(d.monthlyUsd, 80.6);
  assert.equal(d.creditPortionUsd, 73);
});

test("pairDelta: 도착이 더 비싸면 음수, 계산 불가 환경이면 null", () => {
  const est = sampleEstimate();
  assert.equal(pairDelta(est, "gcp", "onprem").monthlyUsd, -103.1);
  const broken = { ...est, envs: est.envs.map((e) => e.provider === "gcp" ? { ...e, feasible: false, monthlyUsd: null } : e) };
  assert.equal(pairDelta(broken, "aws", "gcp").monthlyUsd, null);
});

test("buildCostView: 저장된 추정이 있으면 그대로(stored), 모양이 깨지면 미리보기로", () => {
  const est = sampleEstimate();
  const stored = buildCostView({
    migrationId: M, source: SRC, target: DST, spec: null,
    stored: { id: "55555555-5555-4555-8555-555555555555", planId: null, estimate: est, priceSources: [], createdAt: "2026-10-31T16:00:00.000Z" },
  });
  assert.equal(stored.origin, "stored");
  assert.deepEqual(stored.estimate, est);
  assert.equal(stored.pair.monthlyUsd, 80.6);

  const fallback = buildCostView({
    migrationId: M, source: SRC, target: DST, spec: { nope: true },
    stored: { id: "55555555-5555-4555-8555-555555555555", planId: null, estimate: { bad: 1 }, priceSources: [], createdAt: "x" },
  });
  assert.equal(fallback.origin, "preview");
  assert.equal(fallback.specFrom, "demo");
  // 미리보기는 네 환경 전부
  assert.deepEqual(fallback.estimate.envs.map((e) => e.provider).sort(), ["aws", "azure_mock", "gcp", "onprem"]);
});

async function appWith(load: CostLoader) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(migrationCostRoutes, { prefix: "/api/v1", load });
  return app;
}

test("경로: 200 + 계약 모양, 회사 번호를 읽기 함수에 넘긴다", async () => {
  let seen = "";
  const app = await appWith(async (t) => { seen = t; return { migrationId: M, source: SRC, target: DST, stored: null, spec: DEMO_SPEC }; });
  const res = await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/cost`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.equal(seen, T);
  const v = MigrationCostView.parse(res.json());
  assert.equal(v.origin, "preview");
  assert.equal(v.specFrom, "spec_versions");
  assert.equal(v.pair.from, "aws");
  assert.equal(v.pair.to, "gcp");
  await app.close();
});

test("경로 거부: 헤더 없음 401, 잘못된 번호 400, 없는(남의) 이전 404", async () => {
  const app = await appWith(async () => null);
  const u = `/api/v1/migrations/${M}/cost`;
  assert.equal((await app.inject({ method: "GET", url: u })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/migrations/nope/cost", headers: H })).statusCode, 400);
  const nf = await app.inject({ method: "GET", url: u, headers: H });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.json().code, "NOT_FOUND");
  await app.close();
});
