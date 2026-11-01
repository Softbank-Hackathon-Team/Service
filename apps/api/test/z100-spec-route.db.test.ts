// DB 시험 (Z100, Z101 요청): GET /migrations/:id/spec — 받아들인 최신 판 우선, 없으면 AI 초안, 둘 다 없으면 404, 남의 회사 404
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
const SPEC = {
  schemaVersion: "1", app: { name: "shop" },
  service: { image: `ghcr.io/demo/shop@sha256:${"a".repeat(64)}`, port: 8080, healthPath: "/healthz", replicas: 2, cpu: "250m", memory: "512Mi", env: [], secretRefs: [] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 },
  ingress: { hostname: "shop.example.com", entry: "cloudflare-lb" },
};

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;
const get = (tenant: string, id: string) => app.inject({ url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": tenant } });

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { specRoutes } = await import("../src/routes/spec.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z100'), ($2,'test-z100-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(specRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
});

async function seed(tenant: string, versions: { v: number; spec: unknown; meta: Record<string, unknown> }[]) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','k3s','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, tenant]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`,
    [id, tenant, src, dst]);
  for (const x of versions)
    await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta) VALUES ($1,$2,$3,$4,$5)`,
      [tenant, id, x.v, x.spec, x.meta]);
  return id;
}
const meta = (needs: string[]) => Object.fromEntries(needs.map((k) => [k, { source: "ai", confidence: 0.6, needs_review: true }]));

test("받아들인 최신 판을 돌려준다 (그보다 새 AI 초안 판이 있어도)", { skip }, async () => {
  const id = await seed(T, [
    { v: 1, spec: { ...SPEC, service: { ...SPEC.service, replicas: 1 } }, meta: {} },
    { v: 2, spec: SPEC, meta: meta(["service.port"]) },
    { v: 3, spec: { ...SPEC, app: { name: "ai" } }, meta: { _draft: { by: "ai" } } },
  ]);
  const r = await get(T, id);
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.version, 2);
  assert.equal(b.source, "accepted");
  assert.equal(b.complete, true);
  assert.equal(b.spec.service.replicas, 2);
  assert.deepEqual(b.needsReview, ["service.port"]);
  assert.match(b.createdAt, /Z$/);
});

test("받아들인 판이 없으면 AI 초안 판 (source ai_draft)", { skip }, async () => {
  const id = await seed(T, [{ v: 1, spec: SPEC, meta: { _draft: { by: "ai" } } }]);
  const b = (await get(T, id)).json();
  assert.equal(b.source, "ai_draft");
  assert.deepEqual(b.needsReview, []);
});

test("가져오기가 일부만 채운 판 → complete false, 채운 칸만", { skip }, async () => {
  const id = await seed(T, [{ v: 1, spec: { schemaVersion: "1", app: { name: "half" } }, meta: {} }]);
  const b = (await get(T, id)).json();
  assert.equal(b.complete, false);
  assert.equal(b.spec.app.name, "half");
  assert.equal(b.spec.service, undefined);
});

test("명세가 없으면 404, 남의 회사 이전도 404", { skip }, async () => {
  const none = await seed(T, []);
  assert.equal((await get(T, none)).statusCode, 404);
  const mine = await seed(T, [{ v: 1, spec: SPEC, meta: {} }]);
  assert.equal((await get(OTHER, mine)).statusCode, 404);
});

test("모양이 깨진 판 → 409 SPEC_INVALID (가짜 기본값으로 안 채움)", { skip }, async () => {
  const id = await seed(T, [{ v: 1, spec: { service: { port: "x" } }, meta: {} }]);
  const r = await get(T, id);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error?.code ?? r.json().code, "SPEC_INVALID");
});
