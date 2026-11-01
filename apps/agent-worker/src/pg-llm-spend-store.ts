import { pool, withTenant } from "@svc/core";
import type { LlmSpendStore } from "@svc/agent";

// z75-64: 실제 LLM 지출 표 (llm_spend, 회사·회차 한 줄, 회사 벽 RLS). 더하기는 한 문장 UPSERT 라 여러 워커가 같이 더해도 안 잃는다
export function pgLlmSpendStore(): LlmSpendStore {
  const row = (r: { usd: string | number; calls: number } | undefined) => ({ usd: r ? Number(r.usd) : 0, calls: r ? r.calls : 0 });
  return {
    async get(tenantId, round) {
      return withTenant(tenantId, async (tx) =>
        row((await tx.query(`SELECT usd, calls FROM llm_spend WHERE round = $1`, [round])).rows[0]));
    },
    async add(tenantId, round, usd) {
      return withTenant(tenantId, async (tx) => row((await tx.query(
        `INSERT INTO llm_spend (tenant_id, round, usd, calls) VALUES ($1, $2, $3, 1)
         ON CONFLICT (tenant_id, round) DO UPDATE SET usd = llm_spend.usd + EXCLUDED.usd, calls = llm_spend.calls + 1, updated_at = now()
         RETURNING usd, calls`, [tenantId, round, usd])).rows[0]));
    },
    // 모든 회사 합: 회사 벽 밖 숫자 하나만 돌려주는 함수 (0021 llm_spend_round_total, 합 표는 트리거가 채움)
    async total(round) {
      return Number((await pool.query(`SELECT llm_spend_round_total($1) AS t`, [round])).rows[0].t);
    },
  };
}
