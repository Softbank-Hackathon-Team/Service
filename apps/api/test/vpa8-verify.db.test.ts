// 검증 PA8: 동시 start 직렬화, 상태별 셈(경계), 거부 뒤 흔적 0, 상한 값 경계, 멱등 재전송
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const TENANTS: string[] = [];

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
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(planRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  delete process.env.TENANT_MAX_ACTIVE;
  await owner.query("DELETE FROM env_locks WHERE tenant_id = ANY($1)", [TENANTS]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});


async function tenant() {
  const t = randomUUID(); TENANTS.push(t);
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [t, `test-vpa8-${t.slice(0, 8)}`]);
  return t;
}
async function seed(t: string, status: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, t]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`, [id, t, src, dst, status]);
  return { id, src, dst };
}
async function approved(t: string) {
  const m = await seed(t, "approved");
  const plan = await owner.query(`INSERT INTO plans (tenant_id, migration_id, plan_doc, plan_hash, expires_at)
    VALUES ($1,$2,'{}',$3, now() + interval '2 hours') RETURNING id`, [t, m.id, `h-${m.id}`]);
  await core.withTenant(t, async (tx) => {
    await core.saveApproval(tx, t, m.id, { planId: plan.rows[0].id, planHash: `h-${m.id}`, decision: "approve", actor: "test", selfApproved: true });
    await core.reserveEnvLocks(tx, { id: m.id, tenantId: t }, [m.src, m.dst], new Date(Date.now() + 3600_000));
  });
  return m.id;
}
const start = (t: string, id: string, key = randomUUID()) => app.inject({ method: "POST", url: `${P}/migrations/${id}/start`,
  headers: { "x-dev-tenant": t, "idempotency-key": key } });
const status = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status;
const applyJobs = async (id: string) => (await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE name='apply' AND data->>'migrationId' = $1", [id])).rows[0].n;
const withLimit = async (v: string | undefined, f: () => Promise<void>) => {
  if (v === undefined) delete process.env.TENANT_MAX_ACTIVE; else process.env.TENANT_MAX_ACTIVE = v;
  try { await f(); } finally { delete process.env.TENANT_MAX_ACTIVE; }
};

test("동시성: 상한 1, 승인된 이전 둘을 동시에 start → 정확히 하나만 202, 하나는 409 TENANT_BUSY", { skip }, async () => {
  const t = await tenant();
  const a = await approved(t), b = await approved(t);
  await withLimit("1", async () => {
    const rs = await Promise.all([start(t, a), start(t, b)]);
    assert.deepEqual(rs.map((r) => r.statusCode).sort(), [202, 409], rs.map((r) => r.body).join("|"));
    const busy = rs.find((r) => r.statusCode === 409)!;
    assert.equal(busy.json().code, "TENANT_BUSY");
    const started = [a, b].filter(async () => true);
    const sts = [await status(a), await status(b)].sort();
    assert.deepEqual(sts, ["approved", "provisioning"]);
    assert.equal((await applyJobs(a)) + (await applyJobs(b)), 1, "apply 작업도 하나만");
    assert.equal(started.length, 2);
  });
});

test("동시성: 상한 2, 승인된 셋을 동시에 → 202 둘 + 409 하나", { skip }, async () => {
  const t = await tenant();
  const ids = [await approved(t), await approved(t), await approved(t)];
  await withLimit("2", async () => {
    const rs = await Promise.all(ids.map((i) => start(t, i)));
    assert.deepEqual(rs.map((r) => r.statusCode).sort(), [202, 202, 409]);
  });
});

test("상태별 셈: LOCKED_STAGES 9개는 세고, approved·failed·stale·completed·cancelled·draft 는 안 센다", { skip }, async () => {
  const counted = ["provisioning", "deploying", "syncing", "shifting", "cutover", "rollback_window", "cleanup", "rolling_back", "paused"];
  const notCounted = ["draft", "spec_review", "planning", "awaiting_approval", "approved", "failed", "stale", "rejected", "rolled_back", "completed", "cancelled"];
  await withLimit("1", async () => {
    for (const s of counted) {
      const t = await tenant(); await seed(t, s);
      await assert.rejects(core.withTenant(t, (tx) => core.assertTenantCapacity(tx, t, randomUUID())), (e: { code?: string }) => e.code === "TENANT_BUSY", s);
    }
    for (const s of notCounted) {
      const t = await tenant(); await seed(t, s);
      await core.withTenant(t, (tx) => core.assertTenantCapacity(tx, t, randomUUID()));   // 던지지 않음
    }
  });
});

test("경계: 진행 중 = 상한-1 이면 통과, = 상한이면 거부 / 자기 자신은 안 셈", { skip }, async () => {
  const t = await tenant();
  await seed(t, "deploying");
  const me = await seed(t, "provisioning");
  await withLimit("2", async () => {
    await core.withTenant(t, (tx) => core.assertTenantCapacity(tx, t, me.id));            // 나 빼고 1개 < 2
    await seed(t, "syncing");
    await assert.rejects(core.withTenant(t, (tx) => core.assertTenantCapacity(tx, t, me.id)), { code: "TENANT_BUSY" });   // 나 빼고 2개 = 2
  });
});

test("거부 뒤 흔적 0: 409 이면 상태·apply 작업·환경 잠금·감사가 그대로, 다른 회사 진행 중은 영향 없음", { skip }, async () => {
  const t = await tenant(), other = await tenant();
  await seed(t, "shifting");
  for (let i = 0; i < 3; i++) await seed(other, "provisioning");
  const id = await approved(t);
  const locksBefore = (await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [id])).rows[0].n;
  await withLimit("1", async () => {
    const r = await start(t, id);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(await status(id), "approved");
    assert.equal(await applyJobs(id), 0);
    assert.equal((await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [id])).rows[0].n, locksBefore);
    assert.equal((await owner.query("SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='migration.provisioning'", [id])).rows[0].n, 0);
    const free = await tenant();
    const ok = await approved(free);
    assert.equal((await start(free, ok)).statusCode, 202, "남의 회사의 꽉 찬 상한과 무관");
  });
});

test("자리가 나면 같은 이전이 다시 start 가능, 이미 시작된 이전의 같은 키 재전송은 상한에 안 걸림(멱등)", { skip }, async () => {
  const t = await tenant();
  const busy = await seed(t, "deploying");
  const id = await approved(t);
  await withLimit("1", async () => {
    assert.equal((await start(t, id)).statusCode, 409);
    await owner.query("UPDATE migrations SET status='completed' WHERE id=$1", [busy.id]);
    const key = randomUUID();
    const first = await start(t, id, key);
    assert.equal(first.statusCode, 202, first.body);
    await seed(t, "cleanup");   // 이제 상한 초과 상태가 되어도
    const again = await start(t, id, key);
    assert.equal(again.statusCode, 202, "같은 키 재전송은 첫 응답 그대로");
    assert.equal(again.headers["idempotent-replayed"], "true");
    const plain = await start(t, id);   // 키 없이 이미 시작된 이전에 start → 상한이 아니라 상태 규칙으로 막힘
    assert.notEqual(plain.json().code, "TENANT_BUSY");
  });
});

// 회귀 기록 (PA4 통합 뒤): start 에 빈 본문 {} 를 보내면 StartInput(strict, planHash 필수) 때문에 깃발이 꺼져 있어도 400 이다.
//   PA4 의 주석은 "깃발 off 면 본문 없이 보내도 된다" — 본문 없음(undefined)은 통과, {} 는 400. 의도인지 팀 확인 필요
test("start 본문: 없음·{} 둘 다 PLAN_ACKS 꺼짐이면 통과 (E2E에서 {} 허용으로 고침)", { skip }, async () => {
  const t = await tenant();
  const a = await approved(t), b = await approved(t);
  const none = await app.inject({ method: "POST", url: `${P}/migrations/${a}/start`, headers: { "x-dev-tenant": t, "idempotency-key": randomUUID() } });
  assert.equal(none.statusCode, 202, none.body);
  const empty = await app.inject({ method: "POST", url: `${P}/migrations/${b}/start`, payload: {}, headers: { "x-dev-tenant": t, "idempotency-key": randomUUID() } });
  assert.equal(empty.statusCode, 202, empty.body);
});
