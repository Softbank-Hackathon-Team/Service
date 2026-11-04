// DB 시험 TA11: GET /environments/:id/inventory 의 "생길 자원"은 받아들인 최신 판의 명세(spec_v2) 기준 Builder 로 센다
//   명세가 없는 옛 판이어도 SQL 이 안 깨지고(to_jsonb) 200 (생길 자원은 모름)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AppSpecV2 } from "@svc/contracts";
import { DEMO_SPEC } from "@svc/adapters";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER || process.env.TEST_DB_ISOLATE !== "1" ? "DATABASE_URL / OWNER_DATABASE_URL / TEST_DB_ISOLATE 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();
// 잡 없는 판 (CronJob 이 생기는지로 명세를 읽었는지 본다)
const SPEC: AppSpecV2 = { ...DEMO_SPEC, components: DEMO_SPEC.components.filter((c) => c.kind !== "job") };

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

async function seed(spec: AppSpecV2 | null) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'gcp','s','connected'), ($2,$3,'onprem','o','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'approved')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}','{}',$3)`,
    [T, id, spec ? { spec, fieldMeta: {}, unmapped: [], ids: {} } : null]);
  const planId = randomUUID();
  const doc = { planId, migrationId: id, adapterVersion: "t", steps: [], precheck: [], rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: "tf", helmValuesHash: "h", planHash: `h-${planId}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [planId, T, id, doc, doc.planHash, doc.expiresAt]);
  return { id, dst };
}
const types = async (envId: string, h = T) => {
  const r = await app.inject({ method: "GET", url: `${P}/environments/${envId}/inventory`, headers: { "x-dev-tenant": h } });
  return { code: r.statusCode, types: r.statusCode === 200 ? (r.json().apps ?? []).flatMap((m: { resources: { type: string }[] }) => m.resources.map((x) => x.type)) as string[] : [] };
};

test("정상: 명세 없는 옛 판(spec_v2 NULL)이어도 SQL 이 안 깨지고 200", { skip }, async () => {
  const { dst } = await seed(null);
  const r = await types(dst);
  assert.equal(r.code, 200);
  assert.ok(!r.types.includes("batch/cronjobs"));
});

test("정상: 판의 명세에 잡을 더하면 생길 자원에 CronJob 이 생긴다 (명세를 읽어 센다)", { skip }, async () => {
  const withJob: AppSpecV2 = { ...SPEC, components: [...SPEC.components, { id: "nightly", kind: "job", props: {
    image: { source: "registry", repository: "r/x", digest: "sha256:" + "1".repeat(64) }, resources: {}, env: [], serviceAccount: "default", schedule: "0 3 * * *" } } as never] };
  for (const [spec, want] of [[withJob, true], [SPEC, false]] as const) {
    const { dst } = await seed(spec);
    const r = await types(dst);
    assert.equal(r.code, 200);
    assert.equal(r.types.includes("batch/cronjobs"), want, `job=${want}`);
  }
});

test("거부: 남의 회사 환경은 404", { skip }, async () => {
  const { dst } = await seed(SPEC);
  assert.equal((await types(dst, OTHER)).code, 404);
});
