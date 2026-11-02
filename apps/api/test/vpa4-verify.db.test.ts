// 검증 PA4: acks 경계(여분·중복·빈 값·500개), 검사 순서(지문→만료→acks), 멱등 재전송, 시작 지문 경계, 거부 뒤 흔적 0
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();
const H = { "x-dev-tenant": T };

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;
const prevFlag = process.env.PLAN_ACKS;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vpa4'), ($2,'test-vpa4-other')", [T, OTHER]);
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
afterEach(() => { if (prevFlag === undefined) delete process.env.PLAN_ACKS; else process.env.PLAN_ACKS = prevFlag; });
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

const ACKS = [
  { id: "cost", kind: "cost", text: "예상 월 비용" },
  { id: "failure_cost_policy", kind: "failure_cost_policy", text: "실패 비용 정책" },
  { id: "runtime_change:api", kind: "runtime_change", text: "lambda → k8s", ref: "api" },
];

// 시험마다 새 환경·새 이전 + awaiting_approval 계획 하나 (워커가 하는 일 흉내)
async function seed(withAcks = true) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID(), planId = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'planning')`, [id, T, src, dst]);
  const plan = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: "tf", helmValuesHash: "helm", planHash: `hash-${planId}`,
    ...(withAcks ? { specVersion: 1, acknowledgements: ACKS,
      costSummary: { currency: "USD", monthlyTarget: 80, monthlySource: 100, deltaMonthly: -20, unknownFields: [] } } : {}),
    expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  await core.withTenant(T, async (tx) => {
    await core.savePlan(tx, T, plan as never);
    await core.advance(tx, { id, tenantId: T }, "planning", "awaiting_approval",
      { audit: { actor: "worker", action: "plan.proposed", target: id, result: "ok" } });
  });
  return { id, planId, planHash: plan.planHash };
}
const status = async (id: string) => (await owner.query(`SELECT status FROM migrations WHERE id=$1`, [id])).rows[0].status as string;
const locks = async (id: string) => (await owner.query(`SELECT 1 FROM env_locks WHERE migration_id=$1`, [id])).rowCount;
const applyJobs = async (id: string) => (await owner.query(
  `SELECT 1 FROM pgboss.job WHERE name='apply' AND data->>'migrationId'=$1`, [id])).rowCount;
const approve = (planId: string, body: Record<string, unknown>, headers: Record<string, string> = H) =>
  app.inject({ method: "POST", url: `${P}/plans/${planId}/approvals`, payload: body,
    headers: { ...headers, "idempotency-key": randomUUID() } });
const start = (id: string, body?: Record<string, unknown>, headers: Record<string, string> = H) =>
  app.inject({ method: "POST", url: `${P}/migrations/${id}/start`, ...(body ? { payload: body } : {}),
    headers: { ...headers, "idempotency-key": randomUUID() } });


test("acks 경계: 여분 id·중복 id 는 통과, 빈 글자·숫자·501개는 400, 감사엔 보낸 그대로", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  const all = ACKS.map((a) => a.id);
  for (const bad of [[""], [1], [...all, ""], Array(501).fill("cost"), "cost", null])
    assert.equal((await approve(m.planId, { decision: "approve", planHash: m.planHash, acks: bad })).statusCode, 400, JSON.stringify(bad).slice(0, 40));
  assert.equal(await status(m.id), "awaiting_approval");
  const sent = [...all, "cost", "unknown:thing"];
  const r = await approve(m.planId, { decision: "approve", planHash: m.planHash, acks: sent });
  assert.equal(r.statusCode, 200, r.body);
  const a = await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='plan.approved'`, [m.id]);
  assert.deepEqual(a.rows[0].detail.acks, sent);
});

test("acks 빠짐 메시지: 빠진 id 를 전부, 보낸 것은 빼고. 빈 배열·acks 없음도 같은 409", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  for (const body of [{ acks: [] }, {}, { acks: ["failure_cost_policy"] }]) {
    const r = await approve(m.planId, { decision: "approve", planHash: m.planHash, ...body });
    assert.equal(r.statusCode, 409, JSON.stringify(body));
    assert.equal(r.json().code, "ACKS_MISSING");
    assert.match(r.json().message, /cost/);
    if ("acks" in body && body.acks?.[0] === "failure_cost_policy") assert.doesNotMatch(r.json().message, /failure_cost_policy/);
  }
  assert.equal(await locks(m.id), 0);
});

