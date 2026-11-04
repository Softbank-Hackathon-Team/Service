// DB 시험 (I8api): GET /migrations/:id/spec 이 spec_v2 가 있는 판에 specV2·fieldMetaV2 를 같이 돌려준다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;
// 가져오기 판 한 줄 (import.ts 와 같은 순서: normalizeV2 → checkV2 reviews)
let V2: { spec: unknown; fieldMeta: Record<string, unknown>; specV2: Record<string, any> };

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const adapters = await import("@svc/adapters");
  const contracts = await import("@svc/contracts");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { specRoutes } = await import("../src/routes/spec.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  const { result } = adapters.normalizeV2(adapters.DEMO_INVENTORY.gcp!);
  // G3c-5: 가져오기와 같은 함수로 검토 줄(내용 키 check.*)을 붙인다
  result.fieldMeta = contracts.syncCheckReviews(result.fieldMeta, contracts.checkV2Reviews(result.spec));
  // 평문 비밀로 뺀 env 하나 (가져오기 maskPlainSecrets 와 같은 모양): 검토 표시
  result.fieldMeta["components.shop-api.env.API_TOKEN"] = { source: "source.env", confidence: 0.6, needs_review: true, rationale: "평문 비밀" };
  const stored = contracts.ImportResultV2.parse(result);
  V2 = { spec: {}, fieldMeta: {}, specV2: stored as unknown as Record<string, any> };
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-i8api'), ($2,'test-i8api-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(specRoutes, { prefix: P });
  await app.register(planRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed(withV2 = true, tenant = T) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'gcp','gke','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, tenant]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`,
    [id, tenant, src, dst]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,$3,$4,$5)`,
    [tenant, id, V2.spec, V2.fieldMeta, withV2 ? V2.specV2 : null]);
  return id;
}
const get = (id: string, tenant = T) => app.inject({ method: "GET", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": tenant } });

test("v2 가져오기 판 → specV2·fieldMetaV2 가 같이 오고 unmapped·ids 는 안 온다", { skip }, async () => {
  const r = await get(await seed());
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.deepEqual(b.specV2, JSON.parse(JSON.stringify(V2.specV2.spec)));
  assert.deepEqual(b.fieldMetaV2, V2.specV2.fieldMeta);
  assert.ok(b.specV2.components.length > 0);
  assert.ok(!("unmapped" in b) && !("ids" in b) && !("environment" in b));
  assert.ok(!("unmapped" in b.specV2) && !("ids" in b.specV2));
  assert.ok(Array.isArray(b.needsReviewV2) && b.needsReviewV2.length > 0, "기존 needsReviewV2 도 그대로");
  assert.equal(b.complete, true);
});

test("예전 판(spec_v2 NULL) → 409 SPEC_INVALID, 본문에 명세 값 없음", { skip }, async () => {
  const r = await get(await seed(false));
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "SPEC_INVALID");
  assert.ok(!r.body.includes("shop-api"));
});

test("남의 회사 이전 → 404", { skip }, async () => {
  const id = await seed();
  assert.equal((await get(id, OTHER)).statusCode, 404);
});

test("PATCH 응답에도 새 판의 specV2 가 들어 있다 (GET 과 같은 모양)", { skip }, async () => {
  const id = await seed();
  const p = await app.inject({ method: "PATCH", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": T },
    payload: { baseVersion: 1, changes: [{ path: "components.shop-api.replicas", value: { min: 3, max: 6 } }] } });
  assert.equal(p.statusCode, 200, p.body);
  assert.deepEqual(p.json().specV2.components.find((c: { id: string }) => c.id === "shop-api").props.replicas, { min: 3, max: 6 });
  assert.deepEqual((await get(id)).json(), p.json());
});

test("spec_v2 가 AppSpecV2 모양이 아니면 409 SPEC_INVALID (500 아님)", { skip }, async () => {
  const id = await seed();
  await owner.query("UPDATE spec_versions SET spec_v2 = jsonb_set(spec_v2, '{spec}', '{\"x\":1}') WHERE migration_id=$1", [id]);
  const r = await get(id);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "SPEC_INVALID");
});
