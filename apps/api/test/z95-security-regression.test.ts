// 보안 회귀 경로 (Z95): GET /api/v1/migrations/:id/security/regression. DB 없이 재료 읽기를 바꿔 끼운다
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { NotFound } from "@svc/core";
import { ApiError, LiveSecurityReport, SecurityRegression } from "@svc/contracts";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { securityRoutes } from "../src/routes/security.js";
import { buildRegression, type RegressionInput } from "../src/security/regression.js";

const T = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";
const NOW = new Date(Date.UTC(2026, 10, 7, 3, 30, 0));

const rep = (side: "source" | "target", states: Record<string, LiveSecurityReport["checks"][number]["state"]>,
  origin: "live" | "snapshot" = "live"): LiveSecurityReport => LiveSecurityReport.parse({
  side, provider: side === "source" ? "aws" : "gcp", envId: side === "source" ? "env-src" : "env-dst",
  checkedAt: "2026-11-07T03:00:00.000Z", durationMs: 12, origin, credentials: "ok", reason: null,
  summary: { pass: 0, warn: 0, fail: 0, unavailable: 0, na: 0 },
  checks: Object.entries(states).map(([key, state]) => ({ key, category: key.split(".")[0], title: key,
    resource: "r", state, evidence: `${side} ${state}`, source: "read api" })),
});

test("buildRegression: 계약 모양, recorded=false, 회귀 판정", () => {
  const r = SecurityRegression.parse(buildRegression({ migrationId: M, now: NOW,
    source: rep("source", { "public_ports.db": "pass", "tls.db": "fail" }, "snapshot"),
    target: rep("target", { "public_ports.db": "fail", "tls.db": "pass" }, "snapshot") }));
  assert.deepEqual([r.verdict, r.recorded, r.migrationId, r.generatedAt], ["regressed", false, M, NOW.toISOString()]);
  assert.deepEqual(r.summary, { worse: 1, better: 1, same: 0, unknown: 0 });
  assert.equal(r.items[0]!.key, "public_ports.db");
  const empty = SecurityRegression.parse(buildRegression({ migrationId: M, now: NOW, source: null, target: null }));
  assert.deepEqual([empty.verdict, empty.items.length, empty.source, empty.target], ["unavailable", 0, null, null]);
});

async function appWith(loadRegression: (t: string, m: string) => Promise<Omit<RegressionInput, "now">>) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(securityRoutes, { prefix: "/api/v1", loadRegression, now: () => NOW });
  return app;
}

test("경로: 200 + 계약 모양 + no-store, 남의 테넌트 404, 헤더 없으면 401, uuid 아니면 400", async () => {
  const app = await appWith(async (t, m) => {
    if (m !== M || t !== T) throw new NotFound("migration", m);
    return { migrationId: m, source: rep("source", { "tls.db": "pass" }, "snapshot"), target: rep("target", { "tls.db": "pass" }, "snapshot") };
  });
  const url = `/api/v1/migrations/${M}/security/regression`;
  const ok = await app.inject({ url, headers: { "x-dev-tenant": T } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  const body = SecurityRegression.parse(ok.json());
  assert.deepEqual([body.verdict, body.summary.same], ["no_regression", 1]);
  const nf = await app.inject({ url, headers: { "x-dev-tenant": "99999999-9999-4999-8999-999999999999" } });
  assert.equal(nf.statusCode, 404);
  assert.equal(ApiError.parse(nf.json()).code, "NOT_FOUND");
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/v1/migrations/x/security/regression`, headers: { "x-dev-tenant": T } })).statusCode, 400);
  await app.close();
});
