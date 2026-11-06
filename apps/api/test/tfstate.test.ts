// 고객 Terraform state 내려받기 경로 (apps/api/src/routes/tfstate.ts). DB 없이 읽기·감사·worker 호출을 바꿔 끼운다
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { MigrationStatus } from "@svc/contracts";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { tfstateRoutes, TFSTATE_AUDIT_ACTION, type TfStateMigration, type TfStateRouteOpts } from "../src/routes/tfstate.js";

const T = "11111111-1111-4111-8111-111111111111";       // 로그인한 회사
const OTHER = "99999999-9999-4999-8999-999999999999";   // 다른 회사
const M = "22222222-2222-4222-8222-222222222222";
const M_OTHER = "33333333-3333-4333-8333-333333333333";
const ENV = "55555555-5555-4555-8555-555555555555";
const TOKEN = "k".repeat(40);
const URL_BASE = "http://worker-state-export.platform.svc.cluster.local:8081";
const STATE = JSON.stringify({ version: 4, serial: 3, resources: [{ type: "aws_db_instance" }] });
const H = { "x-dev-tenant": T };

// 회사별 이전 (RLS 흉내: 다른 회사 이전은 안 보인다)
const DB: Record<string, Record<string, TfStateMigration>> = {
  [T]: { [M]: { status: "completed", targetEnvId: ENV } },
  [OTHER]: { [M_OTHER]: { status: "completed", targetEnvId: ENV } },
};

type Call = { url: string; token: string | null };
async function appWith(o: { status?: MigrationStatus; fetch?: TfStateRouteOpts["fetch"]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  const audits: Array<{ tenantId: string; entry: Record<string, unknown> }> = [];
  const calls: Call[] = [];
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  const routeOpts: TfStateRouteOpts & { prefix: string } = {
    prefix: "/api/v1",
    load: async (tenantId, id) => {
      const m = DB[tenantId]?.[id];
      return m && o.status ? { ...m, status: o.status } : m ?? null;
    },
    audit: async (tenantId, entry) => { audits.push({ tenantId, entry: entry as unknown as Record<string, unknown> }); },
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    env: o.env ?? { WORKER_STATE_EXPORT_URL: URL_BASE + "/", INTERNAL_STATE_TOKEN: TOKEN },
    fetch: o.fetch ?? (async (input, init) => {
      calls.push({ url: String(input), token: new Headers(init?.headers).get("x-internal-token") });
      return new Response(STATE, { status: 200, headers: { "content-type": "application/json", "content-length": String(STATE.length) } });
    }),
  };
  await app.register(tfstateRoutes, routeOpts);
  return { app, audits, calls };
}

test("정상: 끝난 이전 → worker 창구 본문을 그대로, 내려받기 머리글 + 감사 한 줄 (내용 없음)", async () => {
  const { app, audits, calls } = await appWith();
  const r = await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate`, headers: H });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, STATE);
  assert.match(String(r.headers["content-type"]), /application\/json/);
  assert.equal(r.headers["content-disposition"], `attachment; filename="${M}-app.tfstate"`);
  assert.equal(r.headers["cache-control"], "no-store");
  // worker 경로: 로그인한 회사의 slug + 앱 층 + 이전 id, 토큰 머리글
  assert.deepEqual(calls, [{ url: `${URL_BASE}/internal/state/t-11111111/app/${M}`, token: TOKEN }]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.tenantId, T);
  assert.deepEqual(audits[0]!.entry, { actor: `user:dev`, action: TFSTATE_AUDIT_ACTION, target: M, result: "ok", detail: { layer: "app" } });
  assert.ok(!JSON.stringify(audits).includes("aws_db_instance"));
});

test("layer=env: 이전의 도착 환경 id 로 worker 를 부르고 감사에 층·환경을 남긴다", async () => {
  const { app, audits, calls } = await appWith();
  const r = await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate?layer=env`, headers: H });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-disposition"], `attachment; filename="${M}-env.tfstate"`);
  assert.equal(calls[0]!.url, `${URL_BASE}/internal/state/t-11111111/env/${ENV}`);
  assert.deepEqual(audits[0]!.entry.detail, { layer: "env", envId: ENV });
});

test("남의 회사 이전은 404 (403 아님), worker·감사 안 부름", async () => {
  const { app, audits, calls } = await appWith();
  const r = await app.inject({ method: "GET", url: `/api/v1/migrations/${M_OTHER}/tfstate`, headers: H });
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().code, "NOT_FOUND");
  assert.equal(calls.length, 0);
  assert.equal(audits.length, 0);
});

test("안 끝난 이전은 409 INVALID_TRANSITION (failed 도 아직 끝이 아님), worker·감사 안 부름", async () => {
  for (const s of ["shifting", "rollback_window", "failed", "paused"] as const) {
    const { app, audits, calls } = await appWith({ status: s });
    const r = await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate`, headers: H });
    assert.equal(r.statusCode, 409, s);
    assert.equal(r.json().code, "INVALID_TRANSITION");
    assert.equal(calls.length + audits.length, 0);
  }
  for (const s of ["rolled_back", "cancelled"] as const) {
    const { app } = await appWith({ status: s });
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate`, headers: H })).statusCode, 200, s);
  }
});

test("worker 꺼짐(연결 실패)·5xx·시간 초과 → 503 STATE_EXPORT_UNAVAILABLE", async () => {
  const refused = await appWith({ fetch: async () => { throw new TypeError("fetch failed"); } });
  const a = await refused.app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate`, headers: H });
  assert.equal(a.statusCode, 503);
  assert.equal(a.json().code, "STATE_EXPORT_UNAVAILABLE");
  assert.ok(!a.body.includes(TOKEN));

  const five = await appWith({ fetch: async () => new Response("boom", { status: 500 }) });
  const b = await five.app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate`, headers: H });
  assert.equal(b.statusCode, 503);
  assert.ok(!b.body.includes("boom"));

  // 머리글이 안 오면 timeoutMs 뒤 끊는다 (기본 10초, 시험은 50ms)
  const hang = await appWith({ timeoutMs: 50, fetch: (_u, init) => new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
  }) });
  const c = await hang.app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate`, headers: H });
  assert.equal(c.statusCode, 503);
  assert.equal(c.json().code, "STATE_EXPORT_UNAVAILABLE");
});

test("worker 404 → 404 STATE_NOT_FOUND", async () => {
  const { app } = await appWith({ fetch: async () => new Response('{"status":404}', { status: 404 }) });
  const r = await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate`, headers: H });
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().code, "STATE_NOT_FOUND");
});

test("설정 없음 → 503 STATE_EXPORT_NOT_CONFIGURED (worker 안 부름)", async () => {
  for (const env of [{}, { WORKER_STATE_EXPORT_URL: URL_BASE }, { INTERNAL_STATE_TOKEN: TOKEN }]) {
    const { app, calls } = await appWith({ env });
    const r = await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate`, headers: H });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().code, "STATE_EXPORT_NOT_CONFIGURED");
    assert.equal(calls.length, 0);
  }
});

test("거부: 로그인 없음 401 / 이전 id 모양 400 / 모르는 층 400", async () => {
  const { app, calls } = await appWith();
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate` })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/migrations/nope/tfstate", headers: H })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/tfstate?layer=db`, headers: H })).statusCode, 400);
  assert.equal(calls.length, 0);
});
