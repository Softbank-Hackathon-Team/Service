import { PlanDoc, InfraReady } from "@svc/contracts";
import type { Tx } from "./db.js";
import { writeAudit } from "./audit.js";

// 계획서·승인·"도착 자원 준비됨"을 읽고 쓰는 곳 (api 경로와 워커 작업이 같이 쓴다).
// 계획서·승인은 plans·plan_approvals 표(0004). 전이 조건 T07·T09가 이 표를 다시 읽는다.
// STUB: "도착 자원 준비됨"은 아직 표가 없어 감사 기록 detail에 둔다

// 새 계획 저장. 같은 이전의 이전 계획(제안 상태)은 "대체됨"으로 바꾼다
export async function savePlan(tx: Tx, tenantId: string, plan: PlanDoc): Promise<void> {
  const p = PlanDoc.parse(plan);
  await tx.query(
    "UPDATE plans SET status = 'superseded' WHERE migration_id = $1 AND status = 'proposed'",
    [p.migrationId]);
  await tx.query(
    `INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.planId, tenantId, p.migrationId, JSON.stringify(p), p.planHash, p.expiresAt]);
}

export async function loadPlanById(tx: Tx, planId: string): Promise<PlanDoc | null> {
  const q = await tx.query("SELECT plan_doc FROM plans WHERE id = $1", [planId]);
  return q.rows[0] ? PlanDoc.parse(q.rows[0].plan_doc) : null;
}

export async function loadLatestPlan(tx: Tx, migrationId: string): Promise<PlanDoc | null> {
  const q = await tx.query(
    "SELECT plan_doc FROM plans WHERE migration_id = $1 ORDER BY created_at DESC, id LIMIT 1",
    [migrationId]);
  return q.rows[0] ? PlanDoc.parse(q.rows[0].plan_doc) : null;
}

/** 계획 만료 여부를 DB 시계(now())로 본다. L7: 전이 조건(T09 facts.plan.expired)과 같은 시계를 쓰려고.
 *  서버 시계(Date.now)와 DB 시계가 어긋나면 "API는 통과, 전이 조건은 만료" 같은 엇갈림이 생긴다. 계획이 없으면 null */
export async function planExpired(tx: Tx, planId: string): Promise<boolean | null> {
  const r = await tx.query<{ expired: boolean }>(`SELECT expires_at <= now() AS expired FROM plans WHERE id = $1`, [planId]);
  return r.rows[0]?.expired ?? null;
}

export interface ApprovalRecord {
  planId: string; planHash: string; decision: "approve" | "reject";
  actor: string; selfApproved: boolean; reason?: string;
}

// 승인 기록 한 줄 + 계획 상태 바꾸기. advance(awaiting_approval → approved|rejected) 뒤에 부른다
// (T09 조건이 "계획이 제안 상태"를 보기 때문에, 먼저 바꾸면 조건이 막는다)
export async function saveApproval(tx: Tx, tenantId: string, migrationId: string, a: ApprovalRecord) {
  await tx.query(
    `INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, a.planId, migrationId, a.decision, a.actor, a.planHash, a.reason ?? null]);
  await tx.query("UPDATE plans SET status = $2 WHERE id = $1",
    [a.planId, a.decision === "approve" ? "approved" : "rejected"]);
}

// 이 이전에서 마지막으로 승인된 계획
export async function loadLatestApproval(tx: Tx, migrationId: string):
  Promise<{ planId: string; planHash: string } | null> {
  const q = await tx.query(
    `SELECT plan_id AS "planId", plan_hash AS "planHash" FROM plan_approvals
      WHERE migration_id = $1 AND decision = 'approve' ORDER BY created_at DESC LIMIT 1`, [migrationId]);
  return q.rows[0] ?? null;
}

// 자원 생성 → 배포로 넘길 때 "도착 자원 준비됨" (계약 InfraReady)
export async function saveInfraReady(tx: Tx, v: InfraReady) {
  await writeAudit(tx, v.tenantId, { actor: "worker", action: "infra.ready", target: v.migrationId,
    result: "ok", detail: { infraReady: InfraReady.parse(v) } });
}

export async function loadInfraReady(tx: Tx, migrationId: string): Promise<InfraReady | null> {
  const q = await tx.query(
    `SELECT detail->'infraReady' AS v FROM audit_events
      WHERE action = 'infra.ready' AND target = $1 ORDER BY seq DESC LIMIT 1`, [migrationId]);
  const raw = q.rows[0]?.v;
  return raw ? InfraReady.parse(raw) : null;
}
