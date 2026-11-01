import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withTenant, NotFound } from "@svc/core";
import { TrafficShiftProgress } from "@svc/contracts";
import { LiveTrafficView, readLiveTraffic, type FetchLike } from "../live-traffic.js";

// GET /api/v1/migrations/:id/live-traffic (작업 Z35 = Z15 제안 3, DRAFT(ai))
// 이전 동안 앱 요청이 몇 건 지나갔고 몇 건 실패했는지, p95 는 얼마인지. 상세 화면 "가동 중 앱" 칸이 1초마다 부른다.
// 회사 벽: 이전이 이 회사 것인지 먼저 본다(아니면 404). 숫자는 LIVE_TRAFFIC_URL 프록시가 이 이전을 보고 있을 때만.
// 설정이 없거나 프록시가 죽어도 200 + available:false (화면이 "숫자 없음, 이유"를 보여 준다)
// TODO(통합): main.ts·gen-openapi.ts 에 등록 (proposals/main-ts.patch, proposals/gen-openapi.patch)
export async function liveTrafficRoutes(app: FastifyInstance, opts: { fetch?: FetchLike; url?: string } = {}) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/migrations/:id/live-traffic", {
    schema: { params: z.object({ id: z.uuid() }), response: { 200: LiveTrafficView } },
  }, async (req) => {
    const found = await withTenant(req.tenantId, async (tx) =>
      (await tx.query("SELECT 1 FROM migrations WHERE id = $1", [req.params.id])).rowCount === 1);
    if (!found) throw new NotFound("migration", req.params.id);
    // 부를 때마다 읽는다 (시험이 환경변수를 바꿔도 먹게)
    return readLiveTraffic(req.params.id, { url: opts.url ?? process.env.LIVE_TRAFFIC_URL, fetch: opts.fetch });
  });

  // z75-38: 트래픽 전환 진행. 워커 shift 가 판정마다 traffic_progress 한 줄을 덮어쓴다 (회사 벽 RLS). 없으면 available:false
  r.get("/migrations/:id/traffic-shift", {
    schema: { params: z.object({ id: z.uuid() }), response: { 200: TrafficShiftProgress } },
  }, async (req) => withTenant(req.tenantId, async (tx) => {
    const m = await tx.query("SELECT 1 FROM migrations WHERE id = $1", [req.params.id]);
    if (m.rowCount !== 1) throw new NotFound("migration", req.params.id);
    const q = await tx.query(
      `SELECT target_pct, observed_pct, reached, tolerance_pct, reobserve, step_started_at, observed_at
         FROM traffic_progress WHERE migration_id = $1`, [req.params.id]);
    const p = q.rows[0];
    if (!p) return { migrationId: req.params.id, available: false, targetWeightPct: null, observedWeightPct: null, reached: null,
      tolerancePct: 10, reobserve: 0, stepStartedAt: null, observedAt: null };
    return { migrationId: req.params.id, available: true, targetWeightPct: p.target_pct, observedWeightPct: p.observed_pct,
      reached: p.reached, tolerancePct: p.tolerance_pct, reobserve: p.reobserve,
      stepStartedAt: new Date(p.step_started_at).toISOString(), observedAt: new Date(p.observed_at).toISOString() };
  }));
}
