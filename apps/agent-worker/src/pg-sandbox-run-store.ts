import { QUEUES, type RehearsalFailureCode, type RehearsalResult, type SandboxRunPhase, type SandboxRunStatus } from "@svc/contracts";
import { jobKey, wakeQueued, withTenant, writeAudit } from "@svc/core";

// sandbox_runs 저장소 (db 0046). agent-worker 몫의 상태 옮기기만 한다: queued → running → passed | failed | error.
// 모두 조건부 UPDATE 라 두 번 온 작업·워커의 기한 처리(REHEARSAL_TIMEOUT)와 겹쳐도 먼저 쓴 쪽이 이긴다.
// 결과를 쓴 같은 트랜잭션에서 감사 한 줄과, RetryLater 로 기다리는 deploy 작업 깨우기 (설계 2.4)
export interface SandboxRunRow { migrationId: string; status: SandboxRunStatus; input: unknown; deadlineAt: Date | null }
// 결과가 없는 끝: 입력이 계약에 안 맞거나 처리기가 결과를 못 만든 경우 (샌드박스 쪽 오류)
export type RehearsalFinish = { result: RehearsalResult } | { failureCode: RehearsalFailureCode; reason: string };
export interface SandboxRunStore {
  load(tenantId: string, id: string): Promise<SandboxRunRow | null>;
  claim(tenantId: string, id: string, sandboxName: string): Promise<boolean>;
  phase(tenantId: string, id: string, phase: SandboxRunPhase): Promise<void>;
  // running 이 아니면(워커가 이미 기한으로 닫음) null
  finish(tenantId: string, id: string, f: RehearsalFinish): Promise<{ status: SandboxRunStatus; woken: number } | null>;
}

const statusOf = (f: RehearsalFinish): SandboxRunStatus => ("result" in f ? f.result.verdict : "error");

export function pgSandboxRunStore(): SandboxRunStore {
  return {
    async load(tenantId, id) {
      const r = (await withTenant(tenantId, (tx) => tx.query(
        "SELECT migration_id, status, input, deadline_at FROM sandbox_runs WHERE id = $1 AND purpose = 'rehearsal'", [id]))).rows[0];
      return r ? { migrationId: r.migration_id, status: r.status, input: r.input, deadlineAt: r.deadline_at } : null;
    },
    async claim(tenantId, id, sandboxName) {
      return withTenant(tenantId, async (tx) => (await tx.query(
        `UPDATE sandbox_runs SET status = 'running', phase = 'creating', started_at = now(), sandbox_name = $2, host_namespace = $2
          WHERE id = $1 AND status = 'queued' RETURNING id`, [id, sandboxName])).rowCount === 1);
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
