import { withTenant } from "@svc/core";
import type { LlmCacheStore, LlmResponse } from "@svc/agent";

// z75-59: 실제 LLM 응답 캐시의 Postgres 저장소 (표 agent_llm_cache, 회사 벽 RLS). 데모 초기화(tools/demo-reset.sh)는 이 표를 안 지운다
//   → 초기화 뒤 같은 장면을 다시 돌려도 맞는다. 기한이 지난 줄은 꺼내지 않고, 넣을 때 같은 회사의 지난 줄을 지운다
export function pgLlmCacheStore(): LlmCacheStore {
  return {
    async get(tenantId, key) {
      return withTenant(tenantId, async (tx) => {
        const r = await tx.query(
          `UPDATE agent_llm_cache SET hits = hits + 1, last_hit_at = now()
            WHERE key = $1 AND expires_at > now() RETURNING response`, [key]);
        return r.rows[0] ? { response: r.rows[0].response as LlmResponse } : null;
      });
    },
    async put(tenantId, key, e) {
      await withTenant(tenantId, async (tx) => {
        await tx.query(`DELETE FROM agent_llm_cache WHERE expires_at <= now()`);
        await tx.query(
          `INSERT INTO agent_llm_cache (tenant_id, key, model, response, expires_at)
           VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
           ON CONFLICT (tenant_id, key) DO UPDATE SET model = EXCLUDED.model, response = EXCLUDED.response,
             created_at = now(), expires_at = EXCLUDED.expires_at`,
          [tenantId, key, e.model, e.response, e.ttlSec]);
      });
    },
  };
}
