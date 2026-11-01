// DB 시험(작업 Z12) 시나리오 3: 같은 Idempotency-Key 요청이 "동시에" 2개·10개 올 때 하나만 처리되는가
// (기존 idempotency.db.test·fault-routes.db.test는 차례로 두 번 보낸 경우만 본다)
// 진짜 경로(POST /migrations, /plans/:id/approvals, /migrations/:id/start)를 app.inject로 Promise.all 동시 호출.
// 큐 작업 처리에는 기대지 않는다 (다른 시험 파일의 워커가 작업을 집어 가도 결과 판정과 무관하게 짰다)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), T2 = randomUUID();
let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { migrationRoutes } = await import("../src/routes/migrations.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z12-idem'), ($2,'test-z12-idem-2')", [T, T2]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(migrationRoutes, { prefix: P });
  await app.register(planRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id = ANY($1)", [[T, T2]]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function envPair(tenant = T) {
  const s = randomUUID(), g = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, g, tenant]);
  return { s, g };
}
const post = (url: string, payload: object | undefined, key?: string, tenant = T) => app.inject({
  method: "POST", url: `${P}${url}`, payload,
  headers: { "x-dev-tenant": tenant, ...(key ? { "idempotency-key": key } : {}) } });
const migCount = async (src: string) => (await owner.query(
  "SELECT count(*)::int n FROM migrations WHERE source_env_id=$1", [src])).rows[0].n as number;

test("POST /migrations 같은 키 동시 2개 → 이전 1개, 둘 다 202 같은 id, 재생 1개", { skip }, async () => {
  const e = await envPair(); const k = `z12-${randomUUID()}`;
  const body = { sourceEnvId: e.s, targetEnvId: e.g };
  const [a, b] = await Promise.all([post("/migrations", body, k), post("/migrations", body, k)]);
  assert.deepEqual([a.statusCode, b.statusCode], [202, 202]);
  assert.equal(a.json().id, b.json().id);
  assert.equal([a, b].filter((r) => r.headers["idempotent-replayed"] === "true").length, 1);
  assert.equal(await migCount(e.s), 1);
});

test("POST /migrations 같은 키 동시 10개 ×5회 → 매번 이전 1개, 재생 9개 (지연 측정)", { skip }, async () => {
  const lat: number[] = [];
  for (let round = 0; round < 5; round++) {
    const e = await envPair(); const k = `z12-${randomUUID()}`;
    const body = { sourceEnvId: e.s, targetEnvId: e.g };
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: 10 }, () => post("/migrations", body, k)));
    lat.push(performance.now() - t0);
    assert.ok(rs.every((r) => r.statusCode === 202), rs.map((r) => r.statusCode).join(","));
    assert.equal(new Set(rs.map((r) => r.json().id)).size, 1);
    assert.equal(rs.filter((r) => r.headers["idempotent-replayed"] === "true").length, 9);
    assert.equal(await migCount(e.s), 1);
    const jobs = await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE name='import' AND data->>'migrationId'=$1", [rs[0]!.json().id]);
    assert.equal(jobs.rows[0].n, 1, "import 작업도 1개");
  }
  lat.sort((x, y) => x - y);
  console.log(`[z12] same key x10 concurrent: median ${lat[2]!.toFixed(1)} ms (min ${lat[0]!.toFixed(1)}, max ${lat[4]!.toFixed(1)})`);
});

test("같은 키, 다른 본문 동시 2개 → 하나 202, 다른 하나 409 IDEMPOTENCY_KEY_REUSED, 이전 1개", { skip }, async () => {
  const e1 = await envPair(), e2 = await envPair(); const k = `z12-${randomUUID()}`;
  const [a, b] = await Promise.all([
    post("/migrations", { sourceEnvId: e1.s, targetEnvId: e1.g }, k),
    post("/migrations", { sourceEnvId: e2.s, targetEnvId: e2.g }, k)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [202, 409]);
  const loser = a.statusCode === 409 ? a : b;
  assert.equal(loser.json().code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal((await migCount(e1.s)) + (await migCount(e2.s)), 1);
});

test("같은 키 문자열, 다른 회사 동시 → 회사마다 따로 처리 (서로 기다리지 않음)", { skip }, async () => {
  const e1 = await envPair(T), e2 = await envPair(T2); const k = `z12-${randomUUID()}`;
  const [a, b] = await Promise.all([
    post("/migrations", { sourceEnvId: e1.s, targetEnvId: e1.g }, k, T),
    post("/migrations", { sourceEnvId: e2.s, targetEnvId: e2.g }, k, T2)]);
  assert.deepEqual([a.statusCode, b.statusCode], [202, 202]);
  assert.notEqual(a.json().id, b.json().id);
  assert.equal(a.headers["idempotent-replayed"], undefined); assert.equal(b.headers["idempotent-replayed"], undefined);
});

// 승인 대기 이전 (계획 1개, 지문 'hp')
async function seedAwaiting() {
  const e = await envPair(); const id = randomUUID(), planId = randomUUID();
  const exp = new Date(Date.now() + 2 * 3600_000).toISOString();
  const doc = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: "tf", helmValuesHash: "hv", planHash: "hp", expiresAt: exp };
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'awaiting_approval')`, [id, T, e.s, e.g]);
  await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
    VALUES ($1,$2,$3,$4,'hp',$5)`, [planId, T, id, JSON.stringify(doc), exp]);
  return { id, planId };
}

test("승인 같은 키 동시 2개 → 200 둘 다(하나는 재생), 승인 기록 1줄, 잠금 2줄", { skip }, async () => {
  const m = await seedAwaiting(); const k = `z12-${randomUUID()}`;
  const body = { decision: "approve", planHash: "hp" };
  const [a, b] = await Promise.all([post(`/plans/${m.planId}/approvals`, body, k), post(`/plans/${m.planId}/approvals`, body, k)]);
  assert.deepEqual([a.statusCode, b.statusCode], [200, 200], `${a.body} | ${b.body}`);
  assert.equal([a, b].filter((r) => r.headers["idempotent-replayed"] === "true").length, 1);
  const n = await owner.query("SELECT count(*)::int n FROM plan_approvals WHERE migration_id=$1", [m.id]);
  assert.equal(n.rows[0].n, 1);
  const l = await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [m.id]);
  assert.equal(l.rows[0].n, 2);
});

test("start 같은 키 동시 2개 → 202 둘 다, apply 작업 1개 / 키 없이 동시 2개 → 202 + 409, apply 1개", { skip }, async () => {
  for (const withKey of [true, false]) {
    const m = await seedAwaiting();
    const ap = await post(`/plans/${m.planId}/approvals`, { decision: "approve", planHash: "hp" });
    assert.equal(ap.statusCode, 200);
    const k = withKey ? `z12-${randomUUID()}` : undefined;
    const [a, b] = await Promise.all([post(`/migrations/${m.id}/start`, undefined, k), post(`/migrations/${m.id}/start`, undefined, k)]);
    const codes = [a.statusCode, b.statusCode].sort();
    if (withKey) assert.deepEqual(codes, [202, 202]);
    else { assert.deepEqual(codes, [202, 409]); assert.equal((a.statusCode === 409 ? a : b).json().code, "INVALID_TRANSITION"); }
    const j = await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE name='apply' AND data->>'migrationId'=$1", [m.id]);
    assert.equal(j.rows[0].n, 1, `apply 작업 수 (key=${withKey})`);
  }
});
