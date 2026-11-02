// DB 시험 (PA2v2, 계획 26 · A2 v2 분기): 기준 판에 spec_v2 가 있으면 PATCH 는 v2 경로만 받고 rebuildFromV2 로 spec·spec_v2·field_meta 를 같이 쓴다
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-pa2v2'), ($2,'test-pa2v2-other')", [T, OTHER]);
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
const patch = (id: string, payload: unknown, tenant = T) => app.inject({
  method: "PATCH", url: `${P}/migrations/${id}/spec`, payload: payload as object, headers: { "x-dev-tenant": tenant } });
const versions = async (id: string) => (await owner.query(
  "SELECT version, spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version", [id])).rows;
const svc = (v2: any, cid: string) => v2.spec.components.find((c: { id: string }) => c.id === cid);

test("정상: v2 칸 바꿈·확인 → 새 판에 spec·spec_v2·field_meta 같이, v1 검토 0 → POST /plan 202", { skip }, async () => {
  const id = await seed();
  const g = await app.inject({ method: "GET", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": T } });
  assert.equal(g.statusCode, 200, g.body);
  assert.deepEqual(g.json().needsReview, ["service.cpu", "service.env.API_TOKEN", "service.memory"]);
  assert.deepEqual(g.json().needsReviewV2, ["components.shop-api.env.API_TOKEN", "components.shop-cleanup.probes", "components.shop-cleanup.resources"]);

  const r = await patch(id, { baseVersion: 1,
    changes: [{ path: "components.shop-api.replicas", value: { min: 3, max: 6 } }],
    confirm: ["components.shop-api.resources", "components.shop-api.env.API_TOKEN", "components.shop-cleanup.probes", "components.shop-cleanup.resources"] });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.version, 2);
  assert.deepEqual(b.needsReview, [], "v2 확인이 v1 field_meta 에도 남음 (단계 올림 cpu·memory, 평문 비밀 env)");
  assert.deepEqual(b.needsReviewV2, []);

  const [, v] = await versions(id);
  assert.deepEqual(svc(v.spec_v2, "shop-api").props.replicas, { min: 3, max: 6 });
  assert.deepEqual(v.spec_v2.fieldMeta["components.shop-api.replicas"], { source: "human", confidence: 1, needs_review: false });
  assert.ok(v.spec.service.replicas >= 3 && v.spec.service.replicas <= 6, "v1 replicas 는 rebuildFromV2 가 v2 범위로 다시 뽑음");
  assert.equal(v.field_meta["service.replicas"].source, "spec_v2.replicas");
  assert.equal(v.field_meta["service.cpu"].needs_review, false);
  assert.equal(v.spec_v2.unmapped.length, V2.specV2.unmapped.length, "unmapped·ids 는 그대로");
  assert.deepEqual(v.spec_v2.ids, V2.specV2.ids);
  const a = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='spec.edited'", [id])).rows[0].detail;
  assert.equal(a.ir, "v2");
  assert.deepEqual(a.changed, ["components.shop-api.replicas"]);
  assert.ok(!JSON.stringify(a).includes("\"min\""), "감사엔 칸 이름만");

  // 다음 판: 다른 칸만 바꿔도 앞 판에서 끈 v1 단계 올림 표시는 그대로 꺼져 있음 (prevMeta)
  const r2 = await patch(id, { baseVersion: 2, changes: [{ path: "components.shop-web.replicas", value: { min: 2, max: 4 } }] });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.deepEqual(r2.json().needsReview, []);
  const plan = await app.inject({ method: "POST", url: `${P}/migrations/${id}/plan`, payload: {}, headers: { "x-dev-tenant": T } });
  assert.equal(plan.statusCode, 202, plan.body);
});

test("거부: v2 판에 v1 키 → 400 SPEC_PATH_IR_MISMATCH, v1 판에 v2 키 → 같은 400, 판 그대로", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "service.port", value: 9090 }] });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().code, "SPEC_PATH_IR_MISMATCH");
  const c = await patch(id, { baseVersion: 1, confirm: ["service.cpu"] });
  assert.equal(c.json().code, "SPEC_PATH_IR_MISMATCH");
  assert.equal((await versions(id)).length, 1);
  const v1only = await seed(false);
  const w = await patch(v1only, { baseVersion: 1, confirm: ["components.shop-api.resources"] });
  assert.equal(w.statusCode, 400, w.body);
  assert.equal(w.json().code, "SPEC_PATH_IR_MISMATCH");
  const g = await app.inject({ method: "GET", url: `${P}/migrations/${v1only}/spec`, headers: { "x-dev-tenant": T } });
  assert.equal("needsReviewV2" in g.json(), false, "v1 판 응답은 지금 모양 그대로");
});

test("거부: v2 모양·checkV2 오류 → 400 SPEC_PATCH_INVALID, 값은 응답에 없음, 판 그대로", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.replicas", value: "s3cret-shape" }] });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().code, "SPEC_PATCH_INVALID");
  assert.ok(!r.body.includes("s3cret-shape"));
  const img = svc(V2.specV2, "shop-cleanup").props.image;
  const d = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-cleanup.image", value: { ...img, digest: null } }] });
  assert.equal(d.statusCode, 400, d.body);
  assert.equal(d.json().code, "SPEC_PATCH_INVALID");
  const n = await patch(id, { baseVersion: 1, changes: [{ path: "components.nope.replicas", value: { min: 1, max: 1 } }] });
  assert.equal(n.json().code, "SPEC_PATCH_INVALID");
  assert.equal((await versions(id)).length, 1);
});

test("남의 회사: 다른 회사 이전의 v2 판 PATCH → 404, 판 그대로", { skip }, async () => {
  const id = await seed(true, OTHER);
  const r = await patch(id, { baseVersion: 1, confirm: ["components.shop-api.resources"] });
  assert.equal(r.statusCode, 404, r.body);
  assert.equal((await versions(id)).length, 1);
});
