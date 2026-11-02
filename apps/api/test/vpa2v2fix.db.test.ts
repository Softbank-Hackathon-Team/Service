// VPA2v2fix: acceptDraft 때 v2 검토 칸 이어받기(PA2v2fix) 검증 — 최신 v2 판 고르기, 초안이 v2 를 가진 경우, 멱등, 남의 회사 404, 낡은 초안, 같은 요청 안 confirm
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vpa2v2fix'), ($2,'test-vpa2v2fix-other')", [T, OTHER]);
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


const { SPEC_DRAFT_KEY_P } = { SPEC_DRAFT_KEY_P: "_draft" };
async function addDraft(id: string, version: number, opts: { specV2?: unknown; tenant?: string; replicas?: number } = {}) {
  const draft = structuredClone(V2.spec as Record<string, any>);
  draft.service.replicas = opts.replicas ?? 4;
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,$3,$4,$5,$6)`,
    [opts.tenant ?? T, id, version, draft, { [SPEC_DRAFT_KEY_P]: { source: "ai" } }, opts.specV2 ?? null]);
}
const audits = async (id: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND action='spec.edited' ORDER BY seq", [id])).rows.map((r) => r.detail);

test("이어받기는 가장 최근에 받아들인 v2 판에서: 앞서 확인한 검토 칸은 다시 살아나지 않는다", { skip }, async () => {
  const id = await seed();
  const c = await patch(id, { baseVersion: 1, confirm: ["components.shop-cleanup.probes"] });   // → 판 2 (v2, 검토 칸 하나 줄어듦)
  assert.equal(c.statusCode, 200, c.body);
  const v2After = (await versions(id))[1].spec_v2;
  await addDraft(id, 3);
  const r = await patch(id, { baseVersion: 2, acceptDraft: 3 });   // 보이는 판 = 최신 받아들인 판(2)
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().needsReviewV2, ALL_V2.filter((k) => k !== "components.shop-cleanup.probes"));
  assert.deepEqual((await versions(id)).at(-1)!.spec_v2, v2After, "판 1(옛 v2)이 아니라 판 2 를 이어받아야 함");
  const g = await get(id);
  assert.equal(g.version, 4);
  assert.deepEqual(g.needsReviewV2, r.json().needsReviewV2, "GET 도 같은 v2 검토 칸");
});

test("초안이 spec_v2 를 직접 가지면 이어받지 않고 그 v2 경로 그대로 (감사에 inheritedV2 없음)", { skip }, async () => {
  const id = await seed();
  const own = structuredClone(V2.specV2);
  own.fieldMeta = Object.fromEntries(Object.entries(own.fieldMeta).filter(([k]) => k !== "components.shop-api.env.API_TOKEN"));
  await addDraft(id, 2, { specV2: own });
  const r = await patch(id, { baseVersion: 1, acceptDraft: 2 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().needsReviewV2.includes("components.shop-api.env.API_TOKEN"), false, "초안 자기 v2 가 아니라 직전 판 v2 가 쓰임");
  assert.equal("inheritedV2" in (await audits(id)).at(-1), false);
});

test("초안이 여럿이면 고른 초안의 v1 값 + 최신 받아들인 판 v2 (더 새 초안이 있어도 옛 초안을 고를 수 있음)", { skip }, async () => {
  const id = await seed();
  await addDraft(id, 2, { replicas: 2 });
  await addDraft(id, 3, { replicas: 3 });
  const r = await patch(id, { baseVersion: 1, acceptDraft: 2 });
  assert.equal(r.statusCode, 200, r.body);
  const last = (await versions(id)).at(-1)!;
  assert.equal(last.version, 4);
  assert.equal(last.spec.service.replicas, 2, "고른 초안 값");
  assert.deepEqual(last.spec_v2, V2.specV2);
  assert.deepEqual(r.json().needsReviewV2, ALL_V2);
});

test("멱등: 같은 Idempotency-Key 로 두 번 보내면 판 하나·감사 하나, 두 번째 응답도 v2 검토 칸 그대로", { skip }, async () => {
  const id = await seed();
  await addDraft(id, 2);
  const send = () => app.inject({ method: "PATCH", url: `${P}/migrations/${id}/spec`, payload: { baseVersion: 1, acceptDraft: 2 },
    headers: { "x-dev-tenant": T, "idempotency-key": `vpa2v2fix-${id}` } });
  const a = await send(), b = await send();
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  assert.deepEqual(b.json(), a.json());
  assert.equal((await versions(id)).length, 3);
  assert.equal((await audits(id)).length, 1);
  // 키 없이 같은 요청 다시 → 판 3 이 최신이라 baseVersion 1 은 409 (두 번째 이어받기 없음)
  const again = await patch(id, { baseVersion: 1, acceptDraft: 2 });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal((await versions(id)).length, 3);
});

test("남의 회사: 다른 회사가 같은 이전에 acceptDraft → 404, 판·감사 안 생김", { skip }, async () => {
  const id = await seed();
  await addDraft(id, 2);
  const r = await patch(id, { baseVersion: 1, acceptDraft: 2 }, OTHER);
  assert.equal(r.statusCode, 404, r.body);
  assert.equal((await versions(id)).length, 2);
  assert.equal((await audits(id)).length, 0);
});

test("다른 회사의 v2 판은 이어받지 않는다 (RLS: 같은 이전 번호라도 회사가 다르면 안 보임)", { skip }, async () => {
  const mine = await seed(false);                 // 내 이전: v1 판만
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,2,$3,$4,$5)`,
    [OTHER, mine, V2.spec, V2.fieldMeta, V2.specV2]).catch(() => undefined);   // FK·제약에 막히면 그것도 격리
  const n = (await versions(mine)).length;
  await addDraft(mine, n + 1);
  const r = await patch(mine, { baseVersion: 1, acceptDraft: n + 1 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await versions(mine)).filter((v) => v.version > n + 1).at(-1)?.spec_v2 ?? null, null, "남의 회사 spec_v2 가 섞임");
});

