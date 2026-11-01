// 작업 Z35 (Z15 제안 3): GET /migrations/:id/live-traffic. 회사 벽 + 응답 모양
// 프록시는 가짜 fetch 로 대신한다 (포트 안 엶). 회사·환경·이전은 시험마다 새로
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID(), S = randomUUID(), G = randomUUID(), M = randomUUID();

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;           // 프록시 주소 있음 (가짜 fetch)
let bare: FastifyInstance;          // 주소 없음
let proxyAnswer: unknown = null;
let proxyCalls = 0;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { liveTrafficRoutes } = await import("../src/routes/live-traffic.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z35'), ($2,'test-z35-other')", [T, OTHER]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'syncing')`, [M, T, S, G]);
  const build = async (opts: Parameters<typeof liveTrafficRoutes>[1]) => {
    const a = Fastify();
    a.setValidatorCompiler(validatorCompiler); a.setSerializerCompiler(serializerCompiler);
    await a.register(errorsPlugin); await a.register(authPlugin);
    await a.register(liveTrafficRoutes, { prefix: P, ...opts });
    await a.ready(); return a;
  };
  app = await build({ url: "http://proxy.test/__stats", fetch: async () => { proxyCalls++; return { ok: true, status: 200, json: async () => proxyAnswer }; } });
  delete process.env.LIVE_TRAFFIC_URL;
  bare = await build({});
});
after(async () => {
  if (skip) return;
  await app.close(); await bare.close(); await core.pool.end(); await owner.end();
});

test("프록시가 이 이전을 보고 있으면 숫자를 준다", { skip }, async () => {
  proxyAnswer = { id: M, status: "syncing", switchedAt: null, held: 0, maxHoldMs: 0, mode: "hold", since: new Date().toISOString(),
    total: 500, ok: 500, fail: 0, c4xx: 0, p50Ms: 5, p95Ms: 10.5, byState: { syncing: { n: 500, fail: 0, p95Ms: 10.5 } } };
  const r = await app.inject({ method: "GET", url: `${P}/migrations/${M}/live-traffic`, headers: { "x-dev-tenant": T } });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.available, true); assert.equal(b.total, 500); assert.equal(b.p95Ms, 10.5);
  assert.deepEqual(b.byState, [{ state: "syncing", n: 500, fail: 0, p95Ms: 10.5 }]);
});

test("다른 이전을 보는 프록시 → 200 available:false other_migration (숫자 0)", { skip }, async () => {
  proxyAnswer = { id: randomUUID(), status: "cutover", total: 9, ok: 9, fail: 0 };
  const b = (await app.inject({ method: "GET", url: `${P}/migrations/${M}/live-traffic`, headers: { "x-dev-tenant": T } })).json();
  assert.equal(b.available, false); assert.equal(b.reason, "other_migration"); assert.equal(b.total, 0);
});

test("LIVE_TRAFFIC_URL 없음 → 200 not_configured", { skip }, async () => {
  const r = await bare.inject({ method: "GET", url: `${P}/migrations/${M}/live-traffic`, headers: { "x-dev-tenant": T } });
  assert.equal(r.statusCode, 200); assert.equal(r.json().reason, "not_configured");
});

test("회사 벽: 다른 회사 헤더 → 404 (프록시를 부르기 전에 막힘), 없는 번호 404, 헤더 없음 401, 번호 모양 틀림 400", { skip }, async () => {
  proxyAnswer = { id: M, status: "syncing", total: 1, ok: 1, fail: 0 };
  const before = proxyCalls;
  assert.equal((await app.inject({ method: "GET", url: `${P}/migrations/${M}/live-traffic`, headers: { "x-dev-tenant": OTHER } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `${P}/migrations/${randomUUID()}/live-traffic`, headers: { "x-dev-tenant": T } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `${P}/migrations/${M}/live-traffic` })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: `${P}/migrations/not-a-uuid/live-traffic`, headers: { "x-dev-tenant": T } })).statusCode, 400);
  assert.equal(proxyCalls, before, "막힌 요청은 프록시를 안 부른다");
});
