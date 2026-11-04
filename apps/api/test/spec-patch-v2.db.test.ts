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
  const { result } = adapters.normalizeV2(adapters.DEMO_INVENTORY.gcp!, { appName: "shop" });   // G3b-5: 실제 가져오기처럼 출발 범위 appName 을 준다 (안 주면 app.name 검토 줄이 생김)
  // G3c-5: 가져오기와 같은 함수로 검토 줄(내용 키 check.*)을 붙인다
  result.fieldMeta = contracts.syncCheckReviews(result.fieldMeta, contracts.checkV2Reviews(result.spec));
  // 평문 비밀로 뺀 env 하나 (가져오기 maskPlainSecrets 와 같은 모양): 검토 표시
  result.fieldMeta["components.shop-api.env.API_TOKEN"] = { source: "source.env", confidence: 0.6, needs_review: true, rationale: "평문 비밀" };
  const stored = contracts.ImportResultV2.parse(result);
  V2 = { spec: {}, fieldMeta: {}, specV2: stored as unknown as Record<string, any> };
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

test("정상: 칸 바꿈·확인 → 새 판(spec_v2 에만 명세, 예전 칸은 비움), 검토 0 → POST /plan 202", { skip }, async () => {
  const id = await seed();
  const g = await app.inject({ method: "GET", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": T } });
  assert.equal(g.statusCode, 200, g.body);
  assert.deepEqual(g.json().needsReview, ["components.shop-api.env.API_TOKEN", "components.shop-cleanup.probes", "components.shop-cleanup.resources", "secrets.shop-db.keys.password.pairedWith"]);
  assert.deepEqual(g.json().needsReviewV2, g.json().needsReview, "옛 이름 칸도 같은 값");

  const r = await patch(id, { baseVersion: 1,
    changes: [{ path: "components.shop-api.replicas", value: { min: 3, max: 6 } }],
    confirm: ["components.shop-api.env.API_TOKEN", "components.shop-cleanup.probes", "components.shop-cleanup.resources", "secrets.shop-db.keys.password.pairedWith"] });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.version, 2);
  assert.deepEqual(b.needsReview, []);

  const [, v] = await versions(id);
  assert.deepEqual(svc(v.spec_v2, "shop-api").props.replicas, { min: 3, max: 6 });
  assert.deepEqual(v.spec_v2.fieldMeta["components.shop-api.replicas"], { source: "human", confidence: 1, needs_review: false });
  assert.deepEqual(v.spec, {}, "예전 칸 spec 은 '{}'");
  assert.deepEqual(v.field_meta, {}, "예전 칸 field_meta 는 초안 표시 자리만 (사람 판이라 비움)");
  assert.equal(v.spec_v2.unmapped.length, V2.specV2.unmapped.length, "unmapped·ids 는 그대로");
  assert.deepEqual(v.spec_v2.ids, V2.specV2.ids);
  const a = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='spec.edited'", [id])).rows[0].detail;
  assert.deepEqual(a.changed, ["components.shop-api.replicas"]);
  assert.ok(!JSON.stringify(a).includes("\"min\""), "감사엔 칸 이름만");

  const r2 = await patch(id, { baseVersion: 2, changes: [{ path: "components.shop-web.replicas", value: { min: 2, max: 4 } }] });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.deepEqual(r2.json().needsReview, []);
  const plan = await app.inject({ method: "POST", url: `${P}/migrations/${id}/plan`, payload: {}, headers: { "x-dev-tenant": T } });
  assert.equal(plan.statusCode, 202, plan.body);
});

test("거부: 예전 v1 키(service.port)는 경로 모양부터 400, spec_v2 없는 예전 판은 409 SPEC_INVALID (다시 가져와야 함), 판 그대로", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "service.port", value: 9090 }] });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal((await versions(id)).length, 1);
  const old = await seed(false);
  const w = await patch(old, { baseVersion: 1, confirm: ["components.shop-api.resources"] });
  assert.equal(w.statusCode, 409, w.body);
  assert.equal(w.json().code, "SPEC_INVALID");
  assert.equal((await versions(old)).length, 1);
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
