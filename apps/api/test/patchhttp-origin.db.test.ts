// PATCHHTTP (ADR-045 · IR-17): PATCH /migrations/:id/spec 가 출발 사실 칸(origin)을 HTTP 로 거부하는지. 규칙은 core/specs.ts applySpecV2Patch, 단위 시험은 adapters/runtimemap-class
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-patchhttp'), ($2,'test-patchhttp-other')", [T, OTHER]);
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

const get = async (id: string) => (await app.inject({ method: "GET", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": T } })).json();
const plan = (id: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/plan`, payload: {}, headers: { "x-dev-tenant": T } });

const ORIGIN = { runtime: "k8s", product: "k8s" };
const noNewVersion = async (id: string) => assert.equal((await versions(id)).length, 1, "거부된 PATCH 는 새 판을 만들지 않는다");

test("origin 칸 바꾸기 → 400 SPEC_PATCH_INVALID (칸 이름이 메시지에), 판 그대로", { skip }, async () => {
  const id = await seed();
  const before = svc((await versions(id))[0].spec_v2, "shop-api").props.origin;
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.origin", value: ORIGIN }] });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().code, "SPEC_PATCH_INVALID");
  assert.match(r.json().message, /components\.shop-api\.origin/);
  assert.match(r.json().message, /origin/);
  await noNewVersion(id);
  assert.deepEqual(svc((await versions(id))[0].spec_v2, "shop-api").props.origin, before, "origin 값 그대로");
});

test("허용 칸 + origin 이 한 요청에 섞이면 통째로 거부 (허용 칸도 적용 안 됨)", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, changes: [
    { path: "components.shop-api.replicas", value: { min: 2, max: 2 } },
    { path: "components.shop-api.origin", value: ORIGIN }] });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().code, "SPEC_PATCH_INVALID");
  await noNewVersion(id);
  assert.notDeepEqual(svc((await versions(id))[0].spec_v2, "shop-api").props.replicas, { min: 2, max: 2 });
});

test("제어 사례: 같은 요청에서 origin 만 빼면 200 · 새 판 2, origin 은 안 바뀜", { skip }, async () => {
  const id = await seed();
  const origin = svc((await versions(id))[0].spec_v2, "shop-api").props.origin;
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.replicas", value: { min: 2, max: 2 } }] });
  assert.equal(r.statusCode, 200, r.body);
  const v = await versions(id);
  assert.equal(v.length, 2);
  assert.deepEqual(svc(v[1].spec_v2, "shop-api").props.replicas, { min: 2, max: 2 });
  assert.deepEqual(svc(v[1].spec_v2, "shop-api").props.origin, origin);
});

test("origin 은 어느 구성요소든 막힌다 (shop-web·shop-cleanup 도), 없는 구성요소는 origin 이어도 '없음' 으로 400", { skip }, async () => {
  const id = await seed();
  for (const cid of ["shop-web", "shop-cleanup"]) {
    const r = await patch(id, { baseVersion: 1, changes: [{ path: `components.${cid}.origin`, value: ORIGIN }] });
    assert.equal(r.statusCode, 400, `${cid} ${r.body}`);
    assert.equal(r.json().code, "SPEC_PATCH_INVALID");
    assert.match(r.json().message, /origin/);
  }
  const none = await patch(id, { baseVersion: 1, changes: [{ path: "components.nope.origin", value: ORIGIN }] });
  assert.equal(none.statusCode, 400);
  assert.match(none.json().message, /no component nope/);
  await noNewVersion(id);
});

test("origin 과 다른 이름(originNote)은 origin 거부 메시지로 막히지 않는다", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.originNote", value: "x" }] });
  // 막는 건 규칙(origin)이 아니라 새 칸의 모양 검사일 수 있다 — origin 거부 메시지가 아니어야 한다
  assert.doesNotMatch(r.body, /origin 은 가져오기가 정한 값/);
});

test("남의 회사 이전의 spec PATCH (origin 포함·미포함 둘 다) → 404, 판 그대로", { skip }, async () => {
  const id = await seed(true, OTHER);
  for (const changes of [[{ path: "components.shop-api.origin", value: ORIGIN }], [{ path: "components.shop-api.replicas", value: { min: 2, max: 2 } }]]) {
    const r = await patch(id, { baseVersion: 1, changes }, T);
    assert.equal(r.statusCode, 404, r.body);
  }
  assert.equal((await versions(id)).length, 1);
});
