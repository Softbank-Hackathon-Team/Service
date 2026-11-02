import { randomUUID } from "node:crypto";
import { QUEUES, agentLlmStatusFromEnv, llmBudgetFromEnv, llmSpendView, type AgentRunKind } from "@svc/contracts";
import type { Tx } from "./db.js";
import { boss, asBossDb, jobKey, parseJobData } from "./boss.js";

// AI 실행 한 건 넣기 (PA5a, 계획 26 · A5a): agent_runs 한 줄 + agent-run 큐 작업을 같은 트랜잭션에 넣는다.
// 던지지 않는 판: 넣을 수 없으면 { skipped: 이유 } 를 돌려준다. advance() 의 실패 전이가 분석 때문에 막히면 안 되기 때문
//   - busy             같은 이전·같은 종류가 아직 queued·running (LLM 비용 두 번 막기)
//   - llm_key_missing  ANTHROPIC_API_KEY 없음 (넣어도 워커가 바로 실패)
//   - budget_exceeded  이 회차 지출 상한 이상 (같은 tx 쿼리로 읽음. API loadSpendDb 는 따로 트랜잭션이라 못 씀)
//   - budget_config    LLM_BUDGET_* 설정이 틀림
//   - job_not_created  같은 작업 키가 이미 대기 중 (pg-boss singletonKey)
// 감사는 부르는 쪽이 남긴다 (잠금 순서: 이전 행 → … → 큐 → 감사. 감사가 마지막)
// 이전 행 FOR UPDATE 도 부르는 쪽이 먼저 잡는다 (advance 1단계, startRemediateRun)

export type QueueAgentSkip = "busy" | "llm_key_missing" | "budget_exceeded" | "budget_config" | "job_not_created" | "error";
export type QueueAgentResult = { runId: string; jobId: string } | { skipped: QueueAgentSkip; busyRunId?: string };
export type SendAgentJob = (tx: Tx, data: unknown, singletonKey: string | undefined) => Promise<string | null>;
const bossSend: SendAgentJob = (tx, data, singletonKey) =>
  boss.send(QUEUES.agentRun, data as object, { ...(singletonKey ? { singletonKey } : {}), db: asBossDb(tx) });

export async function queueAgentRun(tx: Tx, o: {
  tenantId: string; migrationId: string; requestId: string; kind: AgentRunKind; task: string;
  singletonKey?: string;                 // 비우면 agent-run:<runId> (예전 startRemediateRun 과 같음)
  checkLlm?: boolean;                    // 키·지출 상한을 여기서 볼지. API 경로는 tx 밖에서 먼저 봐서 false
  send?: SendAgentJob; env?: Record<string, string | undefined>;
}): Promise<QueueAgentResult> {
  const busy = (await tx.query(
    `SELECT id FROM agent_runs WHERE migration_id=$1 AND kind=$2 AND status IN ('queued','running')
      ORDER BY created_at DESC LIMIT 1`, [o.migrationId, o.kind])).rows[0] as { id: string } | undefined;
  if (busy) return { skipped: "busy", busyRunId: busy.id };
  if (o.checkLlm) {
    const why = await llmBlocked(tx, o.env ?? process.env);
    if (why) return { skipped: why };
  }
  const runId = randomUUID();
  // 작업을 먼저 넣고 줄은 그 뒤에: 작업이 안 생기면 줄도 안 남긴다 (같은 tx 라 워커는 확정 뒤에야 둘 다 본다)
  const data = parseJobData(QUEUES.agentRun, { tenantId: o.tenantId, requestId: o.requestId, agentRunId: runId });
  const jobId = await (o.send ?? bossSend)(tx, data, o.singletonKey ?? jobKey(QUEUES.agentRun, { agentRunId: runId }));
  if (!jobId) return { skipped: "job_not_created" };
  await tx.query(
    `INSERT INTO agent_runs (id, tenant_id, migration_id, kind, task) VALUES ($1,$2,$3,$4,$5)`,
    [runId, o.tenantId, o.migrationId, o.kind, o.task]);
  return { runId, jobId };
}

// 키 없음·지출 상한. 표·함수가 없는 옛 DB 면 상한 검사 없이 통과 (tx 를 깨지 않게 to_regclass 로 먼저 본다)
async function llmBlocked(tx: Tx, env: Record<string, string | undefined>): Promise<QueueAgentSkip | null> {
  let state;
  try { state = agentLlmStatusFromEnv(env, { keyFlag: true }).state; } catch { return "budget_config"; }
  if (state === "key_missing") return "llm_key_missing";
  if (state !== "ready") return null;   // FAKE_LLM=1: 돈이 안 듦
  let b;
  try { b = llmBudgetFromEnv(env); } catch { return "budget_config"; }
  const has = (await tx.query(
    `SELECT to_regclass('public.llm_spend') IS NOT NULL AS t,
            to_regprocedure('public.llm_spend_round_total(text)') IS NOT NULL AS f`)).rows[0] as { t: boolean; f: boolean };
  if (!has.t) return null;
  const r = (await tx.query("SELECT usd, calls FROM llm_spend WHERE round = $1", [b.round])).rows[0];
  const total = has.f ? Number((await tx.query("SELECT llm_spend_round_total($1) AS t", [b.round])).rows[0].t) : undefined;
  const v = llmSpendView(b, { usd: r ? Number(r.usd) : 0, calls: r ? r.calls : 0, ...(total !== undefined ? { totalUsd: total } : {}) });
  return v.exceeded ? "budget_exceeded" : null;
}
