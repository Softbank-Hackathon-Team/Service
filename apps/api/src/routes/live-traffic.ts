import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withTenant, NotFound, trafficLeaseState, trafficTargetFor, type Tx } from "@svc/core";
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
    const id = req.params.id;
    const m = await tx.query("SELECT 1 FROM migrations WHERE id = $1", [id]);
    if (m.rowCount !== 1) throw new NotFound("migration", id);
    const q = await tx.query(
      `SELECT target_pct, observed_pct, reached, tolerance_pct, reobserve, step_started_at, observed_at
         FROM traffic_progress WHERE migration_id = $1`, [id]);
    // 감사 target·LB 이름은 글자 비교라 워커가 쓰는 모양(소문자 uuid)으로 찾는다
    const marks = trafficStubMarks(await stubFacts(tx, id.toLowerCase()));
    const p = q.rows[0];
    if (!p) return { migrationId: id, available: false, targetWeightPct: null, observedWeightPct: null, reached: null,
      tolerancePct: 10, reobserve: 0, stepStartedAt: null, observedAt: null, ...marks };
    return { migrationId: id, available: true, targetWeightPct: p.target_pct, observedWeightPct: p.observed_pct,
      reached: p.reached, tolerancePct: p.tolerance_pct, reobserve: p.reobserve,
      stepStartedAt: new Date(p.step_started_at).toISOString(), observedAt: new Date(p.observed_at).toISOString(), ...marks };
  }));
}

/** 흉내 표시의 재료. 서버는 워커 환경(MOCK_TRAFFIC·PROM_URL 은 차트가 worker 에만 넣는다)을 모르니 DB 에 남은 사실만 읽는다 */
export interface StubFacts {
  /** 워커 shift 가 마지막 결과 detail 에 남긴 metricsSource·trafficProvider (apps/worker jobs/shift.ts). 없으면 null */
  shiftMetrics: string | null;
  shiftProvider: string | null;
  /** 이 이전에 등록된 LB 자리(migration_traffic_targets)의 provider. 등록 안 됐으면 null */
  registeredProvider: string | null;
  /** 워커가 LB 이름 = 이전 번호로 LB 주인 자리를 쥐고 있다. 등록·TRAFFIC_LB_ID 가 없을 때의 대신 이름(worker platform.ts trafficFor)이라 메모리 LB 다 */
  fallbackLbHeld: boolean;
}

/**
 * DRAFT(ai): 화면이 가짜 숫자·가짜 LB 를 실측처럼 보이지 않게 하는 표시 (contracts TrafficShiftProgress).
 * 지표 출처는 워커가 shift 결과에 남긴 값만 믿는다 (첫 shift 가 도는 동안은 아직 기록이 없어 null).
 * LB 는 워커가 고르는 순서와 같게 본다(worker platform.ts trafficFor): 등록된 자리가 있으면 그 provider,
 * 없으면 지금 쥔 대신 이름 LB(흉내), 그것도 없으면 마지막 shift 결과. 모르는 값은 지어내지 않고 null
 */
export function trafficStubMarks(f: StubFacts): Pick<TrafficShiftProgress, "metricsSource" | "lbStub" | "lbRegistered"> {
  const metricsSource = f.shiftMetrics === "stub" || f.shiftMetrics === "prometheus" ? f.shiftMetrics : null;
  const lbStub = f.registeredProvider ? f.registeredProvider === "mock"
    : f.fallbackLbHeld ? true
    : f.shiftProvider ? f.shiftProvider === "mock"
    : null;
  return { metricsSource, lbStub, lbRegistered: f.registeredProvider !== null };
}

async function stubFacts(tx: Tx, migrationId: string): Promise<StubFacts> {
  const ev = await tx.query<{ metrics: string | null; provider: string | null }>(
    `SELECT detail->>'metricsSource' AS metrics, detail->>'trafficProvider' AS provider
       FROM audit_events WHERE target = $1 AND detail ? 'metricsSource' ORDER BY seq DESC LIMIT 1`, [migrationId]);
  const registered = await trafficTargetFor(tx, migrationId);
  const lease = await trafficLeaseState(tx, migrationId, migrationId);
  return { shiftMetrics: ev.rows[0]?.metrics ?? null, shiftProvider: ev.rows[0]?.provider ?? null,
    registeredProvider: registered?.provider ?? null, fallbackLbHeld: lease === "mine" };
}
