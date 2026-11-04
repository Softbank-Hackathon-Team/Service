import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppSpecV2, CostEstimate, PriceSourceSummary, Provider, type CostEstimateRequestInput } from "@svc/contracts";
import { latestAcceptedSpecV2, withTenant, type Tx } from "@svc/core";
import { summarizePriceSources } from "@svc/cost";
import { estimateCostCached } from "./cost-cache.js";
import { errors } from "./responses.js";
import { IdParam, found, isoUtc } from "./kit.js";

// GET /api/v1/migrations/:id/cost — 이전 한 건의 "출발 vs 도착" 월 비용 비교 (작업 Z2, DRAFT(ai))
//
// 읽는 순서
//   1) cost_estimates 표(작업 V 제안)에 저장된 추정. plan_id 붙은 것 먼저, 그다음 최신 (V CHANGES의 Q용 쿼리와 같음)
//   2) 없으면(또는 표가 아직 없으면) 그 자리에서 미리보기 계산. 저장하지 않는다(GET은 읽기 전용)
//      명세 = spec_versions 최신, 없거나 모양이 안 맞으면 DEMO_SPEC. 트래픽 = 피크 PREVIEW_PEAK_RPS
// 응답의 estimate는 contracts CostEstimate 그대로라 Q 리포트(summarizeCost)가 같은 값을 받아 쓸 수 있다.
//
// TODO(통합): 이 모양(MigrationCostView)을 packages/contracts/src/cost.ts로 옮기고 main.ts에 등록

export const PREVIEW_PEAK_RPS = 10; // DRAFT(ai): 설계 초안·V 비교표의 기준과 같은 10 rps. TODO(human): MAU 입력으로 바꿀지

// 명세가 아직 없을 때 쓰는 데모 앱 (packages/cost/test/helpers.ts spec()과 같은 값: 서비스 1대 x 250m/512Mi + Postgres 20GB)
export const DEMO_SPEC: AppSpecV2 = AppSpecV2.parse({
  schemaVersion: "2",
  app: { name: "demo-shop" },
  components: [
    { id: "demo-shop", kind: "service", props: {
      runtime: "k8s", origin: { runtime: "k8s", product: "unknown" },
      image: { source: "registry", repository: "ghcr.io/demo/shop", digest: `sha256:${"a".repeat(64)}` },
      ports: [{ port: 8080, protocol: "TCP" }], probes: { readiness: { type: "http", path: "/healthz", port: 8080 } },
      replicas: { min: 1, max: 1 }, serviceAccount: "default", resources: { request: { cpuMilli: 250, memMiB: 512 } }, env: [],
    } },
    { id: "db", kind: "postgres", props: { majorVersion: "16", storageGb: 20 } },
  ],
  links: [{ from: "demo-shop", to: "db", intent: "connect" }],
  entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], routes: [{
    matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "demo-shop", port: 8080, weight: 1 }] }] }] },
  posture: { permissions: [], network: [] },
});

const EnvRef = z.object({ id: z.uuid(), provider: Provider, name: z.string() }).strict();

// 출발 → 도착 한 쌍의 차이. estimate.savings는 "출발 → 가장 싼 곳"이라 도착과 다를 수 있어서 따로 둔다
export const PairDelta = z.object({
  from: Provider,
  to: Provider,
  sourceMonthlyUsd: z.number().nullable(),
  targetMonthlyUsd: z.number().nullable(),
  monthlyUsd: z.number().nullable(),        // 출발 - 도착. 양수 = 아낌, 음수 = 더 듦, null = 한쪽이 계산 불가
  creditPortionUsd: z.number(),             // 위 차이 중 크레딧 몫 (도착 크레딧 - 출발 크레딧)
}).strict();
export type PairDelta = z.infer<typeof PairDelta>;

export const MigrationCostView = z.object({
  migrationId: z.uuid(),
  source: EnvRef,
  target: EnvRef,
  origin: z.enum(["stored", "preview"]),    // stored = cost_estimates 줄, preview = 지금 계산(저장 안 함)
  storedId: z.uuid().nullable(),
  planId: z.uuid().nullable(),
  specFrom: z.enum(["stored", "spec_versions", "demo"]),
  estimate: CostEstimate,
  pair: PairDelta,
  priceSources: z.array(PriceSourceSummary),
  createdAt: z.string(),
}).strict();
export type MigrationCostView = z.infer<typeof MigrationCostView>;

const r1 = (x: number) => Math.round(x * 10) / 10;

// 순수 함수: 추정 결과에서 출발·도착 두 줄을 찾아 차이를 낸다
export function pairDelta(est: CostEstimate, from: Provider, to: Provider): PairDelta {
  const s = est.envs.find((e) => e.provider === from);
  const t = est.envs.find((e) => e.provider === to);
  const sm = s?.monthlyUsd ?? null;
  const tm = t?.monthlyUsd ?? null;
  return {
    from, to, sourceMonthlyUsd: sm, targetMonthlyUsd: tm,
    monthlyUsd: sm !== null && tm !== null ? r1(sm - tm) : null,
    creditPortionUsd: r1((t?.creditUsd ?? 0) - (s?.creditUsd ?? 0)),
  };
}

