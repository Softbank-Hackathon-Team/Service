// 작업 Z2: GET /migrations/:id/cost 를 실제 DB(app_user, RLS)로. 실행: npm run test:db
// cost_estimates 표(V 0006)가 있든 없든 돈다: 없으면 미리보기만, 있으면 저장된 추정을 먼저 읽는지까지 본다
import { test, after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { pool, withTenant } from "@svc/core";
import { estimateCost, loadSampleCatalog } from "@svc/cost";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { DEMO_SPEC, MigrationCostView, migrationCostRoutes, previewRequest } from "../src/routes/migration-cost.js";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const H = { "x-dev-tenant": T };
const AWS_ENV = "22222222-2222-4222-8222-222222222222";
const GCP_ENV = "33333333-3333-4333-8333-333333333333";

after(async () => { await pool.end(); });

async function appUp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(migrationCostRoutes);
  return app;
}

async function newMigration(): Promise<string> {
  return withTenant(T, async (tx) => (await tx.query(
    `INSERT INTO migrations (tenant_id, source_env_id, target_env_id) VALUES ($1,$2,$3) RETURNING id`,
    [T, AWS_ENV, GCP_ENV])).rows[0].id);
}

test("DB: 저장된 추정 없으면 미리보기, 남의 회사는 404", async () => {
  const app = await appUp();
  const id = await newMigration();
  const r = await app.inject({ method: "GET", url: `/migrations/${id}/cost`, headers: H });
  assert.equal(r.statusCode, 200, r.body);
  const v = MigrationCostView.parse(r.json());
  assert.equal(v.origin, "preview");
  assert.equal(v.specFrom, "demo");
  assert.deepEqual([v.source.provider, v.target.provider], ["aws", "gcp"]);
  assert.ok(v.pair.monthlyUsd !== null && v.pair.monthlyUsd > 0, "aws → gcp는 아끼는 쪽");
  const other = await app.inject({ method: "GET", url: `/migrations/${id}/cost`, headers: { "x-dev-tenant": OTHER } });
  assert.equal(other.statusCode, 404);
  await app.close();
});

test("DB: cost_estimates 표가 있으면 저장된 추정을 먼저 읽는다 (없으면 건너뜀)", async (t) => {
  const has = (await pool.query(`SELECT to_regclass('public.cost_estimates') AS r`)).rows[0].r;
  if (!has) { t.skip("cost_estimates 표 없음 (V 0006 미적용)"); return; }
  const app = await appUp();
  const id = await newMigration();
  // 샘플 가격(PoC 숫자)으로 저장 → 응답이 캐시 가격(233.3)이 아니라 저장값(227.5)이어야 한다
  const est = estimateCost({ ...previewRequest(DEMO_SPEC, "aws"), nodeSkus: ["t3.medium", "e2-medium", "k3s-vm-2c8g"] }, loadSampleCatalog());
  await withTenant(T, (tx) => tx.query(
    `INSERT INTO cost_estimates (tenant_id, migration_id, request, estimate, price_as_of, price_sources)
     VALUES ($1,$2,$3,$4,$5,'[]')`, [T, id, JSON.stringify({}), JSON.stringify(est), est.priceAsOf]));
  const v = MigrationCostView.parse((await app.inject({ method: "GET", url: `/migrations/${id}/cost`, headers: H })).json());
  assert.equal(v.origin, "stored");
  assert.equal(v.pair.sourceMonthlyUsd, 227.5);
  assert.equal(v.pair.monthlyUsd, 80.6);
  await app.close();
});