test("거부: 받아들인 판보다 옛 초안 → 409 SPEC_DRAFT_STALE, 없는 초안 → 400, 둘 다 판·감사 안 생김", { skip }, async () => {
  const id = await seed();
  await addDraft(id, 2);
  assert.equal((await patch(id, { baseVersion: 1, acceptDraft: 2 })).statusCode, 200);   // → 판 3
  const stale = await patch(id, { baseVersion: 3, acceptDraft: 2 });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().code, "SPEC_DRAFT_STALE");
  const none = await patch(id, { baseVersion: 3, acceptDraft: 99 });
  assert.equal(none.statusCode, 400, none.body);
  assert.equal(none.json().code, "SPEC_DRAFT_NOT_FOUND");
  assert.equal((await versions(id)).length, 3);
  assert.equal((await audits(id)).length, 1);
});

test("같은 요청 안 acceptDraft + confirm: 초안(v1 판) 기준이라 v1 키만 받고 v2 키는 400 — v2 검토 칸은 그대로 남아 /plan 은 막힘", { skip }, async () => {
  const id = await seed();
  await addDraft(id, 2);
  const v2key = await patch(id, { baseVersion: 1, acceptDraft: 2, confirm: ["components.shop-api.env.API_TOKEN"] });
  assert.equal(v2key.statusCode, 400, v2key.body);
  assert.equal(v2key.json().code, "SPEC_PATH_IR_MISMATCH");
  assert.equal((await versions(id)).length, 2);
  const v1key = await patch(id, { baseVersion: 1, acceptDraft: 2, confirm: ["service.env.API_TOKEN"] });
  assert.equal(v1key.statusCode, 200, v1key.body);
  assert.deepEqual(v1key.json().needsReviewV2, ALL_V2, "v1 확인이 v2 검토 칸을 지우면 안 됨");
  assert.equal((await plan(id)).statusCode, 409);
});
