// Z81-06: 없는 경로도 우리 오류 모양 {status, code, message, requestId}. DB 없이 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { errorsPlugin } from "../src/plugins/errors.js";

test("없는 경로 → 404 NOT_FOUND, 오류 모양 한 가지 (쿼리 문자열은 메시지에 안 넣음)", async () => {
  const app = Fastify();
  await app.register(errorsPlugin);
  await app.register(async (r) => { r.get("/x", async () => ({ ok: true })); }, { prefix: "/api/v1" });
  try {
    const r = await app.inject({ url: "/api/v1/nope?token=abc" });
    assert.equal(r.statusCode, 404);
    const b = r.json();
    assert.deepEqual(Object.keys(b).sort(), ["code", "message", "requestId", "status"]);
    assert.equal(b.code, "NOT_FOUND");
    assert.equal(b.status, 404);
    assert.ok(!b.message.includes("token"), b.message);
    assert.equal((await app.inject({ url: "/api/v1/x" })).statusCode, 200);
  } finally { await app.close(); }
});