// 순수 함수: 미리보기 요청. 네 환경 전부 계산(화면에 다 그림), 출발은 from
export function previewRequest(spec: AppSpecV2, from: Provider): CostEstimateRequestInput {
  return {
    spec, from,
    targets: [...Provider.options],
    traffic: { peakRps: PREVIEW_PEAK_RPS },
    profile: "startup",
  };
}

type Row = {
  migrationId: string;
  source: z.infer<typeof EnvRef>;
  target: z.infer<typeof EnvRef>;
  stored: { id: string; planId: string | null; estimate: unknown; priceSources: unknown; createdAt: string } | null;
  spec: unknown;
};

// DB 읽기. 시험에서 바꿔 끼울 수 있게 밖으로 뺐다
export type CostLoader = (tenantId: string, migrationId: string) => Promise<Row | null>;

export const loadFromDb: CostLoader = (tenantId, migrationId) => withTenant(tenantId, async (tx: Tx) => {
  const m = await tx.query(
    `SELECT m.id,
            s.id AS sid, s.provider AS sp, s.name AS sn,
            t.id AS tid, t.provider AS tp, t.name AS tn
       FROM migrations m
       JOIN environments s ON s.id = m.source_env_id
       JOIN environments t ON t.id = m.target_env_id
      WHERE m.id = $1`, [migrationId]);
  const row = m.rows[0];
  if (!row) return null;

  // cost_estimates는 V 제안 표라 아직 없을 수 있다 → SAVEPOINT로 감싸 42P01(표 없음)이면 미리보기로
  let stored: Row["stored"] = null;
  await tx.query("SAVEPOINT cost_read");
  try {
    const q = await tx.query(
      `SELECT id, plan_id AS "planId", estimate, price_sources AS "priceSources",
              ${isoUtc("created_at")} AS "createdAt"
         FROM cost_estimates
        WHERE migration_id = $1
        ORDER BY (plan_id IS NOT NULL) DESC, created_at DESC
        LIMIT 1`, [migrationId]);
    stored = q.rows[0] ?? null;
    await tx.query("RELEASE SAVEPOINT cost_read");
  } catch (e) {
    await tx.query("ROLLBACK TO SAVEPOINT cost_read");
    if ((e as { code?: string }).code !== "42P01") throw e;
  }

  const sv = stored ? null
    : (await latestAcceptedSpecV2(tx, migrationId))?.specV2 ?? null;

  return {
    migrationId: row.id,
    source: { id: row.sid, provider: row.sp, name: row.sn },
    target: { id: row.tid, provider: row.tp, name: row.tn },
    stored, spec: sv,
  };
});

// 순수 조립: DB 줄 → 화면 응답
export function buildCostView(row: Row, now: () => Date = () => new Date()): MigrationCostView {
  const from = row.source.provider;
  const to = row.target.provider;
  if (row.stored) {
    const est = CostEstimate.safeParse(row.stored.estimate);
    const ps = z.array(PriceSourceSummary).safeParse(row.stored.priceSources);
    if (est.success) {
      return {
        migrationId: row.migrationId, source: row.source, target: row.target,
        origin: "stored", storedId: row.stored.id, planId: row.stored.planId, specFrom: "stored",
        estimate: est.data, pair: pairDelta(est.data, from, to),
        priceSources: ps.success ? ps.data : [], createdAt: row.stored.createdAt,
      };
    }
    // 저장된 줄 모양이 깨졌으면 미리보기로 내려간다 (화면은 origin으로 구분)
  }
  const parsed = AppSpecV2.safeParse(row.spec);
  const spec = parsed.success ? parsed.data : DEMO_SPEC;
  const estimate = estimateCostCached(previewRequest(spec, from));   // Z49: 같은 입력 60초 기억
  return {
    migrationId: row.migrationId, source: row.source, target: row.target,
    origin: "preview", storedId: null, planId: null,
    specFrom: parsed.success ? "spec_versions" : "demo",
    estimate, pair: pairDelta(estimate, from, to),
    priceSources: summarizePriceSources(), createdAt: now().toISOString(),
  };
}

export async function migrationCostRoutes(app: FastifyInstance, opts: { load?: CostLoader } = {}) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const load = opts.load ?? loadFromDb;
  r.get("/migrations/:id/cost", {
    schema: { params: IdParam, response: { 200: MigrationCostView, ...errors(400, 401, 404, 500) } },
  }, async (req) => {
    return buildCostView(found(await load(req.tenantId, req.params.id), "migration", req.params.id));
  });
}
