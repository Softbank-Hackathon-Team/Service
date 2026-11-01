// GET /api/v1/docs 경로 시험. DB 없이 Fastify inject로 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { authPlugin } from "../src/plugins/auth.js";
import { docsRoutes } from "../src/routes/docs.js";

async function build() {
  const app = Fastify();
  await app.register(authPlugin);
  await app.register(docsRoutes, { prefix: "/api/v1" });
  return app;
}

test("docs: 헤더 없이 yaml·json·html을 준다", async () => {
  const app = await build();
  const y = await app.inject({ url: "/api/v1/docs/openapi.yaml" });
  assert.equal(y.statusCode, 200);
  assert.match(y.headers["content-type"] as string, /yaml/);
  assert.match(y.body, /openapi: "3\.1\.0"/);
  const j = await app.inject({ url: "/api/v1/docs/openapi.json" });
  assert.equal(j.statusCode, 200);
  const doc = j.json();
  assert.equal(doc.openapi, "3.1.0");
  assert.ok(doc.paths["/api/v1/migrations"].post);
  const h = await app.inject({ url: "/api/v1/docs" });
  assert.equal(h.statusCode, 200);
  assert.match(h.body, /\/api\/v1\/plans\/\{id\}\/approvals/);
  assert.match(h.headers["content-security-policy"] as string, /default-src 'none'/);
  await app.close();
});

test("docs: 문서 예외가 다른 경로로 새지 않는다", async () => {
  const app = await build();
  app.get("/api/v1/docsx", async () => ({ leaked: true }));
  const r = await app.inject({ url: "/api/v1/docsx" });
  assert.equal(r.statusCode, 401);
  await app.close();
});

test("docs: DOCS_PUBLIC=false면 헤더 필요", async () => {
  process.env.DOCS_PUBLIC = "false";
  try {
    const app = await build();
    const r = await app.inject({ url: "/api/v1/docs/openapi.json" });
    assert.equal(r.statusCode, 401);
    await app.close();
  } finally { delete process.env.DOCS_PUBLIC; }
});

// Z30: Swagger UI
test("docs/ui: Swagger UI HTML·스크립트·명세를 헤더 없이 준다 (CDN 없음)", async () => {
  const app = await build();
  const h = await app.inject({ url: "/api/v1/docs/ui/" });
  assert.equal(h.statusCode, 200);
  assert.match(h.headers["content-type"] as string, /text\/html/);
  assert.match(h.body, /swagger-ui/i);
  assert.doesNotMatch(h.body, /https?:\/\/(cdn|unpkg|jsdelivr)/);
  assert.match(h.headers["content-security-policy"] as string, /script-src 'self'/);
  const js = await app.inject({ url: "/api/v1/docs/ui/static/swagger-ui-bundle.js" });
  assert.equal(js.statusCode, 200);
  const spec = await app.inject({ url: "/api/v1/docs/ui/json" });
  assert.equal(spec.statusCode, 200);
  const doc = spec.json();
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.servers[0].url, "/");
  assert.equal(doc.components.parameters.DevTenant.example, "11111111-1111-4111-8111-111111111111");
  const noSlash = await app.inject({ url: "/api/v1/docs/ui" });
  assert.match(noSlash.body, /\/api\/v1\/docs\/ui\/static\/swagger-ui-bundle\.js/);
  assert.doesNotMatch(h.headers["content-security-policy"] as string, /https:|upgrade-insecure|validator\.swagger/);
  assert.ok(doc.paths["/api/v1/migrations"].post);
  await app.close();
});

test("docs/ui: 운영 모드(NODE_ENV=production)에서도 공개, DOCS_PUBLIC=false면 닫힘", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    let app = await build();
    assert.equal((await app.inject({ url: "/api/v1/docs/ui/" })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/v1/docs/openapi.json" })).statusCode, 200);
    await app.close();
    process.env.DOCS_PUBLIC = "false";
    app = await build();
    assert.equal((await app.inject({ url: "/api/v1/docs/ui/" })).statusCode, 401);
    await app.close();
  } finally {
    delete process.env.DOCS_PUBLIC;
    if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
  }
});

test("docs/ui: 다른 업무 경로는 운영 모드에서 여전히 401", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const app = await build();
    app.get("/api/v1/migrations-x", async () => ({ leaked: true }));
    assert.equal((await app.inject({ url: "/api/v1/migrations-x" })).statusCode, 401);
    await app.close();
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});
