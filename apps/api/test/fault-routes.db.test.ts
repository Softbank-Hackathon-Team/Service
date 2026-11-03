// DB 시험(작업 P): HTTP 경로에서 본 장애 시나리오. app.inject()로 부른다 (포트 안 엶).
//  - 같은 Idempotency-Key로 다시 보낸 요청 (네트워크 재시도)
//  - 승인 없이 start
//  - 회사 경계 (다른 회사 헤더)
//  - 실행 작업(apply)이 환경 잠금을 쥐는가
// 다른 시험 파일(plans.it.ts)의 워커가 같은 큐를 집어 갈 수 있으므로, 이 파일은 자기 회사·환경을 따로 만들고
// 큐 작업이 처리되는지에 기대지 않는다.
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
const S = randomUUID(), G = randomUUID();
const H = { "x-dev-tenant": T };

let core: typeof import("@svc/core");
let apply: typeof import("../../worker/src/jobs/apply.js");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "400";            // apply 작업이 "일하는" 동안 잠금을 들여다볼 시간
  core = await import("@svc/core");
  apply = await import("../../worker/src/jobs/apply.js");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { migrationRoutes } = await import("../src/routes/migrations.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-p-http'), ($2,'test-p-http-other')", [T, OTHER]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
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
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

// 계약(PlanDoc)을 통과하는 최소 계획서. 지문은 'hp' 고정
const EXPIRES = new Date(Date.now() + 2 * 3600_000).toISOString();
const planDoc = (planId: string, migrationId: string) => ({
  planId, migrationId, adapterVersion: "test", steps: [], precheck: [],
  rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
  tfPlanHash: "tf", helmValuesHash: "hv", planHash: "hp", expiresAt: EXPIRES });

// 상태 s의 이전 + (선택) 계획·승인 기록·잠금. 환경은 이전마다 새로 (잠금 충돌 방지)
async function seed(s: string, o: { plan?: boolean; approval?: "approve" | "reject"; locks?: "live" | "none" } = {}) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID(), planId = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, s]);
  if (o.plan || o.approval)
    await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
      VALUES ($1,$2,$3,$4,'hp', $5)`, [planId, T, id, JSON.stringify(planDoc(planId, id)), planDoc(planId, id).expiresAt]);
  if (o.approval)
    await owner.query(`INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash)
      VALUES ($1,$2,$3,$4,'user:dev','hp')`, [T, planId, id, o.approval]);
  if (o.locks === "live")
    await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
      VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`,
      [src, dst, T, id]);
  return { id, planId, src, dst };
}
const st = async (id: string) => (await owner.query("SELECT status, version FROM migrations WHERE id=$1", [id])).rows[0];
const jobsOf = async (id: string, q: string) => (await owner.query(
  "SELECT count(*)::int n FROM pgboss.job WHERE name=$2 AND data->>'migrationId'=$1", [id, q])).rows[0].n as number;
const post = (url: string, payload?: object, key?: string, h: Record<string, string> = H) => app.inject({
  method: "POST", url: `${P}${url}`, payload, headers: { ...h, ...(key ? { "idempotency-key": key } : {}) } });

// ── 승인 없이 start ──────────────────────────────────────────────

test("승인 없이 start ①: 승인 대기 상태 → 409 INVALID_TRANSITION, 상태·큐 그대로", { skip }, async () => {
  const m = await seed("awaiting_approval", { plan: true });
  const b = await st(m.id);
  const r = await post(`/migrations/${m.id}/start`);
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, "INVALID_TRANSITION");
  assert.deepEqual(await st(m.id), b);
  assert.equal(await jobsOf(m.id, "apply"), 0);
});

test("승인 없이 start ②: 상태는 approved인데 승인 기록이 없음 → 409 PLAN_NOT_APPROVED", { skip }, async () => {
  const m = await seed("approved", { plan: true, locks: "live" });
  const r = await post(`/migrations/${m.id}/start`);
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, "PLAN_NOT_APPROVED");
  assert.equal((await st(m.id)).status, "approved");
});

test("승인 없이 start ③: 마지막 결정이 '거절'뿐 → 409 PLAN_NOT_APPROVED", { skip }, async () => {
  const m = await seed("approved", { approval: "reject", locks: "live" });
  const r = await post(`/migrations/${m.id}/start`);
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, "PLAN_NOT_APPROVED");
});

