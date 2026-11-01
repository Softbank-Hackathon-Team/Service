// Z47: 개발용 헤더 인증 + Cloudflare 터널로 들어온 요청은 읽기만 된다
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { authPlugin } from "../src/plugins/auth.js";

const T = "11111111-1111-4111-8111-111111111111";

async function app() {
  const a = Fastify();
  await a.register(authPlugin);
  await a.register(async (r) => {
    r.get("/migrations", async (req) => ({ tenant: req.tenantId, actor: req.actor }));
    r.post("/migrations", async () => ({ ok: true }));
  }, { prefix: "/api/v1" });
  return a;
}

test("로컬(터널 헤더 없음): 읽기·쓰기 모두 된다", async () => {
  const a = await app();
  assert.equal((await a.inject({ method: "GET", url: "/api/v1/migrations", headers: { "x-dev-tenant": T } })).statusCode, 200);
  assert.equal((await a.inject({ method: "POST", url: "/api/v1/migrations", headers: { "x-dev-tenant": T }, payload: {} })).statusCode, 200);
  await a.close();
});

test("터널(cf-connecting-ip): 읽기는 되고 actor 에 터널 표시", async () => {
  const a = await app();
  const r = await a.inject({ method: "GET", url: "/api/v1/migrations", headers: { "x-dev-tenant": T, "cf-connecting-ip": "203.0.113.7" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().actor, "user:dev-tunnel");
  await a.close();
});

test("터널(cf-connecting-ip·cf-ray): 쓰기는 403 TUNNEL_READ_ONLY", async () => {
  const a = await app();
  for (const h of [{ "cf-connecting-ip": "203.0.113.7" }, { "cf-ray": "8f00000000000000-ICN" }]) {
    const r = await a.inject({ method: "POST", url: "/api/v1/migrations", headers: { "x-dev-tenant": T, ...h }, payload: {} });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().code, "TUNNEL_READ_ONLY");
  }
  await a.close();
});

test("DEV_TUNNEL_WRITE=1 이면 터널 쓰기도 허용 (명시적으로 켰을 때만)", async () => {
  process.env.DEV_TUNNEL_WRITE = "1";
  try {
    const a = await app();
    const r = await a.inject({ method: "POST", url: "/api/v1/migrations", headers: { "x-dev-tenant": T, "cf-connecting-ip": "203.0.113.7" }, payload: {} });
    assert.equal(r.statusCode, 200);
    await a.close();
  } finally { delete process.env.DEV_TUNNEL_WRITE; }
});
