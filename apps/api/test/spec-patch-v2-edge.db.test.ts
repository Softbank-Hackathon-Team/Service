// VPA2v2: v2 검토 칸이 confirm·PATCH 한 번에 한꺼번에 사라지지 않는지 (A3v2 경고) · 판 사이 유지 · T04 문턱
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vpa2v2'), ($2,'test-vpa2v2-other')", [T, OTHER]);
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
const ALL_V2 = ["components.shop-api.env.API_TOKEN", "components.shop-cleanup.probes", "components.shop-cleanup.resources"];

test("confirm 한 칸만 사라지고 나머지 v2 검토 칸은 남는다 — 판이 여러 번 바뀌어도, POST /plan 은 계속 막힘", { skip }, async () => {
  const id = await seed();
  const r1 = await patch(id, { baseVersion: 1, confirm: ["components.shop-cleanup.probes"] });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.deepEqual(r1.json().needsReviewV2, ["components.shop-api.env.API_TOKEN", "components.shop-cleanup.resources"]);
  assert.equal((await plan(id)).statusCode, 409, "검토 칸이 남았는데 계획이 통과함");
  // 판 2→3: 전혀 다른 칸만 바꿔도 남은 검토 칸은 그대로 (spec_v2 NULL 판으로 새지 않음)
  const r2 = await patch(id, { baseVersion: 2, changes: [{ path: "components.shop-web.replicas", value: { min: 2, max: 3 } }] });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.deepEqual(r2.json().needsReviewV2, ["components.shop-api.env.API_TOKEN", "components.shop-cleanup.resources"]);
  const rows = await versions(id);
  assert.ok(rows.every((v: { spec_v2: unknown }) => v.spec_v2 !== null), "새 판이 spec_v2 를 잃음");
  assert.equal((await plan(id)).statusCode, 409);
  // 판 3→4: 남은 둘을 모두 확인해야 비로소 통과
  const r3 = await patch(id, { baseVersion: 3, confirm: ["components.shop-cleanup.resources"] });
  assert.deepEqual(r3.json().needsReviewV2, ["components.shop-api.env.API_TOKEN"]);
  assert.equal((await plan(id)).statusCode, 409);
  const r4 = await patch(id, { baseVersion: 4, confirm: ["components.shop-api.env.API_TOKEN", "components.shop-api.resources"] });
  assert.deepEqual(r4.json().needsReviewV2, []);
  assert.deepEqual(r4.json().needsReview, []);
  assert.equal((await plan(id)).statusCode, 202);
});

test("한 리소스의 칸을 바꿔도 다른 리소스의 검토 칸은 안 지워진다", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.replicas", value: { min: 2, max: 2 } }] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().needsReviewV2, ALL_V2);
});

test("같은 칸을 바꾸면(changes) 그 칸 아래 검토 칸만 사라진다: env 통째로 바꾸면 env.* 만", { skip }, async () => {
  const id = await seed();
  const env = svc(V2.specV2, "shop-api").props.env.filter((e: { name: string }) => e.name !== "API_TOKEN");
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop-api.env", value: env }] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().needsReviewV2, ["components.shop-cleanup.probes", "components.shop-cleanup.resources"]);
  assert.ok(r.json().needsReview.includes("service.cpu"), "v1 단계 올림 표시는 resources 를 안 건드렸으니 남음");
});

test("모르는 키를 confirm 해도 던지지 않고 아무것도 안 지운다(새 판은 만들어짐)", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, confirm: ["components.shop-api.nope"] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().needsReviewV2, ALL_V2);
});

test("check.reviews[i] 같은 v2 검토 키도 개별로 확인되고, 확인 안 한 건 남는다 (같은 키를 두 번 확인해도 무해)", { skip }, async () => {
  const id = await seed();
  const keys = Object.keys(V2.specV2.fieldMeta).filter((k) => k.startsWith("check.reviews["));
  if (!keys.length) return;   // 데모 원본에서 checkV2 reviews 가 0이면 해당 없음
  const r = await patch(id, { baseVersion: 1, confirm: [keys[0]!, keys[0]!] });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(!r.json().needsReviewV2.includes(keys[0]!));
  assert.equal(r.json().needsReviewV2.length, 3 + keys.length - 1);
});

