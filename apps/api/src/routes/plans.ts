import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApprovalInput, PlanDoc, QUEUES } from "@svc/contracts";
import { withTenant, advance, DomainError, planExpired, type Tx } from "@svc/core";
import { Accepted, ApprovalResult, errors } from "./responses.js";
import { IdParam, auditOk, found, nextJob } from "./kit.js";
import { loadLatestApproval, loadLatestPlan, loadPlanById, saveApproval } from "./plan-store.js";

// 계획 → 승인 → 시작 경로 (설계 api-orchestrator-v1 3.4)
//   POST /migrations/:id/plan       spec_review → prechecking   (+ precheck 작업)
//   GET  /migrations/:id/plan       이 이전의 최신 계획서 (DRAFT(ai): 화면이 계획 번호를 알 길이 필요해서 추가)
//   GET  /plans/:id                 계획서 내용·지문
//   POST /plans/:id/approvals       awaiting_approval → approved | rejected  (planHash 바인딩)
//   POST /migrations/:id/start      approved → provisioning     (+ apply 작업)
// 상태를 바꾸는 POST 하나 = advance() 한 번.
// TODO(human): Idempotency-Key 필수 처리는 공용 플러그인이 붙으면 이 경로들에도 걸린다

async function migrationOf(tx: Tx, id: string) {
  const q = await tx.query(
    `SELECT id, status, source_env_id AS "sourceEnvId", target_env_id AS "targetEnvId"
       FROM migrations WHERE id=$1`, [id]);
  // 남의 회사 것도 RLS 때문에 404
  return found(q.rows[0] as { id: string; status: string; sourceEnvId: string; targetEnvId: string } | undefined,
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
      const to = approve ? "approved" : "rejected";
      // 승인이면 advance()가 같은 트랜잭션에서 출발·도착 환경 잠금을 예약한다 (설계 5.4, 충돌 시 409 ENV_BUSY)
      // T09 조건이 "계획이 제안 상태 + 지문 일치 + 만료 전"을 plans 표에서 다시 본다
      await advance(tx, { id: plan.migrationId, tenantId: req.tenantId }, "awaiting_approval", to, {
        evidence: { planHash: req.body.planHash, reason: req.body.reason },
        audit: auditOk(req, `plan.${to}`, plan.migrationId, { planId: plan.planId, planHash: plan.planHash }),
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
  r.post("/migrations/:id/start", { schema: { params: IdParam,
    response: { 202: Accepted, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    return req.idempotent(reply, async (tx) => {
      const m = await migrationOf(tx, id);
      const appr = await loadLatestApproval(tx, id);
      if (m.status === "approved" && !appr)
        throw new DomainError(409, "PLAN_NOT_APPROVED", id);
      await advance(tx, { id, tenantId: req.tenantId }, "approved", "provisioning", {
        // 설계 5.3: apply는 도착 환경 단위로 하나씩 (singletonKey = 도착 환경)
        next: nextJob(req, QUEUES.apply, id, { extra: { planId: appr?.planId, planHash: appr?.planHash },
                                               singletonKey: `apply:${m.targetEnvId}` }),
        audit: auditOk(req, "migration.provisioning", id, { planId: appr?.planId }),
      });
      return { status: 202, body: { id } };
    });
  });
}
