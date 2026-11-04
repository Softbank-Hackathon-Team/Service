// DB 시험 (PA5a, 계획 26 · A5a): 재시도 한도 — 실패 재시도(failure-decision)·resume 섞어 3번 뒤 4번째는 409, acceptCustomerCost:true 면 통과
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

before(async () => {
  if (skip) return;
  delete process.env.RETRY_BUDGET;   // 기본 3
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  const { controlRoutes } = await import("../src/routes/control.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-pa5a-retry'), ($2,'test-pa5a-retry-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(planRoutes, { prefix: P });
  await app.register(controlRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'draft')`,
    [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at) VALUES
    ($1,$3,$4,'worker:dead',now() - interval '1 minute'), ($2,$3,$4,'worker:dead',now() - interval '1 minute')`, [src, dst, T, id]);
  return id;
}
// 시험용으로 상태를 바로 놓는다 (표 주인 계정). 앞 단계가 넣은 작업은 지워 작업 키가 비게 한다
async function failAt(id: string) {
  await owner.query("DELETE FROM pgboss.job WHERE singleton_key LIKE $1", [`%:${id}`]);
  await owner.query(`UPDATE migrations SET status='failed', failed_at_status='prechecking', failure_code='PRECHECK_FAILED' WHERE id=$1`, [id]);
}
async function pauseAt(id: string) {
  await owner.query("DELETE FROM pgboss.job WHERE singleton_key LIKE $1", [`%:${id}`]);
  await owner.query(`UPDATE migrations SET status='paused', paused_from='deploying', failure_code='JOB_FAILED_DEPLOY' WHERE id=$1`, [id]);
}
// Jeong 11/4 01:53Z: 실패 재시도는 POST .../failure-decision {choice:"retry"} (failed 에서 replan 은 없앰). "replan" 은 stale 다시 계획만
const post = (id: string, path: "replan" | "resume" | "retry", body?: object, tenant = T) => app.inject({
  method: "POST", url: `${P}/migrations/${id}/${path === "retry" ? "failure-decision" : path}`,
  ...(path === "retry" ? { payload: { choice: "retry", ...(body ?? {}) } } : body ? { payload: body } : {}),
  headers: { "x-dev-tenant": tenant, "idempotency-key": `pa5a-${randomUUID()}` } });
const retried = async (id: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND action='migration.retried' ORDER BY seq", [id])).rows.map((r) => r.detail);

test("재시도·resume 섞어 3번은 통과, 4번째는 409 RETRY_BUDGET_EXHAUSTED, acceptCustomerCost:true 면 202", { skip }, async () => {
  const id = await seed();
  await failAt(id);  assert.equal((await post(id, "retry")).statusCode, 202);
  await pauseAt(id); const r2 = await post(id, "resume"); assert.equal(r2.statusCode, 202, r2.body);
  await failAt(id);  assert.equal((await post(id, "retry", {})).statusCode, 202);
  assert.deepEqual((await retried(id)).map((d) => [d.via, d.attempt, d.customerCostAccepted]),
    [["failure-decision", 1, false], ["resume", 2, false], ["failure-decision", 3, false]]);

  await pauseAt(id);
  const over = await post(id, "resume");
  assert.equal(over.statusCode, 409, over.body);
  assert.equal(over.json().code, "RETRY_BUDGET_EXHAUSTED");
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "paused", "상태 그대로");
  const ok = await post(id, "resume", { acceptCustomerCost: true });
  assert.equal(ok.statusCode, 202, ok.body);

  await failAt(id);
  assert.equal((await post(id, "retry")).statusCode, 409);
  assert.equal((await post(id, "retry", { acceptCustomerCost: true })).statusCode, 202);
  const last = (await retried(id)).slice(-2);
  assert.deepEqual(last.map((d) => [d.attempt, d.customerCostAccepted]), [[4, true], [5, true]]);
});

test("실패 아닌 다시 계획(stale)과 가드레일 멈춤 재개는 세지 않는다", { skip }, async () => {
  const id = await seed();
  await owner.query("UPDATE migrations SET status='stale' WHERE id=$1", [id]);
  assert.equal((await post(id, "replan")).statusCode, 202);
  await owner.query("DELETE FROM pgboss.job WHERE singleton_key LIKE $1", [`%:${id}`]);
  await owner.query(`UPDATE migrations SET status='paused', paused_from='deploying', failure_code=NULL WHERE id=$1`, [id]);
  assert.equal((await post(id, "resume", { ruleCleared: true })).statusCode, 202);
  assert.equal((await retried(id)).length, 0);
});

test("거부: 남의 회사 이전 → 404, 감사 안 남음 / 모르는 본문 칸 → 400", { skip }, async () => {
  const id = await seed();
  await failAt(id);
  assert.equal((await post(id, "retry", undefined, OTHER)).statusCode, 404);
  assert.equal((await post(id, "retry", { acceptCustomerCost: "yes" })).statusCode, 400);
  assert.equal((await post(id, "retry", { other: 1 })).statusCode, 400);
  assert.equal((await retried(id)).length, 0);
});

// DB 없이: GET agent-review 의 failureAnalysis 칸 (PA5a). 기록이 없으면 칸 자체가 없다(예전 응답 그대로)
test("agent-review: failure_analysis 기록이 있을 때만 failureAnalysis 칸, 결과 모양이 틀리면 analysis null", async () => {
  const { buildAgentReview } = await import("../src/routes/agent-review.js");
  const mid = randomUUID();
  assert.equal("failureAnalysis" in buildAgentReview(mid, []), false);
  const row = (result: unknown) => ({ id: randomUUID(), kind: "failure_analysis" as const, status: "finished" as const, model: "m",
    result, reason: null, usage: { input: 1, output: 2 }, created_at: new Date(), finished_at: new Date(), steps: [] });
  const good = { cause: "쿼터 부족", evidence: ["APPLY_FAILED"], fix: ["vCPU 쿼터 올리기"], retryable: false, confidence: 0.7 };
  const a = buildAgentReview(mid, [row(good)]);
  assert.deepEqual(a.failureAnalysis?.analysis, good);
  assert.equal(a.failureAnalysis?.status, "finished");
  assert.equal(buildAgentReview(mid, [row({ cause: 1 })]).failureAnalysis?.analysis, null);
});
