import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { EnvCostView, MoveCostRequest, MoveCostView, Provider, envNumber, type PriceCatalog } from "@svc/contracts";
import { withTenant } from "@svc/core";
import { envCost, loadCatalog, moveCost, type EnvForCost, type InventoryForCost } from "@svc/cost";
import { errors } from "./responses.js";
import { IdParam, found } from "./kit.js";
import { storedInventory } from "./env-inventory.js";

// 근거 있는 비용 (계약 packages/contracts/src/cost-evidence.ts, 계산 packages/cost/src/evidence.ts)
//   GET  /api/v1/environments/:id/cost       — 지금 이 환경의 월 비용. 실자원 조회(worker 가 관찰 역할로 읽어 저장한 값)의 비용 사실로 센다
//   POST /api/v1/environments/:id/cost/move  — 이 환경(고른 범위)을 도착 후보로 옮기면 한 달·1년에 얼마인가 + 프로모션
// 읽기 전용: DB 쓰기 없음. 실자원 결과가 없거나 오래됐으면 /inventory 와 같은 규칙으로 다시 읽기만 요청한다 (storedInventory)
// ?lang=ko|en|ja — 근거 문장을 화면 언어로 만든다 (숫자·자원 이름이 섞여 웹 번역 표로는 못 바꿈)

const LangQuery = z.object({ lang: z.enum(["ko", "en", "ja"]).optional() }).strict();

export interface EnvCostLoader {
  env(tenantId: string, id: string): Promise<EnvForCost | null>;
  envs(tenantId: string, ids: string[]): Promise<EnvForCost[]>;
  inventory(tenantId: string, env: EnvForCost, requestId: string, warn: (o: object, msg: string) => void): Promise<InventoryForCost | null>;
}

const ENV_SQL = `SELECT id, name, provider, region FROM environments WHERE id = ANY($1::uuid[])`;
type EnvRow = { id: string; name: string; provider: Provider; region: string | null };

export const dbLoader: EnvCostLoader = {
  env: async (tenantId, id) => (await dbLoader.envs(tenantId, [id]))[0] ?? null,
  envs: (tenantId, ids) => withTenant(tenantId, async (tx) => (await tx.query(ENV_SQL, [ids])).rows as EnvRow[]),
  inventory: async (tenantId, env, requestId, warn) => {
    if (env.provider === "onprem" || env.provider === "azure_mock") return null;   // 온프레는 가정 모형, Azure 는 모의
    const s = await storedInventory({ tenantId, envId: env.id, provider: env.provider, requestId, warn });
    return s.inventory;
  },
};

// 가격표 파일(packages/cost/prices/*.json)을 요청마다 읽지 않게 잠깐 기억 (cost-cache.ts 와 같은 TTL)
const CATALOG_TTL_MS = envNumber(process.env.COST_CACHE_TTL_MS, 60_000);
let memo: { at: number; v: PriceCatalog } | null = null;
export function catalogNow(now = Date.now()): PriceCatalog {
  if (!memo || !(CATALOG_TTL_MS > 0) || now - memo.at >= CATALOG_TTL_MS) memo = { at: now, v: loadCatalog() };
  return memo.v;
}

export async function envCostRoutes(app: FastifyInstance, opts: { load?: EnvCostLoader; catalog?: () => PriceCatalog } = {}) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const load = opts.load ?? dbLoader;
  const catalog = opts.catalog ?? (() => catalogNow());

  r.get("/environments/:id/cost", {
    schema: { params: IdParam, querystring: LangQuery, response: { 200: EnvCostView, ...errors(400, 401, 404, 500) } },
  }, async (req) => {
    const env = found(await load.env(req.tenantId, req.params.id), "environment", req.params.id);
    const inv = await load.inventory(req.tenantId, env, req.id, (o, m) => req.log.warn(o, m));
    return envCost(env, inv, catalog(), req.query.lang ?? "ko");
  });

  r.post("/environments/:id/cost/move", {
    schema: { params: IdParam, querystring: LangQuery, body: MoveCostRequest, response: { 200: MoveCostView, ...errors(400, 401, 403, 404, 500) } },
  }, async (req) => {
    const source = found(await load.env(req.tenantId, req.params.id), "environment", req.params.id);
    const ids = [...new Set(req.body.targetEnvIds)];
    const targets = await load.envs(req.tenantId, ids);
    // 남의 회사 환경은 RLS 로 안 보인다 → 하나라도 없으면 404 (어느 것인지 알려 줌)
    for (const id of ids) found(targets.find((t) => t.id === id), "environment", id);
    const inv = await load.inventory(req.tenantId, source, req.id, (o, m) => req.log.warn(o, m));
    const ordered = ids.map((id) => targets.find((t) => t.id === id)!);
    return moveCost(source, inv, req.body.sourceScope, ordered, catalog(), req.query.lang ?? "ko");
  });
}
