// G5-1 (ADR-066) → Jeong 11/4 01:53Z 개정: provisioning → failed 는 바로 지우지 않는다(재시도 질문 대기).
//   예전 길로 넣은 지우기 작업이 아직 남아 있으면 "재시도"는 409 TEARDOWN_PENDING (새 apply 가 같은 작업 폴더를 쓰지 않게)
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-g5-1-replan')", [T]);
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

async function failAtProvisioning() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'provisioning')`,
    [id, T, src, dst]);
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "provisioning", "failed", {
    failureCode: "APPLY_FAILED", analyze: false,
    audit: { actor: "worker", action: "apply.failed", target: id, result: "error", detail: { requestId: "r-g5" } } }));
  return id;
}
const destroyJobs = async (id: string) => (await owner.query(
  `SELECT id, state, data FROM pgboss.job WHERE name='target-destroy' AND data->>'migrationId'=$1`, [id])).rows;
const retry = (id: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/failure-decision`, payload: { choice: "retry" },
  headers: { "x-dev-tenant": T, "idempotency-key": randomUUID() } });

test("01:53Z: provisioning → failed 는 target-destroy 를 넣지 않는다 (지우기는 거절 → 롤백 → rolled_back 에서)", { skip }, async () => {
  const id = await failAtProvisioning();
  assert.equal((await destroyJobs(id)).length, 0);
  assert.equal((await owner.query(`SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='target_teardown.requested'`, [id])).rows[0].n, 0);
});

test("거부: 예전 길로 넣은 지우기 작업이 남아 있으면 재시도 409 TEARDOWN_PENDING, 끝나면 그 이유로는 안 막힘", { skip }, async () => {
  const id = await failAtProvisioning();
  await core.boss.send("target-destroy", { tenantId: T, requestId: "r-old", migrationId: id }, { singletonKey: `target-destroy:${id}` });
  const r = await retry(id);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "TEARDOWN_PENDING");
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "failed");
  await owner.query(`UPDATE pgboss.job SET state='completed', completed_on=now() WHERE name='target-destroy' AND data->>'migrationId'=$1`, [id]);
  const next = await retry(id);
  assert.notEqual(next.json().code, "TEARDOWN_PENDING", next.body);   // 승인 계획이 없는 시드라 PLAN_NOT_APPROVED 409 가 다음 관문
});
