import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withTenant, type Tx } from "@svc/core";
import { buildEvidenceReport, type ReportInput } from "../report/build.js";
import { loadReportInput } from "../report/load.js";
import { renderHtml, renderMarkdown } from "../report/render.js";
import { EvidenceReport } from "../report/schema.js";
import { errors } from "./responses.js";
import { IdParam } from "./kit.js";

export interface ReportRouteOpts {
  // 시험에서 DB 없이 경로를 돌리려고 재료 읽기를 바꿔 끼울 수 있게 했다. 기본은 DB에서 읽는다
  load?: (tenantId: string, migrationId: string) => Promise<ReportInput>;
}

const defaultLoad = (tenantId: string, id: string) =>
  withTenant(tenantId, (tx: Tx) => loadReportInput(tx, id));

// 이전 한 건의 증적 리포트. 읽기 전용이라 상태를 바꾸지 않고 감사도 남기지 않는다
// DRAFT(ai): 형식은 쿼리로 고른다 (json 기본 | md | html). Accept 헤더 협상은 안 함
export async function reportRoutes(app: FastifyInstance, opts: ReportRouteOpts = {}) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const load = opts.load ?? defaultLoad;

  r.get("/migrations/:id/report", {
    schema: {
      params: IdParam,
      querystring: z.object({ format: z.enum(["json", "md", "html"]).default("json") }).strict(),
      // Z17: json일 때만 이 스키마로 직렬화된다. md·html은 문자열을 send()해서 직렬화를 거치지 않는다
      response: { 200: EvidenceReport, ...errors(400, 401, 404, 500) },
    },
  }, async (req, reply) => {
    const report = buildEvidenceReport(await load(req.tenantId, req.params.id));
    reply.header("cache-control", "no-store");
    reply.header("x-report-hash", report.reportHash);
    // 글자 응답은 타입상 200 = EvidenceReport 밖이라 넓힌 reply로 보낸다 (실행 동작은 같다)
    const text = reply as FastifyReply;
    if (req.query.format === "md")
      return text.type("text/markdown; charset=utf-8").send(renderMarkdown(report));
    if (req.query.format === "html")
      return text.type("text/html; charset=utf-8")
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .send(renderHtml(report));
    return report;
  });
}
