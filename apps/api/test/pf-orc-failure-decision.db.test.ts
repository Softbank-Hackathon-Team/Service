// Jeong 결정 11/4 01:53Z: 실패 → (트래픽 출발) → AI 원인 분석 → "재시도할까?" → 승인: 실패한 단계부터 / 거절: 롤백.
//   POST /migrations/:id/failure-decision {choice}. 상태를 바꾸는 POST 하나 = advance() 한 번, 그 밖은 409 INVALID_TRANSITION
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
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-failure-decision')", [T]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(controlRoutes, { prefix: P });
  await app.register(planRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

/** status 에서 시작해 실패시킨 이전 (잠금을 쥐는 단계면 환경 잠금 2줄) */
async function failedAt(status: string, failureCode = "STEP_FAILED") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, T, src, dst, status]);
  if (core.LOCKED_STAGES.includes(status as never))
    await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at) VALUES
      ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, T, id]);
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, status as never, "failed", {
    failureCode, analyze: false,
    audit: { actor: "worker", action: `${status}.failed`, target: id, result: "error", detail: { requestId: "r-fd" } } }));
  return id;
}
const decide = (id: string, choice: string, extra: Record<string, unknown> = {}) => app.inject({
  method: "POST", url: `${P}/migrations/${id}/failure-decision`, payload: { choice, ...extra },
  headers: { "x-dev-tenant": T, "idempotency-key": randomUUID() } });
const row = async (id: string) => (await owner.query("SELECT status, failed_at_status FROM migrations WHERE id=$1", [id])).rows[0];
const jobs = async (name: string, id: string) => (await owner.query(
  `SELECT state, data, singleton_key FROM pgboss.job WHERE name=$1 AND data->>'migrationId'=$2`, [name, id])).rows;
const audits = async (id: string, action: string) =>
  (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action=$2`, [id, action])).rows;

const lockCount = async (id: string) => (await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [id])).rows[0].n as number;

test("실패해도 도착 자원을 바로 지우지 않음(질문 대기). provisioning 실패는 잠금을 풀었다가 답할 때 다시 예약", { skip }, async () => {
  const id = await failedAt("provisioning", "APPLY_FAILED");
  assert.equal((await row(id)).status, "failed");
  assert.equal((await jobs("target-destroy", id)).length, 0, "01:53Z: 지우기는 거절 → 롤백 길에서만");
  assert.equal(await lockCount(id), 0);
});

test("재시도 승인: cutover 실패 → 202, 상태 cutover + cutover 작업 1개 + migration.retried 감사", { skip }, async () => {
  const id = await failedAt("cutover", "CUTOVER_ERROR_UNFENCED");
  const r = await decide(id, "retry", { reason: "원인 고침" });
  assert.equal(r.statusCode, 202, r.body);
  assert.deepEqual({ ...(r.json() as object), id: undefined }, { id: undefined, from: "failed", choice: "retry", status: "cutover", queue: "cutover", jobQueued: true });
  assert.equal((await row(id)).status, "cutover");
  const j = await jobs("cutover", id);
  assert.equal(j.length, 1);
  assert.equal(j[0].singleton_key, `cutover:${id}`);
  assert.equal((await audits(id, "migration.retried"))[0].detail.via, "failure-decision");
  assert.equal((await audits(id, "migration.failure_retry")).length, 1);
});

test("재시도 승인: planning 실패 → 새 계획 번호로 plan 작업", { skip }, async () => {
  const id = await failedAt("planning");
  const r = await decide(id, "retry");
  assert.equal(r.statusCode, 202, r.body);
  assert.equal((await row(id)).status, "planning");
  const j = await jobs("plan", id);
  assert.equal(j.length, 1);
  assert.match(j[0].data.planId, /^[0-9a-f-]{36}$/);
});

test("거절 → 롤백: provisioning 실패 → rolling_back + rollback 작업, rolled_back 이 되면 그때 도착 지우기", { skip }, async () => {
  const id = await failedAt("provisioning", "APPLY_FAILED");
  const r = await decide(id, "rollback", { reason: "그만" });
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(r.json().status, "rolling_back");
  assert.equal((await row(id)).status, "rolling_back");
  assert.equal((await jobs("rollback", id)).length, 1);
  assert.equal(await lockCount(id), 2, "롤백 작업이 쥘 잠금을 다시 예약");
  assert.equal((await jobs("target-destroy", id)).length, 0);
  // 롤백 작업이 트래픽 출발 100% 를 확인하고 끝내면 → rolled_back → 같은 트랜잭션에 target-destroy
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "rolling_back", "rolled_back", {
    evidence: { sourceWeight100: true, sourceHealthy: true },
    audit: { actor: "worker", action: "rollback.rolled_back", target: id, result: "ok", detail: { requestId: "r-fd" } } }));
  assert.equal((await jobs("target-destroy", id)).length, 1);
});

test("거절: 자원을 만들기 전(prechecking) 실패면 롤백할 것이 없어 cancelled", { skip }, async () => {
  const id = await failedAt("prechecking");
  const r = await decide(id, "rollback");
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(r.json().status, "cancelled");
  assert.equal(r.json().queue, null);
  assert.equal((await row(id)).status, "cancelled");
});

test("잘못된 전이 409: failed 가 아님 / 실패 지점이 재시도 대상 아님 / failed 에서 다시 계획", { skip }, async () => {
  const notFailed = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'deploying')`,
    [notFailed, T, src, dst]);
  let r = await decide(notFailed, "retry");
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "INVALID_TRANSITION");
  assert.equal((await row(notFailed)).status, "deploying");

  // 실패 지점이 표에 없는(손으로 만든) failed 는 재시도할 단계가 없다
  const odd = await failedAt("cutover");
  await owner.query("UPDATE migrations SET failed_at_status='syncing' WHERE id=$1", [odd]);
  r = await decide(odd, "retry");
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "INVALID_TRANSITION");
  assert.equal((await row(odd)).status, "failed");

  // ADR-066 개정: failed → prechecking(다시 계획) 길은 없앴다
  const pre = await failedAt("prechecking");
  r = await app.inject({ method: "POST", url: `${P}/migrations/${pre}/replan`, payload: {},
    headers: { "x-dev-tenant": T, "idempotency-key": randomUUID() } });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal((await row(pre)).status, "failed");

  // 본문 choice 가 이상하면 400
  r = await decide(pre, "maybe");
  assert.equal(r.statusCode, 400, r.body);
});

test("가드: failed → 실패 지점 상태는 '재시도' 증거 없이 못 감 (advance 직접)", { skip }, async () => {
  const id = await failedAt("importing");
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "failed", "importing", {
    audit: { actor: "api", action: "x", target: id, result: "ok" } })), /failureDecision retry required|GUARD/i);
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "failed", "planning", {
    evidence: { failureDecision: "retry" }, audit: { actor: "api", action: "x", target: id, result: "ok" } })), /failed_at_status|GUARD/i);
});
