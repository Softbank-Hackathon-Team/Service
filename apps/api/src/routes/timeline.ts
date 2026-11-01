import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { withTenant, loadTimeline } from "@svc/core";
import { Timeline, errors } from "./responses.js";
import { IdParam, found } from "./kit.js";

// GET /api/v1/migrations/:id/timeline
// 감사 기록을 시간순 전이 타임라인으로. 상세 화면 타임라인·증적 리포트(Q)가 쓴다
// 회사 벽(withTenant) 안에서 읽으므로 다른 회사 이전 번호를 넣으면 404
export async function timelineRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/migrations/:id/timeline", { schema: { params: IdParam,
    response: { 200: Timeline, ...errors(400, 401, 404, 500) } } }, async (req) => {
    const t = found(await withTenant(req.tenantId, (tx) => loadTimeline(tx, req.params.id)), "migration", req.params.id);
    req.log.debug({ items: t.items.length }, "timeline built");
    return t;
  });
}
