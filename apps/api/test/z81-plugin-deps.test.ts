// Z81: fastify-plugin name·dependencies 확인. DB 없이 돈다
import { test } from "node:test";
import assert from "node:assert/strict";

test("플러그인 의존성: svc-auth 없이 요청 제한 플러그인을 등록하면 뜨기 전에 멈춘다 (Z81 fastify-plugin dependencies)", async () => {
  const Fastify = (await import("fastify")).default;
  const { rateLimitPlugin } = await import("../src/plugins/rate-limit.js");
  const app = Fastify();
  app.register(rateLimitPlugin, { enabled: true });
  await assert.rejects(async () => { await app.ready(); }, /svc-auth/);
  await app.close().catch(() => {});
});

test("플러그인 의존성: 관측 플러그인도 svc-auth 뒤에만, 순서가 맞으면 뜬다", async () => {
  const Fastify = (await import("fastify")).default;
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { observabilityPlugin, createApiRegistry } = await import("../src/plugins/observability.js");
  const bad = Fastify();
  bad.register(observabilityPlugin, { registry: createApiRegistry() });
  await assert.rejects(async () => { await bad.ready(); }, /svc-auth/);
  await bad.close().catch(() => {});
  const ok = Fastify();
  await ok.register(authPlugin);
  await ok.register(observabilityPlugin, { registry: createApiRegistry() });
  await ok.ready();
  await ok.close();
});
