// DB 시험 (ACCVIEW): GET /migrations/:id/spec 이 가져오기 감사의 정확도(accuracy)를 같이 돌려준다. 없으면 키 자체가 없다
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-accview'), ($2,'test-accview-other')", [T, OTHER]);
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
const ACC = { schemaVersion: "1", basis: "render", total: 3, matched: 2, mismatched: 1, unverifiable: 0, comparable: 3, percent: 66.7,
  fields: [{ component: "shop-api", field: "replicas", result: "mismatch", detail: "복제 수 원본 2~6 / 도착 1~6" }, { component: "shop-api", field: "ports", result: "match" }, { component: "shop-db", field: "db.version", result: "match" }] };
const audit = (tenant: string, id: string, detail: unknown, seq = "x") => owner.query(
  `INSERT INTO audit_events (tenant_id, actor, action, target, result, detail, prev_hash, hash) VALUES ($1,'worker','migration.spec_review',$2,'ok',$3,$4,$4)`, [tenant, id, detail, seq + randomUUID()]);

test("정확도 있는 판 → 응답에 accuracy 가 그대로 있다 (기존 칸도 그대로)", { skip }, async () => {
  const id = await seed();
  await audit(T, id, { ir: "v2", accuracy: ACC });
  const r = await get(id);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().accuracy, ACC);
  assert.ok(r.json().specV2 && r.json().needsReviewV2);
});

test("정확도 없는 판(감사에 accuracy 없음·감사 자체 없음) → accuracy 키 자체가 없다", { skip }, async () => {
  const a = await seed(); await audit(T, a, { ir: "v2" });
  const b = await seed();
  for (const id of [a, b]) { const body = (await get(id)).json(); assert.ok(!("accuracy" in body), id); assert.ok(body.spec); }
});

test("감사의 accuracy 모양이 깨졌으면 키를 빼고 200 (화면 안 깨짐, 가짜 값 없음)", { skip }, async () => {
  const id = await seed(); await audit(T, id, { accuracy: { percent: "많이" } });
  const r = await get(id);
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(!("accuracy" in r.json()));
});

test("가져오기가 두 번이면 가장 최근 감사 값", { skip }, async () => {
  const id = await seed();
  await audit(T, id, { accuracy: { ...ACC, percent: 10, matched: 0, mismatched: 3, fields: [] } });
  await audit(T, id, { accuracy: ACC });
  assert.equal((await get(id)).json().accuracy.percent, 66.7);
});

test("남의 회사: 이전 404, 남의 회사 감사의 accuracy 도 안 새어 나온다", { skip }, async () => {
  const id = await seed(); await audit(T, id, { accuracy: ACC });
  assert.equal((await get(id, OTHER)).statusCode, 404);
  const mine = await seed(true, OTHER);   // OTHER 의 이전 (감사 없음) → 키 없음
  assert.ok(!("accuracy" in (await get(mine, OTHER)).json()));
});
