import { CostEstimate } from "@svc/cost";
import { NotFound, type Tx } from "@svc/core";
import type { ReportInput } from "./build.js";
import type { AuditRow } from "./schema.js";
import { envNumber } from "@svc/contracts";

// DRAFT(ai): 체인 검증 때 읽는 감사 줄 상한. 데모 규모(회사당 수백 줄)면 처음부터 다 읽힌다.
// 넘으면 마지막 N줄만 확인하고 리포트에 partial로 표시한다
export const CHAIN_READ_LIMIT = envNumber(process.env.REPORT_CHAIN_LIMIT, 20000);

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const AUDIT_COLS = `seq, tenant_id AS "tenantId", ${ISO("at")} AS at, actor, action, target, result,
  detail, prev_hash AS "prevHash", hash`;
const toRow = (r: Record<string, unknown>): AuditRow => ({ ...(r as AuditRow), seq: Number(r.seq) });

// 리포트 재료를 한 트랜잭션(withTenant 안)에서 읽는다. RLS 때문에 남의 회사 이전은 NotFound
export async function loadReportInput(tx: Tx, migrationId: string): Promise<ReportInput> {
  const m = await tx.query(
    `SELECT m.id, m.status, m.failure_code AS "failureCode",
            s.id AS "sId", s.provider AS "sProvider", s.name AS "sName",
            t.id AS "tId", t.provider AS "tProvider", t.name AS "tName"
       FROM migrations m
       JOIN environments s ON s.id = m.source_env_id
       JOIN environments t ON t.id = m.target_env_id
      WHERE m.id = $1`, [migrationId]);
  const row = m.rows[0];
  if (!row) throw new NotFound("migration", migrationId);

  const ev = await tx.query(
    `SELECT ${AUDIT_COLS} FROM audit_events WHERE target = $1 ORDER BY seq`, [migrationId]);
  const events = ev.rows.map(toRow);

  // 회사 체인: 이 이전의 마지막 줄까지
  const lastSeq = events.at(-1)?.seq ?? 0;
  const cnt = await tx.query("SELECT count(*)::int AS n FROM audit_events WHERE seq <= $1", [lastSeq]);
  const total: number = cnt.rows[0].n;
  const ch = await tx.query(
    `SELECT * FROM (SELECT ${AUDIT_COLS} FROM audit_events WHERE seq <= $1 ORDER BY seq DESC LIMIT $2) x
      ORDER BY seq`, [lastSeq, CHAIN_READ_LIMIT]);
  const chain = ch.rows.map(toRow);

  const plans = await tx.query(
    `SELECT id AS "planId", plan_hash AS "planHash", plan_doc AS "planDoc"
       FROM plans WHERE migration_id = $1 ORDER BY created_at`, [migrationId]);
  const approvals = await tx.query(
    `SELECT plan_id AS "planId", decision, approved_by AS "approvedBy", plan_hash AS "planHash",
            ${ISO("created_at")} AS at
       FROM plan_approvals WHERE migration_id = $1 ORDER BY created_at`, [migrationId]);

  // DRAFT(ai): 비용 추정을 어디에 저장할지 아직 안 정해졌다(통합 대기: "plan에 cost 저장").
  // 우선 가장 최근 계획서의 planDoc.cost, 없으면 감사 detail.cost를 찾고, 모양이 CostEstimate일 때만 쓴다
  const candidates: unknown[] = [
    ...plans.rows.map((p) => (p.planDoc as { cost?: unknown } | null)?.cost).reverse(),
    ...events.map((e) => e.detail.cost).reverse(),
  ];
  const cost = candidates.map((c) => CostEstimate.safeParse(c)).find((r) => r.success)?.data ?? null;

  return {
    migration: {
      id: row.id, status: row.status, failureCode: row.failureCode,
      source: { id: row.sId, provider: row.sProvider, name: row.sName },
      target: { id: row.tId, provider: row.tProvider, name: row.tName },
    },
    events, chain,
    chainFromGenesis: total <= CHAIN_READ_LIMIT,
    plans: plans.rows.map((p) => ({ planId: p.planId, planHash: p.planHash })),
    approvals: approvals.rows,
    cost,
  };
}
