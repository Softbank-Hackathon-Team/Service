// 지표 토큰 DB 시험: 연결된 환경만 발급, DB 에는 해시만, 다시 받으면·해제하면 끊김, 남의 회사 404
// DATABASE_URL(app_user)·OWNER_DATABASE_URL(표 주인)이 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const T = randomUUID(), OTHER = randomUUID();
const H = { "x-dev-tenant": T }, HO = { "x-dev-tenant": OTHER };

let owner: pg.Client;
let app: FastifyInstance;
let core: typeof import("@svc/core");
let tokens: typeof import("../src/auth/metric-token.js");

async function newEnv(status: string) {
  const id = randomUUID();
  await owner.query("SELECT set_config('app.tenant_id', $1, false)", [T]);
  await owner.query("INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$2,'aws',$3,$4)",
    [id, T, `mt-${id}`, status]);
  return id;
}
const issue = (id: string, headers = H) => app.inject({ method: "POST", url: `/api/v1/environments/${id}/metric-token`, headers });
const lookup = (token: string) => tokens.dbMetricTokenLookup(tokens.hashMetricToken(token));

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  tokens = await import("../src/auth/metric-token.js");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { environmentRoutes } = await import("../src/routes/environments.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-mt'), ($2,'test-mt-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(environmentRoutes, { prefix: "/api/v1" });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await app.close();
  await core.boss.stop({ graceful: false });
  await owner.end();
  await core.pool.end();
});

test("발급: 원문은 응답에만, DB 에는 해시만, 찾으면 회사·환경", { skip }, async () => {
  const id = await newEnv("connected");
  const r = await issue(id);
  assert.equal(r.statusCode, 201);
  assert.equal(r.headers["cache-control"], "no-store");
  const { envId, token } = r.json();
  assert.equal(envId, id);
  assert.match(token, /^svc_mt_[A-Za-z0-9_-]{43}$/);
  const stored = await owner.query("SELECT token_hash FROM metric_tokens WHERE env_id = $1", [id]);
  assert.equal(stored.rows[0].token_hash, tokens.hashMetricToken(token));
  assert.deepEqual(await lookup(token), { tenantId: T, envId: id });
  assert.equal(await lookup("svc_mt_unknown"), undefined);
});

test("다시 받으면 이전 토큰은 끊긴다, 환경을 해제해도 끊긴다", { skip }, async () => {
  const id = await newEnv("connected");
  const first = (await issue(id)).json().token;
  const second = (await issue(id)).json().token;
  assert.equal(await lookup(first), undefined);
  assert.deepEqual(await lookup(second), { tenantId: T, envId: id });
  const del = await app.inject({ method: "DELETE", url: `/api/v1/environments/${id}`, headers: { ...H, "idempotency-key": randomUUID() } });
  assert.equal(del.statusCode, 204);
  assert.equal(await lookup(second), undefined);
});

test("연결 안 된 환경은 409, 남의 회사 환경은 404", { skip }, async () => {
  const draft = await newEnv("draft");
  const r = await issue(draft);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "ENV_NOT_CONNECTED");
  const id = await newEnv("connected");
  assert.equal((await issue(id, HO)).statusCode, 404);
});

test("앱 계정은 회사 경계 밖의 토큰 줄을 못 읽는다", { skip }, async () => {
  const id = await newEnv("connected");
  await issue(id);
  const rows = await core.withTenant(OTHER, async (tx) => (await tx.query("SELECT 1 FROM metric_tokens WHERE env_id = $1", [id])).rowCount);
  assert.equal(rows, 0);
});
