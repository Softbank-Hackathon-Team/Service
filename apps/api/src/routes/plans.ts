import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { ApprovalInput, PlanDoc, QUEUES, StartInput, type MigrationStatus } from "@svc/contracts";
import { withTenant, advance, checkRetryBudget, writeAudit, DomainError, planExpired, assertTenantCapacity, type Tx } from "@svc/core";
import { Accepted, ApprovalResult, errors } from "./responses.js";
import { IdParam, RetryBody, auditOk, found, nextJob } from "./kit.js";
import { loadLatestApproval, loadLatestPlan, loadPlanById, saveApproval } from "./plan-store.js";

// 계획 → 승인 → 시작 경로 (설계 api-orchestrator-v1 3.4)
//   POST /migrations/:id/plan       spec_review → prechecking   (+ precheck 작업)
//   GET  /migrations/:id/plan       이 이전의 최신 계획서 (DRAFT(ai): 화면이 계획 번호를 알 길이 필요해서 추가)
//   GET  /plans/:id                 계획서 내용·지문
//   POST /plans/:id/approvals       awaiting_approval → approved | rejected  (planHash 바인딩)
//   POST /migrations/:id/start      approved → provisioning     (+ apply 작업)
//   POST /migrations/:id/replan     failed(provisioning 이하)·stale·rejected → planning  (+ plan 작업)
//   POST /migrations/:id/spec/reopen  rejected → spec_review    (거절 뒤 명세부터 고칠 때)
// 상태를 바꾸는 POST 하나 = advance() 한 번.
// TODO(human): Idempotency-Key 필수 처리는 공용 플러그인이 붙으면 이 경로들에도 걸린다

// PA4 (계획 26 · A4): 깃발 PLAN_ACKS=1 이면 승인 때 확인 항목(acks)을 전부 덮어야 하고, 시작 때 planHash 를 다시 본다
// DRAFT(ai): 기본 off. 화면이 acks·/start 본문을 보내기 시작한 뒤 켠다. 요청마다 읽는다(시험에서 바꿔 끼우기 쉽게)
export const planAcksOn = (env: NodeJS.ProcessEnv = process.env) => env.PLAN_ACKS?.trim() === "1";

// 계획서 확인 항목 중 acks 가 덮지 못한 id (옛 계획서처럼 항목이 없으면 빈 목록)
export function missingAcks(plan: PlanDoc, acks: string[] | undefined): string[] {
  const got = new Set(acks ?? []);
  return (plan.acknowledgements ?? []).map((a) => a.id).filter((id) => !got.has(id));
}

async function migrationOf(tx: Tx, id: string) {
  const q = await tx.query(
    `SELECT id, status, source_env_id AS "sourceEnvId", target_env_id AS "targetEnvId",
            failed_at_status AS "failedAtStatus"
       FROM migrations WHERE id=$1`, [id]);
  // 남의 회사 것도 RLS 때문에 404
  return found(q.rows[0] as { id: string; status: MigrationStatus; sourceEnvId: string; targetEnvId: string;
    failedAtStatus: MigrationStatus | null } | undefined,
    "migration", id);
}

