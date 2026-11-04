import { withTenant, writeAudit } from "@svc/core";
import { llmCacheAuditDetail } from "@svc/agent";
import type { WorkingCopy } from "@svc/agent";
import { demoRepo, type AgentRunStore } from "./handle-agent-run.js";

// PF FM-ORC-19: 실패 원인 분석(failure_analysis, advance 가 실패 전이와 같은 트랜잭션에 넣음)도 같은 고리로 돈다.
//   예전엔 kind='remediate' 만 읽어 분석 줄이 queued 로 영원히 남고, 같은 이전의 다음 분석은 busy 로 건너뛰었다
const KINDS = "kind IN ('remediate','failure_analysis')";
// 작업 Z65: 장애 점검(remediate) Postgres 저장소. 표는 db/migrations/0006_agent_runs.sql (새 마이그레이션 없음)
// - 모든 쿼리는 withTenant 를 지난다 (회사 벽 RLS). 큐 내용(tenantId·agentRunId)은 믿지 않고 표에서 다시 읽는다
// - 상태는 앞으로만: queued → running(claim) → finished | failed(finish). 조건부 UPDATE 로 두 번 온 작업을 막는다
// - result 칸 = { finish, gate }. API GET /migrations/:id/agent-review 가 이 모양을 source:"db" 로 읽는다
export interface PgAgentRunStoreOpts {
  // 점검할 작업 복사본 기본값 (시험용 고정 파일). 운영은 main.ts 가 workcopy(GitOps 레포 deploy/)로 덮는다 (Z90b)
  repoFor?: (tenantId: string, migrationId: string | null) => Promise<WorkingCopy> | WorkingCopy;
}

export function pgAgentRunStore(opts: PgAgentRunStoreOpts = {}): AgentRunStore {
  const repoFor = opts.repoFor ?? (() => demoRepo());
  return {
    async load(tenantId, agentRunId) {
      const r = await withTenant(tenantId, async (tx) => (await tx.query(
        `SELECT status, task, migration_id FROM agent_runs WHERE id=$1 AND ${KINDS}`, [agentRunId])).rows[0]);
      if (!r) return null;
      return { status: r.status as string, task: r.task as string, repo: await repoFor(tenantId, r.migration_id ?? null) };
    },
    async claim(tenantId, agentRunId) {
      return withTenant(tenantId, async (tx) => (await tx.query(
        `UPDATE agent_runs SET status='running' WHERE id=$1 AND ${KINDS} AND status='queued' RETURNING id`,
        [agentRunId])).rowCount === 1);
    },
    async step(tenantId, agentRunId, s) {
      // seq 는 표 안에서 1부터 이어 붙인다 (StepRecord.step 은 LLM 턴 번호라 한 턴에 도구가 여럿이면 겹친다)
      await withTenant(tenantId, (tx) => tx.query(
        `INSERT INTO agent_steps (run_id, tenant_id, seq, tool, ok, note)
         SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4, $5 FROM agent_steps WHERE run_id=$1`,
        [agentRunId, tenantId, s.tool.slice(0, 40), s.ok, s.note.slice(0, 200)]));
    },
    async finish(tenantId, agentRunId, r) {
      await withTenant(tenantId, async (tx) => {
        const m = (await tx.query(
          `UPDATE agent_runs SET status=$2, reason=$3, model=$4, usage=$5, result=$6, finished_at=now()
            WHERE id=$1 AND ${KINDS} AND status='running' RETURNING migration_id, kind`,
          [agentRunId, r.state, r.reason.slice(0, 500), r.model, r.usage, { finish: r.finish, gate: r.gate, proposal: r.proposal ?? null }])).rows[0];
        if (!m) return; // running 이 아니면(이미 닫힘) 덮어쓰지 않는다
        await writeAudit(tx, tenantId, {
          actor: "ai_agent", action: m.kind === "failure_analysis" ? "agent.failure_analysis" : "agent.remediate", target: m.migration_id ?? agentRunId,
          result: r.state === "finished" ? "ok" : "error",
          detail: { agentRunId, outcome: r.finish?.outcome ?? null, gateOk: r.gate.ok, model: r.model, reason: r.reason.slice(0, 200), ...llmCacheAuditDetail(),
            branch: r.proposal && "branch" in r.proposal ? r.proposal.branch : null, commit: r.proposal && "commit" in r.proposal ? r.proposal.commit : null },
        });
      });
    },
  };
}
