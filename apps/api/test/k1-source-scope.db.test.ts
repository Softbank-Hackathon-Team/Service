// DB 시험(K-1): 이전을 만들 때 출발 범위(sourceScope)를 받아 migrations.source_scope 에 둔다. 계약 밖 값은 400
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const T = randomUUID(), S = randomUUID(), G = randomUUID();
const H = { "x-dev-tenant": T };
let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { migrationRoutes } = await import("../src/routes/migrations.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-k1-scope')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(migrationRoutes, { prefix: "/api/v1" });
  await app.ready();
  await core.startBoss();
});
after(async () => { if (!skip) { await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end(); } });

test("K-1: sourceScope 를 받아 이전 행에 저장 (없으면 빈 객체)", { skip }, async () => {
  const scope = { cluster: "prod-eks", namespaces: ["shop"], partOf: "shop", database: "shop-db", appName: "shop" };
  const r = await app.inject({ method: "POST", url: "/api/v1/migrations", headers: H, payload: { sourceEnvId: S, targetEnvId: G, sourceScope: scope } });
  assert.equal(r.statusCode, 202);
  const row = (await owner.query("SELECT source_scope FROM migrations WHERE id=$1", [r.json().id])).rows[0];
  assert.deepEqual(row.source_scope, scope);
  const r2 = await app.inject({ method: "POST", url: "/api/v1/migrations", headers: H, payload: { sourceEnvId: S, targetEnvId: G } });
  assert.deepEqual((await owner.query("SELECT source_scope FROM migrations WHERE id=$1", [r2.json().id])).rows[0].source_scope, {});
});

test("K-1: 계약 밖 범위(셸 글자·모르는 칸)는 400", { skip }, async () => {
  for (const sourceScope of [{ cluster: "a;rm -rf /" }, { region: "x" }, { namespaces: [] }]) {
    const r = await app.inject({ method: "POST", url: "/api/v1/migrations", headers: H, payload: { sourceEnvId: S, targetEnvId: G, sourceScope } });
    assert.equal(r.statusCode, 400, JSON.stringify(sourceScope));
  }
});