test("승인 없이 start ④: 승인은 있으나 환경 잠금이 없음(만료·해제) → 409 GUARD_FAILED, apply 작업 0", { skip }, async () => {
  const m = await seed("approved", { approval: "approve", locks: "none" });
  const r = await post(`/migrations/${m.id}/start`);
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, "GUARD_FAILED");
  assert.match(r.json().message, /env lock not held/);
  assert.equal((await st(m.id)).status, "approved");
  assert.equal(await jobsOf(m.id, "apply"), 0);
});

test("start 두 번(키 없음): 두 번째는 409 INVALID_TRANSITION, apply 작업은 1개", { skip }, async () => {
  const m = await seed("approved", { approval: "approve", locks: "live" });
  assert.equal((await post(`/migrations/${m.id}/start`)).statusCode, 202);
  const r2 = await post(`/migrations/${m.id}/start`);
  assert.equal(r2.statusCode, 409);
  assert.equal(await jobsOf(m.id, "apply"), 1);
});

// ── 같은 Idempotency-Key 재요청 ────────────────────────────────────

// 【발견 P-2】 상태를 바꾸는 POST 경로가 req.idempotent()를 쓰지 않는다 (plans.ts의 TODO(human), 통합 대기 C).
// 그래서 플러그인이 등록돼 있어도 Idempotency-Key 헤더는 그냥 무시된다.
test("【P-2 재현】 POST /migrations 같은 키 두 번 → 이전 1개 + 같은 응답이어야 한다", { skip }, async () => {
  const key = `p-retry-${randomUUID()}`;
  const body = { sourceEnvId: S, targetEnvId: G };
  const a = await post("/migrations", body, key), b = await post("/migrations", body, key);
  const n = (await owner.query("SELECT count(*)::int n FROM migrations WHERE tenant_id=$1 AND source_env_id=$2", [T, S])).rows[0].n;
  assert.equal(n, 1, `같은 키로 이전 ${n}개 생성 (ids ${a.json().id}, ${b.json().id})`);
  assert.equal(b.headers["idempotent-replayed"], "true");
});

test("【P-2 재현】 POST start 같은 키 재시도 → 첫 202를 재생해야 한다 (지금은 409)", { skip }, async () => {
  const m = await seed("approved", { approval: "approve", locks: "live" });
  const key = `p-start-${randomUUID()}`;
  const a = await post(`/migrations/${m.id}/start`, undefined, key);
  const b = await post(`/migrations/${m.id}/start`, undefined, key);
  assert.equal(a.statusCode, 202);
  assert.equal(b.statusCode, 202, `재시도 응답 ${b.statusCode} ${b.body}`);
  assert.equal(b.headers["idempotent-replayed"], "true");
});

test("【P-2 재현】 POST approvals 같은 키 재시도 → 첫 200을 재생해야 한다 (지금은 409)", { skip }, async () => {
  const m = await seed("awaiting_approval", { plan: true });
  const key = `p-appr-${randomUUID()}`;
  const body = { planHash: "hp", decision: "approve" };
  const a = await post(`/plans/${m.planId}/approvals`, body, key);
  const b = await post(`/plans/${m.planId}/approvals`, body, key);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, `재시도 응답 ${b.statusCode} ${b.body}`);
  assert.deepEqual(b.json(), a.json());
});

test("멱등 키 코어: 처리 중 실패하면 키도 남지 않아 같은 키 재시도가 다시 처리된다", { skip }, async () => {
  const key = { key: `p-fail-${randomUUID()}`, reqHash: core.requestHash("POST", "/x", {}) };
  let runs = 0;
  await assert.rejects(core.withIdempotency(T, key, async () => { runs++; throw new Error("boom"); }));
  const r = await core.withIdempotency(T, key, async () => { runs++; return { status: 202, body: { ok: true } }; });
  assert.equal(runs, 2); assert.equal(r.replayed, false);
  const again = await core.withIdempotency(T, key, async () => { runs++; return { status: 202, body: { ok: false } }; });
  assert.equal(runs, 2, "성공한 뒤에는 재생만");
  assert.deepEqual(again, { status: 202, body: { ok: true }, replayed: true });
});

test("멱등 키 코어: 상태 전이가 GUARD_FAILED로 막힌 요청은 키를 남기지 않는다 (고친 뒤 같은 키로 재시도 가능)", { skip }, async () => {
  const m = await seed("approved", { approval: "approve", locks: "none" });
  const key = { key: `p-guard-${randomUUID()}`, reqHash: "h" };
  const start = (tx: import("@svc/core").Tx) => core.advance(tx, { id: m.id, tenantId: T }, "approved", "provisioning",
    { audit: { actor: "t", action: "t", target: m.id, result: "ok" } }).then(() => ({ status: 202, body: { id: m.id } }));
  await assert.rejects(core.withIdempotency(T, key, start), { code: "GUARD_FAILED" });
  const k = (await owner.query("SELECT count(*)::int n FROM idempotency_keys WHERE key=$1", [key.key])).rows[0].n;
  assert.equal(k, 0);
});

