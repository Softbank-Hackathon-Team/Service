// PF FM-ORC-23: 사람이 적은 글자에 NUL 이 있어 Postgres 가 거부(22021·22P05)하면 500 이 아니라 400 BAD_REQUEST
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

const DB = process.env.DATABASE_URL;
const skip = !DB ? "DB 없음" : false;
let core: typeof import("@svc/core");
let app: FastifyInstance;
before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  app = Fastify();
  await app.register(errorsPlugin);
  app.post("/text", async (req) => (await core.pool.query("SELECT $1::text AS v", [(req.body as { v: string }).v])).rows[0]);
  app.post("/json", async (req) => (await core.pool.query("SELECT $1::jsonb AS v", [JSON.stringify((req.body as { v: string }).v)])).rows[0]);
  await app.ready();
});
after(async () => { if (skip) return; await app.close(); await core.pool.end(); });

test("PF FM-ORC-23 정상: 평범한 글자는 그대로 200", { skip }, async () => {
  const r = await app.inject({ method: "POST", url: "/text", payload: { v: "거절 이유" } });
  assert.equal(r.statusCode, 200);
});
test("PF FM-ORC-23 거부: text 칸 NUL(22021)·jsonb \\u0000(22P05) → 400 BAD_REQUEST", { skip }, async () => {
  for (const url of ["/text", "/json"]) {
    const r = await app.inject({ method: "POST", url, payload: { v: "x\u0000y" } });
    assert.equal(r.statusCode, 400, `${url} ${r.body}`);
    assert.equal(r.json().code, "BAD_REQUEST");
  }
});
