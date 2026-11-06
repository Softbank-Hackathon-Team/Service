import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { EnvCostView, MoveCostView, type BillingFacts } from "@svc/contracts";
import { loadCatalog, type EnvForCost } from "@svc/cost";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { envCostRoutes, type EnvCostLoader } from "../src/routes/env-cost.js";

// GET /environments/:id/cost · POST /environments/:id/cost/move (DB 대신 바꿔 끼운 loader, 가격표는 저장된 캐시)
const T = "11111111-1111-4111-8111-111111111111";
const H = { "x-dev-tenant": T };
const SRC: EnvForCost = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "customer-aws", provider: "aws", region: "ap-northeast-2" };
const DST: EnvForCost = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "customer-gcp", provider: "gcp", region: "asia-northeast3" };
const MISSING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const billing: BillingFacts = {
  clusters: [{ name: "shop-eks", location: null, zonal: null, autopilot: null, nodeCount: null, machineTypes: [] }],
  instances: [1, 2].map((n) => ({ name: `ng-${n}`, type: "t3.medium", state: "running", spot: false, cluster: "shop-eks", publicIp: null })),
  databases: [{ name: "shop-db", engine: "postgres", cls: "db.t3.medium", storageGb: 20, storageType: "gp3", multiAz: false }],
  loadBalancers: [], natGateways: [], addresses: [], errors: [],
};

function loader(seen: string[] = []): EnvCostLoader {
  const all = [SRC, DST];
  return {
    env: async (tenantId, id) => { seen.push(tenantId); return all.find((e) => e.id === id) ?? null; },
    envs: async (_t, ids) => all.filter((e) => ids.includes(e.id)),
    inventory: async (_t, env) => env.id === SRC.id ? { status: "ok", reason: null, checkedAt: "2026-11-06T02:00:00.000Z", groups: [], billing } : null,
  };
}

async function app(load = loader()) {
  const a = Fastify();
  a.setValidatorCompiler(validatorCompiler);
  a.setSerializerCompiler(serializerCompiler);
  await a.register(errorsPlugin);
  await a.register(authPlugin);
  const cat = loadCatalog();
  await a.register(envCostRoutes, { prefix: "/api/v1", load, catalog: () => cat });
  return a;
}

test("GET /environments/:id/cost: 지금 월 비용과 항마다 근거, 회사 번호로 읽는다, ?lang 으로 문장 언어", async () => {
  const seen: string[] = [];
  const a = await app(loader(seen));
  const res = await a.inject({ method: "GET", url: `/api/v1/environments/${SRC.id}/cost?lang=ja`, headers: H });
  assert.equal(res.statusCode, 200);
  const v = EnvCostView.parse(res.json());
  assert.equal(v.status, "ok");
  assert.equal(v.breakdown!.monthlyUsd, 236.95);   // 클러스터 73 + 노드 75.92 + 노드 디스크 3.65 + DB 81.76 + DB 저장 2.62
  assert.match(v.breakdown!.lines[0]!.label, /EKS クラスター管理料金/);
  assert.deepEqual(seen, [T]);
});

test("POST /environments/:id/cost/move: 도착별 한 달·1년과 프로모션, 요청 순서대로", async () => {
  const a = await app();
  const res = await a.inject({ method: "POST", url: `/api/v1/environments/${SRC.id}/cost/move`, headers: H,
    payload: { targetEnvIds: [DST.id], sourceScope: { cluster: "shop-eks" } } });
  assert.equal(res.statusCode, 200);
  const v = MoveCostView.parse(res.json());
  assert.equal(v.targets.length, 1);
  const t = v.targets[0]!;
  assert.equal(t.envId, DST.id);
  assert.ok(t.feasible);
  assert.equal(t.projection!.promotions.find((p) => p.id === "gcp-gke-free-tier")?.status, "applied");
  assert.ok(t.projection!.appliedYearlyUsd < t.projection!.yearlyUsd);
});

test("거부: 인증 없음 401, 잘못된 번호 400, 없는 환경 404, 빈 도착 목록·모르는 칸 400, 모르는 언어 400", async () => {
  const a = await app();
  const u = `/api/v1/environments/${SRC.id}/cost`;
  assert.equal((await a.inject({ method: "GET", url: u })).statusCode, 401);
  assert.equal((await a.inject({ method: "GET", url: "/api/v1/environments/nope/cost", headers: H })).statusCode, 400);
  assert.equal((await a.inject({ method: "GET", url: `/api/v1/environments/${MISSING}/cost`, headers: H })).statusCode, 404);
  assert.equal((await a.inject({ method: "GET", url: `${u}?lang=fr`, headers: H })).statusCode, 400);
  const mv = `${u}/move`;
  assert.equal((await a.inject({ method: "POST", url: mv, headers: H, payload: { targetEnvIds: [] } })).statusCode, 400);
  assert.equal((await a.inject({ method: "POST", url: mv, headers: H, payload: { targetEnvIds: [DST.id], extra: 1 } })).statusCode, 400);
  const nf = await a.inject({ method: "POST", url: mv, headers: H, payload: { targetEnvIds: [DST.id, MISSING] } });
  assert.equal(nf.statusCode, 404);
});
