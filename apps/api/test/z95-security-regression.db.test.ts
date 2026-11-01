// DB 시험 (Z95): 보안 회귀를 진짜 DB(app_user, RLS)에서 읽는다. app.inject() 로 부른다
//  - 감사의 security.live_check 줄(쪽마다 최신)로 비교한다
//  - 남의 회사 이전은 404, 점검 기록이 없으면 verdict unavailable
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;
const get = (tenant: string, id: string) =>
  app.inject({ url: `${P}/migrations/${id}/security/regression`, headers: { "x-dev-tenant": tenant } });

const report = (side: "source" | "target", states: Record<string, string>) => ({
  side, provider: side === "source" ? "onprem" : "aws", envId: randomUUID(),
  checkedAt: new Date().toISOString(), durationMs: 5, origin: "live", credentials: side === "source" ? "n_a" : "ok", reason: null,
  summary: { pass: 0, warn: 0, fail: 0, unavailable: 0, na: 0 },
  checks: Object.entries(states).map(([key, state]) => ({ key, category: key.split(".")[0], title: key,
    resource: "r", state, evidence: `${side}:${state}`, source: "read" })),
});

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { securityRoutes } = await import("../src/routes/security.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z95'), ($2,'test-z95-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(securityRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
});

async function seed(tenant: string, audits: { action: string; detail?: Record<string, unknown> }[]) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','k3s','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, tenant]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'completed')`,
    [id, tenant, src, dst]);
  await core.withTenant(tenant, async (tx) => {
    for (const a of audits) await core.writeAudit(tx, tenant, { actor: "worker", target: id, result: "ok", ...a });
  });
  return id;
}

test("쪽마다 최신 점검으로 비교: 오래된 도착 점검은 무시, 회귀 1건", { skip }, async () => {
  const id = await seed(T, [
    { action: "security.live_check", detail: { report: report("target", { "public_ports.db": "pass" }) } },   // 오래됨
    { action: "security.live_check", detail: { report: report("source", { "public_ports.db": "pass", "tls.db": "warn" }) } },
    { action: "security.live_check", detail: { report: report("target", { "public_ports.db": "fail", "tls.db": "pass" }) } },
  ]);
  const res = await get(T, id);
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.deepEqual([b.verdict, b.recorded, b.summary], ["regressed", false, { worse: 1, better: 1, same: 0, unknown: 0 }]);
  assert.deepEqual([b.source.origin, b.target.origin], ["snapshot", "snapshot"]);
  assert.deepEqual([b.items[0].key, b.items[0].before, b.items[0].after], ["public_ports.db", "pass", "fail"]);
});

test("점검 기록 없으면 unavailable, 남의 회사 이전은 404 (RLS)", { skip }, async () => {
  const id = await seed(T, [{ action: "migration.importing", detail: { from: "draft", to: "importing" } }]);
  const b = (await get(T, id)).json();
  assert.deepEqual([b.verdict, b.items.length, b.source, b.target], ["unavailable", 0, null, null]);
  assert.equal((await get(OTHER, id)).statusCode, 404);
});