test("검사 순서: 지문 불일치(PLAN_HASH_MISMATCH) → 만료(PLAN_EXPIRED) → acks(ACKS_MISSING)", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const a = await seed();
  const r1 = await approve(a.planId, { decision: "approve", planHash: "wrong", acks: [] });
  assert.equal(r1.json().code, "PLAN_HASH_MISMATCH");
  const b = await seed();
  await owner.query("UPDATE plans SET expires_at = now() - interval '1 second' WHERE id = $1", [b.planId]);
  const r2 = await approve(b.planId, { decision: "approve", planHash: b.planHash, acks: [] });
  assert.equal(r2.json().code, "PLAN_EXPIRED");
  assert.equal(await status(a.id), "awaiting_approval"); assert.equal(await status(b.id), "awaiting_approval");
});

test("멱등: 같은 키·같은 본문 재전송은 첫 응답 그대로(승인 한 번), 첫 시도가 ACKS_MISSING 이면 같은 키로 acks 를 채워 다시 보내도 새 요청으로 처리", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  const key = randomUUID();
  const send = (body: Record<string, unknown>) => app.inject({ method: "POST", url: `${P}/plans/${m.planId}/approvals`, payload: body,
    headers: { ...H, "idempotency-key": key } });
  const miss = await send({ decision: "approve", planHash: m.planHash, acks: ["cost"] });
  assert.equal(miss.statusCode, 409);
  const ok = await send({ decision: "approve", planHash: m.planHash, acks: ACKS.map((a) => a.id) });
  assert.equal(ok.statusCode, 200, `같은 키·다른 본문: ${ok.statusCode} ${ok.body}`);
  const again = await send({ decision: "approve", planHash: m.planHash, acks: ACKS.map((a) => a.id) });
  assert.equal(again.statusCode, 200);
  assert.equal(again.headers["idempotent-replayed"], "true");
  assert.equal((await owner.query(`SELECT 1 FROM audit_events WHERE target=$1 AND action='plan.approved'`, [m.id])).rowCount, 1);
});

test("시작 지문 경계: 빈 글자·공백·대소문자 다른 지문·앞뒤 공백은 전부 409, 정확히 같아야 202 / 시작 뒤 같은 요청은 상한 아닌 상태 규칙", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  assert.equal((await approve(m.planId, { decision: "approve", planHash: m.planHash, acks: ACKS.map((a) => a.id) })).statusCode, 200);
  for (const bad of ["", " ", m.planHash.toUpperCase(), ` ${m.planHash}`, `${m.planHash} `, "x".repeat(10_000)]) {
    const r = await start(m.id, { planHash: bad });
    assert.ok([400, 409].includes(r.statusCode), `${JSON.stringify(bad).slice(0, 20)} → ${r.statusCode}`);
    if (r.statusCode === 409) assert.equal(r.json().code, "PLAN_HASH_MISMATCH");
  }
  assert.equal(await status(m.id), "approved");
  assert.equal(await applyJobs(m.id), 0);
  const ok = await start(m.id, { planHash: m.planHash });
  assert.equal(ok.statusCode, 202, ok.body);
  assert.equal(await status(m.id), "provisioning");
  const second = await start(m.id, { planHash: m.planHash });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, "INVALID_TRANSITION");
  assert.equal(await applyJobs(m.id), 1, "apply 작업은 하나뿐");
});

test("깃발 값 경계: '1' 만 켜짐 — '0'·'true'·''·' ' 는 꺼짐이라 acks 없이 승인된다", { skip }, async () => {
  for (const v of ["0", "true", "", " "]) {
    process.env.PLAN_ACKS = v;
    const m = await seed();
    const r = await approve(m.planId, { decision: "approve", planHash: m.planHash });
    assert.equal(r.statusCode, 200, `PLAN_ACKS=${JSON.stringify(v)} ${r.body}`);
  }
  process.env.PLAN_ACKS = " 1 ";
  const m = await seed();
  assert.equal((await approve(m.planId, { decision: "approve", planHash: m.planHash })).statusCode, 409, "앞뒤 공백은 trim 돼 켜짐");
});

test("남의 회사: 계획 승인 404, 시작 404, 어느 쪽도 감사·잠금·작업을 안 남김", { skip }, async () => {
  process.env.PLAN_ACKS = "1";
  const m = await seed();
  const O = { "x-dev-tenant": OTHER };
  assert.equal((await approve(m.planId, { decision: "approve", planHash: m.planHash, acks: ACKS.map((a) => a.id) }, O)).statusCode, 404);
  assert.equal((await start(m.id, { planHash: m.planHash }, O)).statusCode, 404);
  assert.equal(await status(m.id), "awaiting_approval");
  assert.equal(await locks(m.id), 0);
});
