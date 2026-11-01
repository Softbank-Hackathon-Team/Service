import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { CostEstimate, CostEstimateRequest } from "@svc/cost";
import { estimateCostCached } from "./cost-cache.js";
import { errors } from "./responses.js";

export async function costRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // 비용 추정. 순수 계산이라 DB 쓰기 없음
  // DRAFT(ai): 지금은 본문에 명세(spec)를 통째로 받는다. 나중에 spec_id로 DB에서 읽게 바꾼다
  // 가격표: packages/cost/prices/*.json 캐시를 샘플 위에 덮은 것 (네트워크 안 씀).
  // 캐시 갱신은 npm run prices:fetch -w @svc/cost. TODO(human): worker 하루 한 번 예약 작업으로 옮기기
  r.post("/cost/estimate", { schema: { body: CostEstimateRequest,
    response: { 200: CostEstimate, ...errors(400, 401, 403, 500) } } }, async (req) => {
    return estimateCostCached(req.body);   // Z49: 같은 본문 60초 기억 (COST_CACHE_TTL_MS=0 이면 매번 계산)
  });
}
