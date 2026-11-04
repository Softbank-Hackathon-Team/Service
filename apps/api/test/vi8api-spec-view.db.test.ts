// 검증 VI8api: GET /migrations/:id/spec v2 칸 — 승계 판, Zod 계약, 깨진 v2 경계, 남의 회사, 반복 GET
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vi8api'), ($2,'test-vi8api-other')", [T, OTHER]);
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
const patch = (id: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `${P}/migrations/${id}/spec`,
  headers: { "x-dev-tenant": T }, payload });
const setV2 = (id: string, sql: string) => owner.query(`UPDATE spec_versions SET spec_v2 = ${sql} WHERE migration_id=$1`, [id]);
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

test("응답이 MigrationSpecView(strict) 계약과 맞고 spec·fieldMeta(와 옛 이름 specV2·fieldMetaV2)는 AppSpecV2·FieldMetaV2 로 다시 parse 된다, spec_v2 없는 예전 판은 409", { skip }, async () => {
  const c = await import("@svc/contracts");
  const v2 = (await get(await seed())).json();
  assert.deepEqual(c.MigrationSpecView.parse(v2), v2, "응답이 계약과 다름");
  assert.deepEqual(c.AppSpecV2.parse(v2.spec), v2.spec);
  assert.deepEqual(v2.specV2, v2.spec, "옛 이름 칸은 같은 값");
  assert.deepEqual(c.FieldMetaV2.parse(v2.fieldMetaV2), v2.fieldMetaV2);
  assert.equal(v2.source, "accepted");
  const old = await get(await seed(false));
  assert.equal(old.statusCode, 409, old.body);
  assert.equal(old.json().code, "SPEC_INVALID");
});

test("acceptDraft: AI 초안 판의 명세가 새 사람 판이 되고 GET 도 그 판", { skip }, async () => {
  const { SPEC_DRAFT_KEY } = await import("@svc/core");
  const id = await seed();
  const draft = structuredClone(V2.specV2);
  draft.spec.components.find((x: { id: string }) => x.id === "shop-api").props.replicas = { min: 4, max: 6 };
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,2,'{}',$3,$4)`,
    [T, id, { [SPEC_DRAFT_KEY]: { source: "ai" } }, draft]);
  assert.equal((await get(id)).json().version, 1, "받아들인 판이 초안보다 먼저 보임");
  const p = await patch(id, { baseVersion: 1, acceptDraft: 2 });
  assert.equal(p.statusCode, 200, p.body);
  const g = (await get(id)).json();
  assert.equal(g.version, 3);
  assert.deepEqual(g, p.json(), "PATCH 응답과 GET 이 다름");
  assert.deepEqual(g.spec.components.find((x: { id: string }) => x.id === "shop-api").props.replicas, { min: 4, max: 6 }, "초안 값");
});

test("AI 초안 판만 있고 spec_v2 NULL → 409 SPEC_INVALID (예전 형식 판, 다시 가져와야 함)", { skip }, async () => {
  const { SPEC_DRAFT_KEY } = await import("@svc/core");
  const id = await seed(false);
  await owner.query(`UPDATE spec_versions SET field_meta = field_meta || $2 WHERE migration_id=$1`, [id, { [SPEC_DRAFT_KEY]: { source: "ai" } }]);
  const r = await get(id);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "SPEC_INVALID");
});

test("깨진 v2 경계: fieldMeta 모양 틀림·spec 없음 → 409, 배열 → DB 거부 SPEC_INVALID, fieldMeta 없음 → 200 + 빈 fieldMetaV2", { skip }, async () => {
  const bad1 = await seed();
  await setV2(bad1, `jsonb_set(spec_v2, '{fieldMeta}', '{"components.x.image":{"source":"s","confidence":0.5,"needs_review":true}}')`);
  // I8apifix2: 배열 spec_v2 는 0031 CHECK 로 DB 가 거부 (GET 까지 못 감). 경우는 지우지 않고 "거부됨"으로 검사
  const bad2 = await seed();
  await assert.rejects(setV2(bad2, `'[]'::jsonb`), (e: { code?: string; constraint?: string }) =>
    e.code === "23514" && e.constraint === "spec_versions_spec_v2_object");
  assert.equal((await get(bad2)).json().specV2.components.length > 0, true, "거부된 UPDATE 뒤에도 원래 v2 판 그대로");
  const bad3 = await seed();
  await setV2(bad3, `spec_v2 - 'spec'`);
  for (const id of [bad1, bad3]) {
    const r = await get(id);
    assert.equal(r.statusCode, 409, `${r.statusCode} ${r.body}`);
    assert.equal(r.json().code, "SPEC_INVALID");
    assert.ok(!r.body.includes("shop-api"), "409 본문에 명세 값이 섞임");
  }
  const noMeta = await seed();
  await setV2(noMeta, `spec_v2 - 'fieldMeta'`);
  const r = await get(noMeta);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().fieldMetaV2, {});
  assert.deepEqual(r.json().needsReviewV2, []);
});

test("남의 회사·없는 이전 → 둘 다 404 같은 모양 (v2 칸 존재가 새지 않음)", { skip }, async () => {
  const mine = await seed(true, OTHER);
  const a = await get(mine), b = await get(randomUUID());
  assert.equal(a.statusCode, 404); assert.equal(b.statusCode, 404);
  assert.equal(a.json().code, b.json().code);
  assert.ok(!a.body.includes("specV2") && !a.body.includes("shop-api"));
});

test("같은 판 GET 두 번 → 글자 그대로 같은 응답, 판 수 안 늘어남", { skip }, async () => {
  const id = await seed();
  const a = await get(id), b = await get(id);
  assert.equal(a.body, b.body);
  assert.equal((await owner.query("SELECT count(*)::int n FROM spec_versions WHERE migration_id=$1", [id])).rows[0].n, 1);
});
