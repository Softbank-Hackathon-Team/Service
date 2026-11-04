// VBOUNDARY: spec_v2.outOfBoundary 가 PATCH·confirm 으로 새 판이 생겨도 유지되는지, 남의 회사에서는 안 보이는지
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
const OOB = [{ resource: "s3.bucket:acme-terraform-state", kind: "objectStore", reason: "이 앱의 서비스·잡이 env·비밀·IAM 근거로 닿지 않음" }];
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vboundary'), ($2,'test-vboundary-other')", [T, OTHER]);
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
    [tenant, id, V2.spec, V2.fieldMeta, withV2 ? { ...V2.specV2, outOfBoundary: OOB } : null]);
  return id;
}
const patch = (id: string, payload: unknown, tenant = T) => app.inject({
  method: "PATCH", url: `${P}/migrations/${id}/spec`, payload: payload as object, headers: { "x-dev-tenant": tenant } });
const versions = async (id: string) => (await owner.query(
  "SELECT version, spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version", [id])).rows;
const svc = (v2: any, cid: string) => v2.spec.components.find((c: { id: string }) => c.id === cid);

const get = async (id: string) => (await app.inject({ method: "GET", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": T } })).json();
const plan = (id: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/plan`, payload: {}, headers: { "x-dev-tenant": T } });

const oob = async (id: string) => (await versions(id)).map((v) => v.spec_v2?.outOfBoundary);

test("PATCH(changes)·confirm 으로 새 판이 생겨도 outOfBoundary 는 그대로 이어진다", { skip }, async () => {
  const id = await seed();
  const r1 = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.replicas", value: { min: 2, max: 2 } }] });
  assert.equal(r1.statusCode, 200, r1.body);
  const r2 = await patch(id, { baseVersion: 2, confirm: ["components.shop-cleanup.probes"] });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.deepEqual(await oob(id), [OOB, OOB, OOB]);
});

test("거부된 PATCH(origin·낡은 baseVersion)는 outOfBoundary 를 건드리지 않고 판도 안 만든다", { skip }, async () => {
  const id = await seed();
  assert.equal((await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.origin", value: { runtime: "k8s", product: "k8s" } }] })).statusCode, 400);
  assert.equal((await patch(id, { baseVersion: 9, changes: [{ path: "components.shop-api.replicas", value: { min: 2, max: 2 } }] })).statusCode, 409);
  assert.deepEqual(await oob(id), [OOB]);
});

test("남의 회사 이전의 spec 보기·PATCH → 404 (outOfBoundary 가 새지 않는다)", { skip }, async () => {
  const id = await seed(true, OTHER);
  const g = await app.inject({ method: "GET", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": T } });
  assert.equal(g.statusCode, 404);
  assert.ok(!g.body.includes("acme-terraform-state"));
  assert.equal((await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.replicas", value: { min: 2, max: 2 } }] }, T)).statusCode, 404);
});

test("옛 판(outOfBoundary 칸 없음)도 PATCH 가 그대로 통과하고 칸을 만들어 내지 않는다", { skip }, async () => {
  const id = await seed();
  await owner.query("UPDATE spec_versions SET spec_v2 = spec_v2 - 'outOfBoundary' WHERE migration_id=$1", [id]);
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.replicas", value: { min: 2, max: 2 } }] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual((await versions(id)).map((v) => "outOfBoundary" in v.spec_v2), [false, false]);
});

