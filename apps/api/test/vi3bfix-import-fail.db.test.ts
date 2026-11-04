// VI3bfix: 가져오기가 영구 실패(IMPORT_SPEC_INVALID)한 이전을 API 로 볼 때 모양 (이전 보기·타임라인 200, 남의 회사는 ApiError 404)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { ApiError, MigrationView } from "@svc/contracts";

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
  const { timelineRoutes } = await import("../src/routes/timeline.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vi3bfix-api'), ($2,'test-vi3bfix-api-o')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(migrationRoutes, { prefix: P });
  await app.register(timelineRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

test("영구 실패 이전: GET 은 MigrationView(failed·IMPORT_SPEC_INVALID·failedAt importing), 타임라인에 같은 사유, 남의 회사 404 는 ApiError", { skip }, async () => {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'gcp','s','connected'), ($2,$3,'aws','d','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  // 가져오기 처리기가 영구 실패 때 하는 것과 같은 전이 (명세 구조 오류 → failed IMPORT_SPEC_INVALID)
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "importing", "failed", {
    mode: "ifStill", failureCode: "IMPORT_SPEC_INVALID",
    audit: { actor: "worker", action: "migration.failed", target: id, result: "error",
             detail: { requestId: "r-vi3bfix-api", error: "SPEC_V2_INVALID", attempts: 1, permanent: true } },
  }));

  const g = await app.inject({ method: "GET", url: `${P}/migrations/${id}`, headers: { "x-dev-tenant": T } });
  assert.equal(g.statusCode, 200, g.body);
  const v = MigrationView.parse(g.json());
  assert.equal(v.status, "failed");
  assert.equal(v.failureCode, "IMPORT_SPEC_INVALID");
  assert.equal(v.failedAtStatus, "importing");

  const tl = await app.inject({ method: "GET", url: `${P}/migrations/${id}/timeline`, headers: { "x-dev-tenant": T } });
  assert.equal(tl.statusCode, 200, tl.body);
  const items = tl.json().items as Array<{ to: string | null; failureCode: string | null }>;
  assert.ok(items.some((x) => x.to === "failed" && x.failureCode === "IMPORT_SPEC_INVALID"));

  for (const url of [`${P}/migrations/${id}`, `${P}/migrations/${id}/timeline`]) {
    const o = await app.inject({ method: "GET", url, headers: { "x-dev-tenant": OTHER } });
    assert.equal(o.statusCode, 404);
    const e = ApiError.parse(o.json());
    assert.equal(e.status, 404);
    assert.ok(!o.body.includes("SPEC_V2_INVALID"));
  }
});
