// PF 2회차(공격자): 남의 회사 이전·계획에 오케 쓰기 길을 전부 눌러 본다 → 404, 상태·작업·감사 그대로
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const A = randomUUID(), B = randomUUID();

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  const { controlRoutes } = await import("../src/routes/control.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'pf-a'), ($2,'pf-b')", [A, B]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin); await app.register(authPlugin); await app.register(idempotencyPlugin);
  await app.register(planRoutes, { prefix: P }); await app.register(controlRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id IN ($1,$2)", [A, B]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seedA(status: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, A]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, failed_at_status, paused_from)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, A, src, dst, status, status === "failed" ? "provisioning" : null, status === "paused" ? "syncing" : null]);
  const planId = randomUUID();
  await core.withTenant(A, (tx) => core.savePlan(tx, A, { planId, migrationId: id, adapterVersion: "t", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 }, tfPlanHash: "tf", helmValuesHash: "h",
    planHash: `h-${planId}`, expiresAt: new Date(Date.now() + 3600e3).toISOString() } as never));
  return { id, planId, planHash: `h-${planId}` };
}
const snap = async (id: string) => {
  const m = (await owner.query("SELECT status, version FROM migrations WHERE id=$1", [id])).rows[0];
  const j = (await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE data->>'migrationId'=$1", [id])).rows[0].n;
  const a = (await owner.query("SELECT count(*)::int n FROM audit_events WHERE target=$1", [id])).rows[0].n;
  return { ...m, jobs: j, audits: a };
};
const asB = (url: string, payload: unknown) => app.inject({ method: "POST", url: `${P}${url}`, payload: payload as object,
  headers: { "x-dev-tenant": B, "idempotency-key": randomUUID() } });

const CASES: [string, (s: { id: string; planId: string; planHash: string }) => [string, unknown]][] = [
  ["awaiting_approval", (s) => [`/plans/${s.planId}/approvals`, { decision: "approve", planHash: s.planHash, acks: [] }]],
  ["awaiting_approval", (s) => [`/plans/${s.planId}/approvals`, { decision: "reject", planHash: s.planHash }]],
  ["approved", (s) => [`/migrations/${s.id}/start`, { planHash: s.planHash }]],
  ["failed", (s) => [`/migrations/${s.id}/replan`, {}]],
  ["rejected", (s) => [`/migrations/${s.id}/spec/reopen`, undefined]],
  ["spec_review", (s) => [`/migrations/${s.id}/plan`, undefined]],
  ["syncing", (s) => [`/migrations/${s.id}/rollback`, {}]],
  ["rollback_window", (s) => [`/migrations/${s.id}/reclaim`, {}]],
  ["paused", (s) => [`/migrations/${s.id}/resume`, {}]],
  ["rolled_back", (s) => [`/migrations/${s.id}/replication-cleanup`, {}]],
  ["failed", (s) => [`/migrations/${s.id}/cancel`, { manualCleanupConfirmed: true }]],
];

for (const [status, mk] of CASES) {
  test(`PF 거부: 회사 B 가 회사 A 의 ${status} 이전에 ${mk({ id: "<id>", planId: "<plan>", planHash: "" })[0]} → 404, 상태·작업·감사 그대로`, { skip }, async () => {
    const s = await seedA(status);
    const before = await snap(s.id);
    const [url, body] = mk(s);
    const r = await asB(url, body);
    assert.equal(r.statusCode, 404, `${url}: ${r.statusCode} ${r.body}`);
    assert.deepEqual(await snap(s.id), before);
  });
}

test("PF 정상(대조): 같은 길을 회사 A 가 누르면 404 가 아니다 (위 404 가 경로 오타가 아님)", { skip }, async () => {
  const s = await seedA("rolled_back");
  const r = await app.inject({ method: "POST", url: `${P}/migrations/${s.id}/replication-cleanup`, payload: {},
    headers: { "x-dev-tenant": A, "idempotency-key": randomUUID() } });
  assert.equal(r.statusCode, 202, r.body);
});
