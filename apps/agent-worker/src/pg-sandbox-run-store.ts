import { QUEUES, type RehearsalFailureCode, type RehearsalResult, type SandboxRunPhase, type SandboxRunStatus } from "@svc/contracts";
import { jobKey, wakeQueued, withTenant, writeAudit } from "@svc/core";

// sandbox_runs 저장소 (db 0046). agent-worker 몫의 상태 옮기기만 한다: queued → running → passed | failed | error.
// 모두 조건부 UPDATE 라 두 번 온 작업·워커의 기한 처리(REHEARSAL_TIMEOUT)와 겹쳐도 먼저 쓴 쪽이 이긴다.
//   워커 expireRun 은 deadline_at <= now(), 잡기는 deadline_at > now() 일 때만 → 같은 줄을 둘이 같이 가져가지 않는다
// 결과를 쓴 같은 트랜잭션에서 감사 한 줄과, RetryLater 로 기다리는 deploy 작업 깨우기 (설계 2.4)
// tenantId: 줄의 tenant_id (소문자 UUID 글). 샌드박스 네임스페이스 회사 라벨은 작업 내용이 아니라 이 값을 쓴다
// expired: 줄 서기 기한이 지난 queued 줄이거나 워커가 기한으로 닫은 줄 (DB 시계)
export interface SandboxRunRow { migrationId: string; tenantId: string; status: SandboxRunStatus; input: unknown; expired: boolean }
// 결과가 없는 끝: 입력이 계약에 안 맞거나 처리기가 결과를 못 만든 경우 (샌드박스 쪽 오류)
export type RehearsalFinish = { result: RehearsalResult } | { failureCode: RehearsalFailureCode; reason: string };
export interface SandboxRunStore {
  load(tenantId: string, id: string): Promise<SandboxRunRow | null>;
  // 잡으면 새 실행 기한(지금 + runBudgetSec, null 이면 기한 그대로)을, 못 잡으면(다른 배달이 잡음·줄 서기 기한 지남) null
  claim(tenantId: string, id: string, sandboxName: string, runBudgetSec: number | null): Promise<Date | null>;
  phase(tenantId: string, id: string, phase: SandboxRunPhase): Promise<void>;
  // running 이 아니면(워커가 이미 기한으로 닫음) null
  finish(tenantId: string, id: string, f: RehearsalFinish): Promise<{ status: SandboxRunStatus; woken: number } | null>;
}

const statusOf = (f: RehearsalFinish): SandboxRunStatus => ("result" in f ? f.result.verdict : "error");

export function pgSandboxRunStore(): SandboxRunStore {
  return {
    async load(tenantId, id) {
      const r = (await withTenant(tenantId, (tx) => tx.query(
        `SELECT migration_id, tenant_id::text AS tenant_id, status, input,
                COALESCE((status = 'queued' AND deadline_at <= now()) OR failure_code = 'REHEARSAL_TIMEOUT', false) AS expired
           FROM sandbox_runs WHERE id = $1 AND purpose = 'rehearsal'`, [id]))).rows[0];
      return r ? { migrationId: r.migration_id, tenantId: r.tenant_id, status: r.status, input: r.input, expired: r.expired } : null;
    },
    async claim(tenantId, id, sandboxName, runBudgetSec) {
      const r = await withTenant(tenantId, (tx) => tx.query(
        `UPDATE sandbox_runs SET status = 'running', phase = 'creating', started_at = now(), sandbox_name = $2, host_namespace = $2,
                deadline_at = COALESCE(now() + make_interval(secs => $3::int), deadline_at)
          WHERE id = $1 AND status = 'queued' AND deadline_at > now() RETURNING deadline_at`, [id, sandboxName, runBudgetSec]));
      return (r.rows[0]?.deadline_at as Date | undefined) ?? null;
    },
    async phase(tenantId, id, phase) {
      await withTenant(tenantId, (tx) => tx.query("UPDATE sandbox_runs SET phase = $2 WHERE id = $1 AND status = 'running'", [id, phase]));
    },
    async finish(tenantId, id, f) {
      const status = statusOf(f);
      const result = "result" in f ? f.result : null;
      const failureCode = result ? result.failureCode : (f as { failureCode: RehearsalFailureCode }).failureCode;
      return withTenant(tenantId, async (tx) => {
        const row = (await tx.query(
          `UPDATE sandbox_runs SET status = $2, phase = 'done', result = $3, failure_code = $4, finished_at = now(),
                  deleted_at = CASE WHEN $5 THEN now() END
            WHERE id = $1 AND status = 'running' RETURNING migration_id, sandbox_name`,
          [id, status, result, failureCode, result?.deleted ?? false])).rows[0];
        if (!row) return null;
        await writeAudit(tx, tenantId, {
          actor: "agent_worker", action: "sandbox.rehearsal", target: row.migration_id, result: status === "passed" ? "ok" : "error",
          detail: { sandboxRunId: id, status, failureCode, sandboxName: row.sandbox_name, deleted: result?.deleted ?? false,
            mock: result?.sandbox.mock ?? false, timingsMs: result?.timingsMs ?? null, ...("reason" in f ? { reason: f.reason.slice(0, 200) } : {}) },
        });
        const woken = await wakeQueued(tx, QUEUES.deploy, jobKey(QUEUES.deploy, { migrationId: row.migration_id })!);
        return { status, woken };
      });
    },
  };
}
