// DB 시험 MAPV2: GET /migrations/:id/plan/resources 경로 — v2 판이면 v2 이름(ECS), v1 판은 그대로, 남의 회사는 404
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { DEMO_INVENTORY, DEMO_SPEC, normalizeV2 } from "@svc/adapters";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();
let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { envInventoryRoutes } = await import("../src/routes/env-inventory.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-mapv2'), ($2,'test-mapv2-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(envInventoryRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
});

async function seed(src: "aws" | "gcp" | "onprem", dst: "aws" | "gcp" | "onprem", v2: unknown) {
  const id = randomUUID(), s = randomUUID(), d = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,$4,'s','connected'), ($2,$3,$5,'d','connected')`, [s, d, T, src, dst]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'approved')`, [id, T, s, d]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,$3,'{}',$4)`,
    [T, id, { ...DEMO_SPEC, database: { engine: "postgres", majorVersion: "16", storageGb: 20 } }, v2]);
  return id;
}
const get = (id: string, tenant = T) => app.inject({ method: "GET", url: `${P}/migrations/${id}/plan/resources`, headers: { "x-dev-tenant": tenant } });

test("정상: v2 판(ECS 출발) → ECS 이름·Cloudflare LB 줄·경계 밖 개수 줄, 응답이 스키마를 통과", { skip }, async () => {
  const r2 = normalizeV2(DEMO_INVENTORY.aws!).result;
  const oob = [{ resource: "sqs:other", kind: "queue", reason: "경계 밖" }, { resource: "s3:other", kind: "objectStore", reason: "경계 밖" }];
  const id = await seed("aws", "aws", { spec: r2.spec, fieldMeta: {}, unmapped: [], ids: {}, outOfBoundary: oob });
  const res = await get(id);
  assert.equal(res.statusCode, 200, res.body);
  const b = res.json();
  assert.equal(b.irVersion, "2");
  const api = b.rows.find((x: { label: string }) => x.label.endsWith("· shop-api"));
  assert.equal(api.source.service, "Amazon ECS 서비스"); assert.equal(api.target.service, "Amazon ECS 서비스 (Fargate)");
  assert.match(b.rows.find((x: { category: string }) => x.category === "ingress").target.service, /Cloudflare LB/);
  assert.equal(b.rows.find((x: { category: string }) => x.category === "boundary").label, "경계 밖 자원 2개");
  assert.ok(!JSON.stringify(b).includes("Application Load Balancer"));
});

test("명세 없는 예전 판(spec_v2 NULL): specKnown false, irVersion 없음 (지어내지 않음)", { skip }, async () => {
  const id = await seed("aws", "gcp", null);
  const r = await get(id);
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.specKnown, false);
  assert.equal("irVersion" in b, false);
});

test("거부: 남의 회사 이전은 404", { skip }, async () => {
  const id = await seed("aws", "aws", null);
  assert.equal((await get(id, OTHER)).statusCode, 404);
});
