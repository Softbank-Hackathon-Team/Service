// Z36 (Z12-3): paused → 멈추기 전 단계로 재개 POST /api/v1/migrations/:id/resume
// 큐 작업 처리에는 기대지 않는다 (다른 시험 파일의 워커가 작업을 집어 가도 판정이 안 흔들리게, 작업은 "생겼나"만 본다)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID();
let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { controlRoutes } = await import("../src/routes/control.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z36-resume')", [T]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(controlRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

// paused(from) + 두 환경 잠금. 기본은 죽은 워커 이름 + 기한 지남 (청소가 WORKER_LOST로 멈춘 모습)
async function seedPaused(from: string, failureCode: string | null = "WORKER_LOST", holder = "worker:z36-dead", leaseSql = "now() - interval '1 second'") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, paused_from, failure_code)
    VALUES ($1,$2,$3,$4,'paused',$5,$6)`, [id, T, src, dst, from, failureCode]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,$5,${leaseSql}), ($2,$3,$4,$5,${leaseSql})`, [src, dst, T, id, holder]);
  return id;
}
const resume = (id: string, body?: object, key?: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/resume`,
  payload: body, headers: { "x-dev-tenant": T, ...(key ? { "idempotency-key": key } : {}) } });
const row = async (id: string) => (await owner.query(
  "SELECT status, paused_from, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const jobs = async (id: string, q: string) => (await owner.query(
  "SELECT count(*)::int n FROM pgboss.job WHERE name=$2 AND data->>'migrationId'=$1", [id, q])).rows[0].n as number;
const locks = async (id: string) => (await owner.query(
  "SELECT holder, round(extract(epoch from lease_expires_at - now()))::int AS left_sec FROM env_locks WHERE migration_id=$1", [id])).rows;

test("paused(deploying, WORKER_LOST) → resume → 202 deploying, deploy 작업 1개, 죽은 워커 잠금 → reserved 10분, 감사 migration.resumed", { skip }, async () => {
  const id = await seedPaused("deploying");
  const r = await resume(id, { reason: "worker restarted" });
  assert.equal(r.statusCode, 202, r.body);
  assert.deepEqual(r.json(), { id, from: "paused", status: "deploying", queue: "deploy", jobQueued: true });
  assert.deepEqual(await row(id), { status: "deploying", paused_from: null, failure_code: null });
  assert.equal(await jobs(id, "deploy"), 1);
  const l = await locks(id);
  assert.ok(l.length === 2 && l.every((x) => x.holder === "reserved" && x.left_sec > 500), JSON.stringify(l));
  const a = (await owner.query("SELECT actor, detail FROM audit_events WHERE target=$1 AND action='migration.resumed'", [id])).rows;
  assert.equal(a.length, 1); assert.equal(a[0].detail.pausedFailureCode, "WORKER_LOST"); assert.equal(a[0].detail.evidence.ruleCleared, true);
});

test("같은 Idempotency-Key 두 번(동시) → 처리 1번, 같은 응답 재생, 작업 1개 / 키 없이 다시 → 409 NOT_PAUSED", { skip }, async () => {
  const id = await seedPaused("syncing");
  const k = `z36-${randomUUID()}`;
  const [a, b] = await Promise.all([resume(id, undefined, k), resume(id, undefined, k)]);
  assert.equal(a.statusCode, 202); assert.equal(b.statusCode, 202);
  assert.deepEqual(a.json(), b.json());
  assert.equal([a, b].filter((x) => x.headers["idempotent-replayed"] === "true").length, 1);
  assert.equal(a.json().queue, "sync");
  assert.equal(await jobs(id, "sync"), 1);
  const c = await resume(id);
  assert.equal(c.statusCode, 409); assert.equal(c.json().code, "NOT_PAUSED");
});

test("가드레일로 멈춤(failure_code 없음) → ruleCleared 없으면 409 GUARD_FAILED(상태·작업 그대로), ruleCleared:true면 202", { skip }, async () => {
  const id = await seedPaused("shifting", null, "reserved", "now() + interval '5 minutes'");
  const r1 = await resume(id);
  assert.equal(r1.statusCode, 409); assert.equal(r1.json().code, "GUARD_FAILED");
  assert.equal((await row(id)).status, "paused");
  assert.equal(await jobs(id, "shift"), 0);
  const r2 = await resume(id, { ruleCleared: true, reason: "error budget recovered" });
  assert.equal(r2.statusCode, 202, r2.body); assert.equal(r2.json().status, "shifting");
  assert.equal(await jobs(id, "shift"), 1);
});

test("같은 작업 키가 이미 대기 중이면 새로 안 넣고(jobQueued:false) 재개는 성공 / paused 아닌 이전 → 409 / 남의 회사 → 404", { skip }, async () => {
  const id = await seedPaused("cleanup", "JOB_FAILED_CLEANUP", "reserved", "now() + interval '5 minutes'");
  await core.boss.send("cleanup", { tenantId: T, requestId: "z36-pre", migrationId: id }, { singletonKey: `cleanup:${id}`, startAfter: 600 });
  const r = await resume(id);
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(r.json().jobQueued, false, "대기 중인 cleanup 작업이 곧 같은 일을 한다");
  assert.equal((await row(id)).status, "cleanup");
  assert.equal(await jobs(id, "cleanup"), 1);
  const again = await resume(id);
  assert.equal(again.statusCode, 409);
  const other = await app.inject({ method: "POST", url: `${P}/migrations/${id}/resume`, headers: { "x-dev-tenant": randomUUID() } });
  assert.equal(other.statusCode, 404);
});

test("잠금이 하나도 없으면(이미 풀림) 409 ENV_LOCK_MISSING — 재개 대신 롤백·취소", { skip }, async () => {
  const id = await seedPaused("deploying");
  await owner.query("DELETE FROM env_locks WHERE migration_id=$1", [id]);
  const r = await resume(id);
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, "ENV_LOCK_MISSING");
  assert.equal((await row(id)).status, "paused");
});

test("재개 응답 시간 5회 (paused → deploying + 작업 1개)", { skip }, async () => {
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) {
    const id = await seedPaused("deploying");
    const t0 = performance.now();
    const r = await resume(id, undefined, `z36-t-${randomUUID()}`);
    ms.push(Math.round((performance.now() - t0) * 10) / 10);
    assert.equal(r.statusCode, 202);
  }
  console.log(`[z36] resume latency ms: ${ms.join(" / ")}`);
});
