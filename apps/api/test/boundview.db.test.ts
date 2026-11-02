// BOUNDVIEW: GET /migrations/:id/spec 응답에 spec_v2.outOfBoundary 를 싣는다 (없으면 키 없음)
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
// 가져오기 v2 판 한 줄 (import.ts importV2 와 같은 순서: normalizeV2 → checkV2 reviews → projectV1)
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
  const { result, projectionEnv } = adapters.normalizeV2(adapters.DEMO_INVENTORY_V2.gcp!);
  contracts.checkV2(result.spec).reviews.forEach((r, i) => {
    result.fieldMeta[`check.reviews[${i}]`] = { source: "checkV2", confidence: 0.6, needs_review: true, rationale: r }; });
  // 평문 비밀로 뺀 env 하나 (가져오기 maskPlainSecrets 와 같은 모양): v2 · v1 둘 다 검토 표시
  result.fieldMeta["components.shop-api.env.API_TOKEN"] = { source: "source.env", confidence: 0.6, needs_review: true, rationale: "평문 비밀" };
  const stored = contracts.ImportResultV2.parse(result);
  const v1 = adapters.projectV1(stored, projectionEnv);
  V2 = { spec: v1.spec, fieldMeta: { ...v1.fieldMeta, "service.env.API_TOKEN": { source: "source.env", confidence: 0.6, needs_review: true } },
         specV2: stored as unknown as Record<string, any> };
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-boundview'), ($2,'test-boundview-other')", [T, OTHER]);
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


const view = async (id: string, tenant = T) => app.inject({ method: "GET", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": tenant } });
const setOob = (id: string, v: unknown) => owner.query("UPDATE spec_versions SET spec_v2 = jsonb_set(spec_v2, '{outOfBoundary}', $2::jsonb) WHERE migration_id=$1", [id, JSON.stringify(v)]);

test("있음: v2 판의 outOfBoundary 가 GET 응답에 그대로 (이름·종류·이유만, 값 없음)", { skip }, async () => {
  const id = await seed();
  const r = await view(id);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().outOfBoundary, OOB);
  assert.ok(!r.body.includes("arn:"));
});

test("PATCH 응답과 그 뒤 GET 에도 실린다 (새 판이 생겨도)", { skip }, async () => {
  const id = await seed();
  const p = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.replicas", value: { min: 2, max: 2 } }] });
  assert.equal(p.statusCode, 200, p.body);
  assert.deepEqual(p.json().outOfBoundary, OOB);
  assert.deepEqual((await view(id)).json().outOfBoundary, OOB);
});

test("빈 배열은 빈 배열 그대로(경계를 계산했고 밖이 없음) — 키 없음과 구별", { skip }, async () => {
  const id = await seed();
  await setOob(id, []);
  const j = (await view(id)).json();
  assert.ok("outOfBoundary" in j);
  assert.deepEqual(j.outOfBoundary, []);
});

test("없음: 칸 없는 옛 v2 판 · v1 판(spec_v2 NULL)은 키 자체가 없다", { skip }, async () => {
  const old = await seed();
  await owner.query("UPDATE spec_versions SET spec_v2 = spec_v2 - 'outOfBoundary' WHERE migration_id=$1", [old]);
  const a = await view(old);
  assert.equal(a.statusCode, 200);
  assert.ok(!("outOfBoundary" in a.json()));
  assert.ok("specV2" in a.json(), "v2 나머지는 그대로");
  const v1 = await seed(false);
  const b = (await view(v1)).json();
  assert.ok(!("outOfBoundary" in b) && !("specV2" in b));
});

test("거부 경계: 모양이 깨진 outOfBoundary(모르는 칸·모르는 종류·배열 아님)는 키를 빼고 200 — 명세 본체는 막지 않는다", { skip }, async () => {
  for (const bad of [[{ ...OOB[0], arn: "arn:aws:s3:::x" }], [{ ...OOB[0], kind: "nope" }], { not: "array" }, "x"]) {
    const id = await seed();
    await setOob(id, bad);
    const r = await view(id);
    assert.equal(r.statusCode, 200, JSON.stringify(bad) + r.body);
    assert.ok(!("outOfBoundary" in r.json()), JSON.stringify(bad));
    assert.ok(!r.body.includes("arn:aws:s3:::x"), "깨진 값은 그대로 새지 않는다");
  }
});

test("남의 회사 이전 → 404, 경계 밖 이름이 응답에 없다", { skip }, async () => {
  const id = await seed(true, OTHER);
  const r = await view(id, T);
  assert.equal(r.statusCode, 404);
  assert.ok(!r.body.includes("acme-terraform-state"));
  assert.equal((await view(id, OTHER)).statusCode, 200);
});
