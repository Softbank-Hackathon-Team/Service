// DB 시험: 멱등 키 플러그인을 실제 Fastify에 붙여 app.inject()로 부른다 (포트 안 엶)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const T = "11111111-1111-4111-8111-111111111111";   // 0002 시드 회사
let app: FastifyInstance;
let pool: { end(): Promise<void> };
let runs = 0;

before(async () => {
  if (skip) return;
  const core = await import("@svc/core");
  pool = core.pool;
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  app.post("/things", async (req, reply) => req.idempotent(reply, async (tx) => {
    runs++;
    const r = await tx.query("SELECT gen_random_uuid() AS id");
    return { status: 202, body: { id: r.rows[0].id as string } };
  }));
  await app.ready();
});
after(async () => { if (!skip) { await app.close(); await pool.end(); } });

const call = (key: string | undefined, body: object) => app.inject({
  method: "POST", url: "/things", payload: body,
  headers: { "x-dev-tenant": T, ...(key ? { "idempotency-key": key } : {}) } });

test("같은 키 두 번 → 처리 1번, 두 번째는 재생 헤더 + 같은 응답", { skip }, async () => {
  const k = `key-${randomUUID()}`; const before = runs;
  const a = await call(k, { x: 1 }); const b = await call(k, { x: 1 });
  assert.equal(a.statusCode, 202); assert.equal(b.statusCode, 202);
  assert.equal(a.json().id, b.json().id);
  assert.equal(b.headers["idempotent-replayed"], "true");
  assert.equal(runs - before, 1);
});
test("같은 키, 다른 본문 → 409 IDEMPOTENCY_KEY_REUSED", { skip }, async () => {
  const k = `key-${randomUUID()}`;
  await call(k, { x: 1 });
  const r = await call(k, { x: 2 });
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, "IDEMPOTENCY_KEY_REUSED");
});
test("이상한 키 모양 → 400, 키 없음 → 매번 처리", { skip }, async () => {
  assert.equal((await call("short", {})).statusCode, 400);
  const a = await call(undefined, {}); const b = await call(undefined, {});
  assert.notEqual(a.json().id, b.json().id);
});

test("/healthz·/readyz는 인증 헤더 없이 200", { skip }, async () => {
  const p = Fastify();
  const { authPlugin } = await import("../src/plugins/auth.js");
  await p.register(authPlugin);
  p.get("/healthz", async () => ({ ok: true }));
  p.get("/readyz", async () => ({ ok: true }));
  p.get("/x", async () => ({ ok: true }));
  assert.equal((await p.inject({ url: "/healthz" })).statusCode, 200);
  assert.equal((await p.inject({ url: "/readyz" })).statusCode, 200);
  assert.equal((await p.inject({ url: "/x" })).statusCode, 401);
  await p.close();
});