export async function planRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // 명세 확정 → 점검·계획 시작 (T04). 202
  r.post("/migrations/:id/plan", { schema: { params: IdParam,
    response: { 202: Accepted, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      await migrationOf(tx, id);
      await advance(tx, { id, tenantId: req.tenantId }, "spec_review", "prechecking", {
        next: nextJob(req, QUEUES.precheck, id),
        audit: auditOk(req, "migration.prechecking", id),
      });
      return { status: 202, body: { id } };
    });
  });

  // DRAFT(ai): 설계 3.4 경로 표에 없는 경로. 화면이 승인 버튼을 그리려면 이전 번호로 최신 계획을 찾아야 해서 추가
  r.get("/migrations/:id/plan", { schema: { params: IdParam,
    response: { 200: PlanDoc, ...errors(400, 401, 404, 500) } } }, async (req) => {
    return withTenant(req.tenantId, async (tx) => {
      await migrationOf(tx, req.params.id);
      return found(await loadLatestPlan(tx, req.params.id), "plan of migration", req.params.id);
    });
  });

  // 계획서 보기. 화면은 여기 나온 planHash를 승인 요청에 그대로 넣는다
  r.get("/plans/:id", { schema: { params: IdParam,
    response: { 200: PlanDoc, ...errors(400, 401, 404, 500) } } }, async (req) => {
    return withTenant(req.tenantId, async (tx) => found(await loadPlanById(tx, req.params.id), "plan", req.params.id));
  });

  // 승인·거절 (T09·T10). 화면이 본 planHash와 저장된 planHash가 다르면 409
  r.post("/plans/:id/approvals", { schema: { params: IdParam, body: ApprovalInput,
    response: { 200: ApprovalResult, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    return req.idempotent(reply, async (tx) => {
      const plan = found(await loadPlanById(tx, req.params.id), "plan", req.params.id);
      const latest = await loadLatestPlan(tx, plan.migrationId);
      // 더 새 계획이 있으면 이 계획은 승인할 수 없다
      if (!latest || latest.planId !== plan.planId)
        throw new DomainError(409, "PLAN_SUPERSEDED", `plan ${plan.planId} is not the latest`);
      if (req.body.planHash !== plan.planHash)
        throw new DomainError(409, "PLAN_HASH_MISMATCH", "plan changed since you viewed it");
      // L7: 만료는 DB 시계로 (T09 전이 조건과 같은 기준)
      if ((await planExpired(tx, plan.planId)) !== false)
        // TODO(human): 만료된 계획을 승인하려 하면 awaiting_approval → stale로 옮길지. 지금은 409만
        throw new DomainError(409, "PLAN_EXPIRED", plan.expiresAt);

      const approve = req.body.decision === "approve";
      // PA4: 승인이면 확인 항목을 전부 덮어야 한다 (거절은 안 봄). advance() 전에 막으므로 상태·잠금 그대로
      if (approve && planAcksOn()) {
        const missing = missingAcks(plan, req.body.acks);
        if (missing.length) throw new DomainError(409, "ACKS_MISSING", `missing acks: ${missing.join(", ")}`);
      }
      const to = approve ? "approved" : "rejected";
      // 승인이면 advance()가 같은 트랜잭션에서 출발·도착 환경 잠금을 예약한다 (설계 5.4, 충돌 시 409 ENV_BUSY)
      // T09 조건이 "계획이 제안 상태 + 지문 일치 + 만료 전"을 plans 표에서 다시 본다
      await advance(tx, { id: plan.migrationId, tenantId: req.tenantId }, "awaiting_approval", to, {
        evidence: { planHash: req.body.planHash, reason: req.body.reason },
        // PA4: 확인한 항목은 감사 detail 에 남긴다 (plan_approvals 에 칸 없음 → 마이그레이션 0). 안 보냈으면 예전 detail 그대로
        audit: auditOk(req, `plan.${to}`, plan.migrationId, { planId: plan.planId, planHash: plan.planHash,
          ...(req.body.acks ? { acks: req.body.acks } : {}) }),
      });
      // DECISION(team): 역할 없음, 회사 멤버 누구나 승인, 본인 승인 허용 → self_approved로 기록 (입력층 v1, 10/31)
      await saveApproval(tx, req.tenantId, plan.migrationId, {
        planId: plan.planId, planHash: plan.planHash, decision: req.body.decision,
        actor: req.actor, selfApproved: true, reason: req.body.reason,
      });
      return { status: 200, body: { migrationId: plan.migrationId, planId: plan.planId, status: to } };
    });
  });

  // 실행 시작 (T15). 승인된 계획의 지문을 apply 작업에 싣는다. 202
  // PA4: 본문 { planHash } 는 깃발 off 면 없어도 된다 (지금 화면·smoke 그대로)
  r.post("/migrations/:id/start", { schema: { params: IdParam, body: StartInput.nullish(),
    response: { 202: Accepted, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      const m = await migrationOf(tx, id);
      const appr = await loadLatestApproval(tx, id);
      if (m.status === "approved" && !appr)
        throw new DomainError(409, "PLAN_NOT_APPROVED", id);
      // PA4: 비용 드는 apply 직전 두 번째 게이트. 화면이 본 지문 = 승인한 지문이어야 시작
      if (planAcksOn() && m.status === "approved" && req.body?.planHash !== appr?.planHash)
        throw new DomainError(409, "PLAN_HASH_MISMATCH", req.body?.planHash ? "plan changed since approval" : "planHash required");
      // A8: 회사당 동시 진행 상한 (TENANT_MAX_ACTIVE, 기본 꺼짐). 넘으면 409 TENANT_BUSY
      if (m.status === "approved") await assertTenantCapacity(tx, req.tenantId, id);
      await advance(tx, { id, tenantId: req.tenantId }, "approved", "provisioning", {
        // 설계 5.3: apply는 도착 환경 단위로 하나씩 (singletonKey = 도착 환경)
        next: nextJob(req, QUEUES.apply, id, { extra: { planId: appr?.planId, planHash: appr?.planHash },
                                               singletonKey: `apply:${m.targetEnvId}` }),
        audit: auditOk(req, "migration.provisioning", id, { planId: appr?.planId }),
      });
      return { status: 202, body: { id } };
    });
  });

  // 다시 계획하기. failed(실패 지점이 provisioning 이하)·stale·rejected 에서 planning 으로 되돌리고 plan 작업을 넣는다. 202
  // DRAFT(ai): H-8 이른 실패의 환경 잠금은 지금 코드대로 실패 때 이미 풀려 있다(advance.ts RELEASES_LOCK). 설계 6.4(잠금 유지)와 어긋남 —
  //   다시 승인할 때 잠금을 새로 예약하고, 그 사이 다른 이전이 같은 환경을 잡으면 409 ENV_BUSY. 어긋남은 PR 설명에 적는다
  // DRAFT(ai): H-9 importing·prechecking 에서 실패한 이전은 여기서 막는다(409 REPLAN_NOT_ALLOWED) — "취소 후 새 이전".
  //   T37 가드(guards.ts)는 그대로 둔다. 그 밖의 실패 지점(cutover 등)은 가드가 409 GUARD_FAILED 로 막는다
  // PA5a: 실패 재시도가 한도(RETRY_BUDGET, 기본 3) 이상이면 본문 acceptCustomerCost:true 필요 → 없으면 409 RETRY_BUDGET_EXHAUSTED
  r.post("/migrations/:id/replan", { schema: { params: IdParam, body: RetryBody.nullish(),
    response: { 202: Accepted, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      const m = await migrationOf(tx, id);
      if (m.status === "failed" && (m.failedAtStatus === "importing" || m.failedAtStatus === "prechecking"))
        throw new DomainError(409, "REPLAN_NOT_ALLOWED",
          `failed at ${m.failedAtStatus}: cancel and start a new migration`);
      const budget = m.status === "failed" ? await checkRetryBudget(tx, id, req.body?.acceptCustomerCost) : null;
      const planId = randomUUID();
      // precheck.ts 가 plan 작업을 넣는 모양 그대로 (작업 키 plan:<이전 번호>)
      await advance(tx, { id, tenantId: req.tenantId }, m.status, "planning", {
        next: { queue: QUEUES.plan,
                data: { tenantId: req.tenantId, requestId: req.id, migrationId: id, planId },
                opts: { singletonKey: `${QUEUES.plan}:${id}` } },
        audit: auditOk(req, "migration.replanning", id, { planId, fromStatus: m.status, failedAtStatus: m.failedAtStatus }),
      });
      // 실패를 사람이 다시 시도한 횟수 (재시도 한도는 이 줄을 센다). stale·rejected 에서 다시 계획하는 것은 실패 재시도가 아니라 세지 않는다
      if (m.status === "failed")
        await writeAudit(tx, req.tenantId, { actor: req.actor, action: "migration.retried", target: id, result: "ok",
          detail: { planId, failedAtStatus: m.failedAtStatus, via: "replan",
                    ...(budget ? { attempt: budget.attempt, customerCostAccepted: budget.customerCostAccepted } : {}) } });
      return { status: 202, body: { id } };
    });
  });

  // 거절된 계획 뒤에 명세부터 다시 고친다 (VALID rejected → spec_review). 202
  r.post("/migrations/:id/spec/reopen", { schema: { params: IdParam,
    response: { 202: Accepted, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      const m = await migrationOf(tx, id);
      await advance(tx, { id, tenantId: req.tenantId }, m.status, "spec_review", {
        audit: auditOk(req, "migration.spec_reopened", id, { fromStatus: m.status }),
      });
      return { status: 202, body: { id } };
    });
  });
}