test("거부: 낡은 baseVersion 은 409 로 막고 판 그대로, 같은 요청을 새 baseVersion 으로 다시 보내면 통과", { skip }, async () => {
  const id = await seed();
  assert.equal((await patch(id, { baseVersion: 1, confirm: ["components.shop-cleanup.probes"] })).statusCode, 200);
  const stale = await patch(id, { baseVersion: 1, confirm: ["components.shop-cleanup.resources"] });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal((await versions(id)).length, 2);
  assert.equal((await get(id)).needsReviewV2.length, 2);
});

test("동시성: 같은 baseVersion 으로 서로 다른 칸을 동시에 확인 → 하나만 성공, 성공한 쪽만 반영", { skip }, async () => {
  const id = await seed();
  const [a, b] = await Promise.all([
    patch(id, { baseVersion: 1, confirm: ["components.shop-cleanup.probes"] }),
    patch(id, { baseVersion: 1, confirm: ["components.shop-cleanup.resources"] }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.equal((await versions(id)).length, 2);
  assert.equal((await get(id)).needsReviewV2.length, 2);
});

// PA2v2fix: AI 초안(spec_v2 없음)을 acceptDraft 로 받아들여도 직전 받아들인 판의 spec_v2(검토 칸 포함)를 이어받는다
async function seedWithDraft(id: string) {
  const { SPEC_DRAFT_KEY } = await import("@svc/core");
  const draft = structuredClone(V2.spec as Record<string, any>);
  draft.service.replicas = 4;   // AI 가 바꾼 v1 값
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,2,$3,$4,NULL)`,
    [T, id, draft, { [SPEC_DRAFT_KEY]: { source: "ai" } }]);
}
test("acceptDraft: 새 판이 직전 판 spec_v2 를 이어받아 v2 검토 칸이 남고 /plan 409, 확인하면 통과 (찾은 구멍 수정)", { skip }, async () => {
  const id = await seed();
  await seedWithDraft(id);
  const r = await patch(id, { baseVersion: 1, acceptDraft: 2 });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().needsReviewV2, ALL_V2, "v2 검토 칸이 사라짐");
  const rows = await versions(id);
  const last = rows[rows.length - 1];
  assert.deepEqual(last.spec_v2, V2.specV2, "직전 판 spec_v2 를 그대로 복사");
  assert.equal(last.spec.service.replicas, 4, "초안의 v1 값은 그대로 받아들임");
  assert.equal(last.field_meta._draft, undefined, "받아들인 판(_draft 없음)");
  const au = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='spec.edited'", [id])).rows[0].detail;
  assert.equal(au.inheritedV2, true);
  assert.equal(au.acceptedDraft, 2);
  assert.equal((await plan(id)).statusCode, 409, "검토 칸이 남았는데 계획이 통과함");
  const c = await patch(id, { baseVersion: 3, confirm: [...ALL_V2, "components.shop-api.resources"] });
  assert.equal(c.statusCode, 200, c.body);
  assert.deepEqual(c.json().needsReviewV2, []);
  assert.equal((await plan(id)).statusCode, 202);
});
test("acceptDraft 이어받기: v1 판 이전(직전 판에 spec_v2 없음)은 지금과 같다 — spec_v2 안 생김, 감사에 inheritedV2 없음", { skip }, async () => {
  const id = await seed(false);
  await seedWithDraft(id);
  const r = await patch(id, { baseVersion: 1, acceptDraft: 2 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal("needsReviewV2" in r.json(), false);
  const rows = await versions(id);
  assert.equal(rows[rows.length - 1].spec_v2, null);
  const au = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='spec.edited'", [id])).rows[0].detail;
  assert.equal("inheritedV2" in au, false);
});
test("acceptDraft 이어받기: 이어받은 뒤 v1 키 PATCH 는 SPEC_PATH_IR_MISMATCH, 다른 이전의 spec_v2 는 안 샌다", { skip }, async () => {
  const a = await seed();
  const other = await seed(false);          // v1 이전: 같은 회사지만 다른 이전
  await seedWithDraft(other);
  const r = await patch(other, { baseVersion: 1, acceptDraft: 2 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await versions(other)).at(-1)?.spec_v2, null, "다른 이전의 spec_v2 가 섞임");
  await seedWithDraft(a);
  assert.equal((await patch(a, { baseVersion: 1, acceptDraft: 2 })).statusCode, 200);
  const bad = await patch(a, { baseVersion: 3, confirm: ["service.cpu"] });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().code, "SPEC_PATH_IR_MISMATCH");
});