// ── 회사 경계 (HTTP) ─────────────────────────────────────────────

test("회사 경계: 다른 회사 헤더로 조회·start·계획 시작 → 모두 404, 상태 그대로", { skip }, async () => {
  const m = await seed("approved", { approval: "approve", locks: "live" });
  const O = { "x-dev-tenant": OTHER };
  assert.equal((await app.inject({ url: `${P}/migrations/${m.id}`, headers: O })).statusCode, 404);
  assert.equal((await post(`/migrations/${m.id}/start`, undefined, undefined, O)).statusCode, 404);
  assert.equal((await post(`/migrations/${m.id}/plan`, undefined, undefined, O)).statusCode, 404);
  assert.equal((await app.inject({ url: `${P}/plans/${m.planId}`, headers: O })).statusCode, 404);
  const list = (await app.inject({ url: `${P}/migrations`, headers: O })).json() as { items: { id: string }[] };
  assert.equal(list.items.some((x) => x.id === m.id), false);
  assert.equal((await st(m.id)).status, "approved");
});

test("회사 경계: 다른 회사 환경 번호로 POST /migrations → 404 (외래 키)", { skip }, async () => {
  const r = await post("/migrations", { sourceEnvId: S, targetEnvId: G }, undefined, { "x-dev-tenant": OTHER });
  assert.equal(r.statusCode, 404);
});

// 【발견 P-5】 x-dev-tenant 값이 uuid 모양이 아니면 ::uuid 변환이 DB에서 터져 500 INTERNAL.
// 뼈대용 인증이라 진짜 로그인으로 바뀌면 사라지지만, 지금 smoke·화면에서 잘못 넣으면 500으로 보인다
test("P-5 고침: x-dev-tenant가 uuid가 아니면 401", { skip }, async () => {
  const r = await app.inject({ url: `${P}/migrations`, headers: { "x-dev-tenant": "not-a-uuid" } });
  assert.ok(r.statusCode === 400 || r.statusCode === 401, `got ${r.statusCode}`);
});

// ── 실행 작업과 환경 잠금 ────────────────────────────────────────

// 【발견 P-3】 apply 작업(runStep)은 환경 잠금을 인수(worker:<id>)하지도, 생존 신호를 돌리지도 않는다
// (_step.ts·apply.ts의 TODO(human)). 잠금은 승인 때 넣은 'reserved'(기한 = 계획 만료, 지금 2시간) 그대로다.
// 결과: apply 도중 워커가 죽으면 청소 작업은 계획 만료까지 아무것도 못 보고, 그 뒤엔 WORKER_LOST가 아니라
// JOB_NOT_PICKED로 실패 처리한다. apply 큐는 retryLimit 0이라 다른 워커가 이어받지도 않는다.
// → runStep 이 잠금 인수·생존 신호를 하도록 고쳐짐. 시험이 기준본에서 실패한 건 명세 판이 없어 apply 가 일 전에 끝났기 때문
test("【P-3 재현】 apply가 일하는 동안 환경 잠금 주인은 worker:로 바뀌어야 한다", { skip }, async () => {
  const m = await seed("provisioning", { approval: "approve", locks: "live" });
  // apply 는 받아들인 판의 명세를 다시 읽는다(TA3). 없으면 일하기 전에 TF_PLAN_DRIFT 로 끝나 잠금 주인을 볼 틈이 없다
  const { ONE } = await import("../../worker/test/demo-one.js");
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}','{}',$3)`,
    [T, m.id, JSON.stringify({ spec: ONE, fieldMeta: {}, unmapped: [], ids: {} })]);
  const holders = new Set<string>();
  let done = false;
  const run = apply.handleApply({ tenantId: T, requestId: "r-p3", migrationId: m.id, planId: m.planId, planHash: "hp" })
    .finally(() => { done = true; });
  while (!done) {
    for (const r of (await owner.query("SELECT holder FROM env_locks WHERE migration_id=$1", [m.id])).rows) holders.add(r.holder);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(await run, "advanced");
  assert.ok([...holders].some((h) => h.startsWith("worker:")), `일하는 동안 본 잠금 주인: ${[...holders]}`);
});
