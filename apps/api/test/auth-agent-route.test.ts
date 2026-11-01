// L10 (Z10 리뷰): 인증을 건너뛰는 Agent 경로는 서명 검증 표시 + preHandler 없이 등록되지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { authPlugin } from "../src/plugins/auth.js";

async function appWith(add: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify();
  await app.register(authPlugin);
  await app.register(async (r) => { add(r as never); }, { prefix: "/api/v1" });
  return app;
}
const verify = async () => {};

test("Agent 경로를 서명 검증 없이 붙이면 서버가 안 뜬다", async () => {
  await assert.rejects(async () => { await (await appWith((r) => r.post("/agent/reports", async () => ({ ok: true })))).ready(); },
    /agentSignature/);
});

test("표시만 있고 preHandler가 없어도 안 뜬다", async () => {
  await assert.rejects(async () => {
    await (await appWith((r) => r.post("/agent/reports", { config: { agentSignature: true } }, async () => ({ ok: true })))).ready();
  }, /agentSignature/);
});

test("표시 + preHandler가 있으면 등록되고, 사람 헤더 없이 처리기까지 간다", async () => {
  const app = await appWith((r) => r.post("/agent/reports",
    { config: { agentSignature: true }, preHandler: verify }, async () => ({ ok: true })));
  const res = await app.inject({ method: "POST", url: "/api/v1/agent/reports", payload: {} });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("일반 경로는 그대로: 헤더 없으면 401", async () => {
  const app = await appWith((r) => r.get("/migrations", async () => ({ ok: true })));
  const res = await app.inject({ method: "GET", url: "/api/v1/migrations" });
  assert.equal(res.statusCode, 401);
  await app.close();
});
