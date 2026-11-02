// DB 시험 TA11: GET /migrations/:id/plan/resources·/environments/:id/inventory 의 "생길 자원"이 v2 계획서면 v2 Builder 기준
//   spec_v2 칸(0023)이 없는 DB 에서도 SQL 이 안 깨짐(to_jsonb). 칸이 있는 경우는 이 파일 전용 DB 에 칸을 더해서 본다(TEST_DB_ISOLATE)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { upconvertV1 } from "@svc/contracts";
import { DEMO_SPEC } from "@svc/adapters";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER || process.env.TEST_DB_ISOLATE !== "1" ? "DATABASE_URL / OWNER_DATABASE_URL / TEST_DB_ISOLATE 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();
const SPEC = { ...DEMO_SPEC, database: { engine: "postgres", majorVersion: "16", storageGb: 20 } };

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { envInventoryRoutes } = await import("../src/routes/env-inventory.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-ta11'), ($2,'test-ta11-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(envInventoryRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
});

async function seed(planIr: string | null) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'gcp','s','connected'), ($2,$3,'onprem','o','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'approved')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta) VALUES ($1,$2,1,$3,'{}')`, [T, id, SPEC]);
  const planId = randomUUID();
  const doc = { planId, migrationId: id, adapterVersion: "t", steps: [], precheck: [], rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: "tf", helmValuesHash: "h", planHash: `h-${planId}`, expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...(planIr ? { irVersion: planIr } : {}) };
  await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [planId, T, id, doc, doc.planHash, doc.expiresAt]);
  return { id, dst };
}
const types = async (envId: string, h = T) => {
  const r = await app.inject({ method: "GET", url: `${P}/environments/${envId}/inventory`, headers: { "x-dev-tenant": h } });
  return { code: r.statusCode, types: r.statusCode === 200 ? (r.json().apps ?? []).flatMap((m: { resources: { type: string }[] }) => m.resources.map((x) => x.type)) as string[] : [] };
};

test("정상: spec_v2 칸이 없는 DB(0023 전) — irVersion 2 계획서여도 SQL 이 안 깨지고 v1 종류 그대로", { skip }, async () => {
  const { dst } = await seed("2");
  const r = await types(dst);
  assert.equal(r.code, 200);
  assert.ok(r.types.includes("postgresql.cnpg.io/clusters"));
  assert.ok(!r.types.includes("batch/cronjobs"));
});

test("정상: spec_v2 칸이 있고 판에 v2 명세(잡 포함) + irVersion 2 → v2 종류(CronJob), irVersion 없으면 v1", { skip }, async () => {
  await owner.query("ALTER TABLE spec_versions ADD COLUMN IF NOT EXISTS spec_v2 jsonb");
  const v2 = upconvertV1(SPEC as never).spec;
  v2.components.push({ id: "nightly", kind: "job", props: { image: { source: "registry", repository: "r/x", digest: "sha256:" + "1".repeat(64) },
    resources: {}, env: [], serviceAccount: "default", schedule: "0 3 * * *" } });
  for (const [ir, want] of [["2", true], [null, false]] as const) {
    const { id, dst } = await seed(ir);
    await owner.query("UPDATE spec_versions SET spec_v2 = $2 WHERE migration_id = $1", [id, { spec: v2, fieldMeta: {}, unmapped: [], ids: {} }]);
    const r = await types(dst);
    assert.equal(r.code, 200);
    assert.equal(r.types.includes("batch/cronjobs"), want, `irVersion=${ir}`);
  }
});

test("거부: 남의 회사 환경은 404", { skip }, async () => {
  const { dst } = await seed("2");
  assert.equal((await types(dst, OTHER)).code, 404);
});
