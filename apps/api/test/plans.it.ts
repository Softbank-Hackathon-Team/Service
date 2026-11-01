// DB가 있어야 도는 통합 시험. 실행: DATABASE_URL=... node --import tsx --test apps/*/test/*.it.ts
// 같은 프로세스에서 api 경로(app.inject)와 워커 처리기를 같이 돌린다
import "./_fast-env.js";   // Z20: 반드시 맨 앞 (100% 관찰 시간 짧게)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { boss, startBoss, pool, withTenant, workOptions } from "@svc/core";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { idempotencyPlugin } from "../src/plugins/idempotency.js";
import { migrationRoutes } from "../src/routes/migrations.js";
import { planRoutes } from "../src/routes/plans.js";
import { HANDLERS } from "../../worker/src/jobs/index.js";
import { handleApply } from "../../worker/src/jobs/apply.js";
import { handlePrecheck } from "../../worker/src/jobs/precheck.js";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const H = { "x-dev-tenant": T };
const app = Fastify();

before(async () => {
  process.env.STUB_DELAY_MS = "0";
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(migrationRoutes);
  await app.register(planRoutes);
  await startBoss();
  for (const [q, h] of Object.entries(HANDLERS))
    await boss.work(q, workOptions(), async ([j]) => { await h(j!.data); });
});
after(async () => { await boss.stop({ graceful: false }); await app.close(); await pool.end(); });

async function status(id: string, h = H) {
  const r = await app.inject({ method: "GET", url: `/migrations/${id}`, headers: h });
  return r.statusCode === 200 ? (r.json() as { status: string }).status : `http ${r.statusCode}`;
}
async function waitFor(id: string, s: string, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const cur = await status(id);
    if (cur === s) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${cur} != ${s}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function toAwaitingApproval() {
  const c = await app.inject({ method: "POST", url: "/migrations", headers: H, payload: {
    sourceEnvId: "22222222-2222-4222-8222-222222222222", targetEnvId: "33333333-3333-4333-8333-333333333333" } });
  const { id } = c.json() as { id: string };
  await waitFor(id, "spec_review");
  assert.equal((await app.inject({ method: "POST", url: `/migrations/${id}/plan`, headers: H })).statusCode, 202);
  await waitFor(id, "awaiting_approval");
  const plan = (await app.inject({ method: "GET", url: `/migrations/${id}/plan`, headers: H })).json() as
    { planId: string; planHash: string };
  return { id, plan };
}

test("정상: 승인 1번으로 draft → completed", async () => {
  const { id, plan } = await toAwaitingApproval();
  const a = await app.inject({ method: "POST", url: `/plans/${plan.planId}/approvals`, headers: H,
    payload: { decision: "approve", planHash: plan.planHash } });
  assert.equal(a.statusCode, 200);
  assert.equal(await status(id), "approved");
  assert.equal((await app.inject({ method: "POST", url: `/migrations/${id}/start`, headers: H })).statusCode, 202);
  await waitFor(id, "completed", 30000);
});

test("거부: 화면이 본 planHash와 다르면 409 PLAN_HASH_MISMATCH, 상태는 그대로", async () => {
  const { id, plan } = await toAwaitingApproval();
  const a = await app.inject({ method: "POST", url: `/plans/${plan.planId}/approvals`, headers: H,
    payload: { decision: "approve", planHash: "0".repeat(64) } });
  assert.equal(a.statusCode, 409);
  assert.equal((a.json() as { code: string }).code, "PLAN_HASH_MISMATCH");
  assert.equal(await status(id), "awaiting_approval");
});

test("거절: reject → rejected", async () => {
  const { id, plan } = await toAwaitingApproval();
  const a = await app.inject({ method: "POST", url: `/plans/${plan.planId}/approvals`, headers: H,
    payload: { decision: "reject", planHash: plan.planHash, reason: "범위 다시" } });
  assert.equal(a.statusCode, 200);
  assert.equal(await status(id), "rejected");
});

test("거부: 승인 전에 start → 409 INVALID_TRANSITION", async () => {
  const { id } = await toAwaitingApproval();
  const r = await app.inject({ method: "POST", url: `/migrations/${id}/start`, headers: H });
  assert.equal(r.statusCode, 409);
  assert.equal((r.json() as { code: string }).code, "INVALID_TRANSITION");
});

test("회사 경계: 다른 회사는 계획서·승인 모두 404", async () => {
  const { plan } = await toAwaitingApproval();
  const o = { "x-dev-tenant": OTHER };
  assert.equal((await app.inject({ method: "GET", url: `/plans/${plan.planId}`, headers: o })).statusCode, 404);
  const a = await app.inject({ method: "POST", url: `/plans/${plan.planId}/approvals`, headers: o,
    payload: { decision: "approve", planHash: plan.planHash } });
  assert.equal(a.statusCode, 404);
});

test("두 번 온 작업은 아무것도 안 한다 (재확인 no-op)", async () => {
  const { id, plan } = await toAwaitingApproval();
  const job = { tenantId: T, requestId: "dup", migrationId: id };
  assert.equal(await handlePrecheck(job), "skipped"); // 이미 awaiting_approval
  // 승인 안 된 계획으로 apply 작업이 와도(가짜 작업) 상태를 안 바꾼다
  assert.equal(await handleApply({ ...job, planId: plan.planId, planHash: plan.planHash }), "skipped");
  assert.equal(await status(id), "awaiting_approval");
  const n = await withTenant(T, async (tx) => (await tx.query(
    "SELECT count(*)::int AS n FROM audit_events WHERE action='job.rejected' AND target=$1", [id])).rows[0].n);
  assert.equal(n, 2);
});
