// Z52 (모의 심사 Q31): 요청 횟수 제한. DB 없이 fastify inject로 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { authPlugin } from "../src/plugins/auth.js";
import { errorsPlugin } from "../src/plugins/errors.js";
import { rateLimitPlugin, rateLimitOptsFromEnv } from "../src/plugins/rate-limit.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function appWith(o: { readMax: number; writeMax: number }) {
  const app = Fastify();
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(rateLimitPlugin, { ...o, enabled: true });
  app.get("/healthz", async () => ({ ok: true }));
  await app.register(async (r) => {
    r.get("/migrations", async () => ({ ok: true }));
    r.post("/migrations", async () => ({ ok: true }));
    r.get("/docs/openapi.json", async () => ({ ok: true }));
  }, { prefix: "/api/v1" });
  return app;
}
const get = (app: Awaited<ReturnType<typeof appWith>>, t = A, url = "/api/v1/migrations") =>
  app.inject({ method: "GET", url, headers: { "x-dev-tenant": t } });
const post = (app: Awaited<ReturnType<typeof appWith>>, t = A) =>
  app.inject({ method: "POST", url: "/api/v1/migrations", headers: { "x-dev-tenant": t }, payload: {} });

test("쓰기 한도를 넘으면 429 + 우리 오류 모양 + retry-after", async () => {
  const app = await appWith({ readMax: 100, writeMax: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await post(app)).statusCode, 200);
  const r = await post(app);
  assert.equal(r.statusCode, 429);
  const body = r.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.equal(body.status, 429);
  assert.ok(body.requestId);
  assert.ok(r.headers["retry-after"]);
  await app.close();
});

test("읽기와 쓰기는 따로 센다: 쓰기를 다 써도 읽기는 된다", async () => {
  const app = await appWith({ readMax: 5, writeMax: 1 });
  await post(app);
  assert.equal((await post(app)).statusCode, 429);
  assert.equal((await get(app)).statusCode, 200);
  await app.close();
});

test("회사마다 따로 센다: A가 막혀도 B는 된다", async () => {
  const app = await appWith({ readMax: 2, writeMax: 2 });
  await get(app, A); await get(app, A);
  assert.equal((await get(app, A)).statusCode, 429);
  assert.equal((await get(app, B)).statusCode, 200);
  await app.close();
});

test("프로브·API 문서는 세지 않는다", async () => {
  const app = await appWith({ readMax: 1, writeMax: 1 });
  for (let i = 0; i < 5; i++) assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
  for (let i = 0; i < 5; i++) assert.equal((await get(app, A, "/api/v1/docs/openapi.json")).statusCode, 200);
  await app.close();
});

test("인증 실패(401)는 한도보다 먼저: 헤더 없는 요청은 세기 전에 401", async () => {
  const app = await appWith({ readMax: 1, writeMax: 1 });
  for (let i = 0; i < 3; i++) assert.equal((await app.inject({ method: "GET", url: "/api/v1/migrations" })).statusCode, 401);
  await app.close();
});

test("환경 변수: RATE_LIMIT=0 이면 끔, 기본 3000/120", () => {
  assert.equal(rateLimitOptsFromEnv({ RATE_LIMIT: "0" }).enabled, false);
  const d = rateLimitOptsFromEnv({});
  assert.deepEqual([d.enabled, d.readMax, d.writeMax], [true, 3000, 120]);
  assert.equal(rateLimitOptsFromEnv({ RATE_LIMIT_WRITE_PER_MIN: "abc" }).writeMax, 120);
});
