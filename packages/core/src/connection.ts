import { canTransition, VerifyConnectionJob, type ConnectionStatus, type Provider } from "@svc/contracts";
import { pool, type Tx } from "./db.js";
import { boss, asBossDb, jobKey } from "./boss.js";
import { writeAudit } from "./audit.js";
import { NotFound, InvalidTransition } from "./errors.js";

// 환경 연결 상태 전이 위반. 409 INVALID_TRANSITION 그대로 (부르는 쪽이 이전 전이와 같은 모양으로 받는다)
export class ConnectionTransitionError extends InvalidTransition {}

export interface AdvanceConnectionOpts {
  from?: ConnectionStatus[];          // 이 상태일 때만 (낙관적 확인). 없으면 전이 표만 본다
  failureReason?: string | null;      // failed·unstable·disconnected 일 때 적는다. connected로 가면 지운다
  failures?: number;                  // verify_failures 칸 값 (주기 재확인)
  touchVerified?: boolean;            // last_verified_at = now()
  linkIssued?: boolean;               // link_issued_at = now()
  verifyJob?: { tenantId: string; requestId: string; reason: "user" | "periodic" };  // 같은 트랜잭션에 큐
  audit: { actor: string; action: string; detail?: Record<string, unknown> };
}

export interface AdvanceConnectionResult {
  from: ConnectionStatus;
  to: ConnectionStatus;
  jobQueued: boolean | null;          // verifyJob 없으면 null. false = 같은 키 작업이 이미 대기 중 (오류 아님)
}

// 환경 연결 상태를 바꾸는 유일한 길 (CLAUDE.md 5-5를 환경에도 적용).
// TODO(human): H-L13 environments.connection_status를 이 함수 밖에서 UPDATE 하지 않는다는 규칙을 CLAUDE.md에 올릴지
// TODO(human): 환경 상태 SSE 신호(pg_notify) 모양은 API·오케 SSE 계약과 같이 정한다. 이번엔 안 보낸다
export async function advanceConnection(tx: Tx, tenantId: string, envId: string, to: ConnectionStatus,
  o: AdvanceConnectionOpts): Promise<AdvanceConnectionResult> {
  // 1. 다시 읽고 잠금. 남의 회사 환경은 RLS로 0줄 → 404 (403 아님)
  const r = await tx.query<{ provider: Provider; connection_status: ConnectionStatus }>(
    "SELECT provider, connection_status FROM environments WHERE id = $1 FOR UPDATE", [envId]);
  const row = r.rows[0];
  if (!row) throw new NotFound("environment", envId);
  const from = row.connection_status;

  // 2. 낙관적 확인 + 전이 표 (온프레 전용 줄 포함)
  if (o.from && !o.from.includes(from)) throw new ConnectionTransitionError(from, to);
  if (!canTransition(row.provider, from, to)) throw new ConnectionTransitionError(from, to);

  // 3. 상태와 곁 칸. failure_reason: connected면 지우고, 값을 줬으면 적고, 안 줬으면 그대로
  const reasonMode = to === "connected" ? "clear" : o.failureReason !== undefined ? "set" : "keep";
  await tx.query(
    `UPDATE environments SET
       connection_status = $2,
       failure_reason = CASE $3::text WHEN 'clear' THEN NULL WHEN 'set' THEN $4::text ELSE failure_reason END,
       verify_failures = COALESCE($5::int, verify_failures),
       last_verified_at = CASE WHEN $6::boolean THEN now() ELSE last_verified_at END,
       link_issued_at = CASE WHEN $7::boolean THEN now() ELSE link_issued_at END
     WHERE id = $1`,
    [envId, to, reasonMode, o.failureReason ?? null, o.failures ?? null, o.touchVerified === true, o.linkIssued === true]);

  // 4. 확인 작업 (같은 트랜잭션). 같은 키가 이미 대기 중이면 null → 오류 아님 (부르는 라우트가 "이미 확인 중"으로 답한다)
  let jobQueued: boolean | null = null;
  if (o.verifyJob) {
    const data = VerifyConnectionJob.parse({ ...o.verifyJob, envId });
    const key = jobKey("verify-connection", { envId });
    // PF10 (9회차 대량): 주기 재확인(periodic)이 수백 개 쌓여 있어도 사람이 누른 확인(user)이 먼저 (pg-boss 는 priority 큰 것부터)
    const jobId = await boss.send("verify-connection", data,
      { ...(key ? { singletonKey: key } : {}), ...(data.reason === "user" ? { priority: VERIFY_USER_PRIORITY } : {}), db: asBossDb(tx) });
    jobQueued = jobId !== null;
  }

  // 5. 감사 (트랜잭션의 마지막 잠금)
  await writeAudit(tx, tenantId, {
    actor: o.audit.actor, action: o.audit.action, target: envId, result: "ok",
    detail: { ...(o.audit.detail ?? {}), from, to, ...(jobQueued !== null ? { jobQueued } : {}) },
  });
  return { from, to, jobQueued };
}

// DRAFT(ai): 사람이 누른 연결 확인의 큐 우선순위. 주기 재확인은 기본 0.
//   verify-connection 큐는 워커 하나가 한 번에 1건이라, 1시간 훑기가 500개를 넣으면 새 고객 확인이 몇 시간 뒤로 밀렸다
export const VERIFY_USER_PRIORITY = 10;

// L4b: 주기 재확인 훑기 전용. 모든 회사의 연결됨·불안정 환경 (번호만).
// withTenant 밖에서 pool 을 쓰는 예외다 (envlock.ts listExpiredEnvLocks 와 같음). 회사 벽은 DB 함수(svc_maintenance 소유, 0026)가 지키고,
// 받은 번호로 하는 실제 확인·변경은 verify-connection 처리기가 그 회사의 withTenant 안에서 다시 읽고 한다
export async function listVerifyDue(maxRows = 500): Promise<Array<{ envId: string; tenantId: string }>> {
  const r = await pool.query<{ env_id: string; tenant_id: string }>("SELECT * FROM maint_verify_due($1)", [maxRows]);
  return r.rows.map((x) => ({ envId: x.env_id, tenantId: x.tenant_id }));
}
