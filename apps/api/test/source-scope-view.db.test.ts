// K-1 뒤: GET /migrations/:id 가 이전을 만들 때 정한 출발 범위(sourceScope)를 돌려준다. 안 정했으면 {}. 남의 회사는 404
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { MigrationView } from "@svc/contracts";

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
  const { migrationRoutes } = await import("../src/routes/migrations.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-ssview'), ($2,'test-ssview-o')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(migrationRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
});

async function mk(scope: object | null) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','d','connected')`, [src, dst, T]);
  if (scope) await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, source_scope) VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, scope]);
  else await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id) VALUES ($1,$2,$3,$4)`, [id, T, src, dst]);
  return id;
}

test("GET 이전 하나: 정한 출발 범위를 그대로, 안 정했으면 {}", { skip }, async () => {
  const a = await mk({ namespaces: ["shop"], cluster: "src-eks", appName: "shop" });
  const g = await app.inject({ method: "GET", url: `${P}/migrations/${a}`, headers: { "x-dev-tenant": T } });
  assert.equal(g.statusCode, 200, g.body);
  assert.deepEqual(MigrationView.parse(g.json()).sourceScope, { namespaces: ["shop"], cluster: "src-eks", appName: "shop" });
  const b = await mk(null);
  const h = await app.inject({ method: "GET", url: `${P}/migrations/${b}`, headers: { "x-dev-tenant": T } });
  assert.equal(h.statusCode, 200, h.body);
  assert.deepEqual(MigrationView.parse(h.json()).sourceScope, {});
});

test("거부: 남의 회사 이전은 출발 범위째 404 (범위 값이 새지 않음)", { skip }, async () => {
  const a = await mk({ cluster: "secret-cluster-name" });
  const o = await app.inject({ method: "GET", url: `${P}/migrations/${a}`, headers: { "x-dev-tenant": OTHER } });
  assert.equal(o.statusCode, 404);
  assert.ok(!o.body.includes("secret-cluster-name"));
});
