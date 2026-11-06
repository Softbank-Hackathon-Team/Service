// AWS 도착 사실을 실자원 읽기(inventory-refresh 가 둔 targetFacts)에서: TF_FACT_* 없이 계획·apply 가 도착 EKS 의 VPC·서브넷을 쓴다.
//   DB·클라우드 없이 (실자원 사실·Terraform 실행기·저장소는 가짜)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RealApplyResult } from "@svc/adapters";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { realApplyWithEnvLayer } from "../src/jobs/apply-real.js";
import { inventoryFactsOf, planEnvLayer, type EnvLayerStore, type InventoryFacts } from "../src/env-layer.js";
import { ONE } from "./demo-one.js";

const ENV_ID = "33333333-3333-4333-8333-333333333333";
const MID = "4a8c0000-0000-4000-8000-0000000000a1";
const TENANT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "111122223333";
const REGION = "ap-northeast-2";
const now = new Date("2026-11-07T00:00:00Z");
const FACTS = { clusterName: "customer-eks", vpcId: "vpc-0aaa1111bbbb2222c",
  dbSubnetIdsJson: '["subnet-0a1a1a1a1a1a1a1a1","subnet-0c3c3c3c3c3c3c3c3"]', dbPublicSubnetIdsJson: '["subnet-0b2b2b2b2b2b2b2b2","subnet-0d4d4d4d4d4d4d4d4"]' };
const STORED = { ok: true, cluster: "customer-eks", region: REGION, facts: FACTS };

const plan = (env: NodeJS.ProcessEnv, inventory: InventoryFacts | null) => {
  const el = planEnvLayer("aws", null, env, ACCOUNT, REGION, inventory);
  return buildPlanDoc({ planId: "7f000000-0000-4000-8000-0000000000d3", migrationId: MID, spec: ONE, precheck: stubPrecheck(), now,
    target: { envId: ENV_ID, provider: "aws", region: "default" }, accountId: ACCOUNT,
    ...(el.envLayer ? { envLayer: el.envLayer } : {}), ...(el.dbFacts ? { envLayerFacts: el.dbFacts } : {}) }, env);
};
function memStore() {
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const nope = async () => { throw new Error("aws 는 환경 층 표를 쓰지 않는다"); };
  const store: EnvLayerStore = { get: nope, claim: nope, ready: nope, failed: nope,
    audit: async (_t, _m, action, _r, detail) => { audits.push({ action, detail }); } };
  return { audits, store };
}
const rootRunner = () => {
  const seen: Record<string, unknown>[] = [];
  return { seen, runner: { apply: async (_p: string, mid: string, vars: Record<string, unknown>): Promise<RealApplyResult> => {
    seen.push(vars);
    return { ok: true, tfOutputs: { link_outputs: "{}" }, workDir: `/w/${mid}`, steps: [], elapsedMs: 1, log: [], secretFetched: false };
  } } as never };
};
const apply = (p: ReturnType<typeof plan>, env: NodeJS.ProcessEnv, inventory: () => Promise<InventoryFacts>) => {
  const { audits, store } = memStore();
  const root = rootRunner();
  return realApplyWithEnvLayer({ migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "aws", accountId: ACCOUNT, spec: ONE, plan: p },
    { env, runner: root.runner, envLayer: { store, inventory } }).then((r) => ({ r, root, audits }));
};

test("읽어 둔 사실: 지금 환경의 클러스터·도착 지역과 같은 읽기일 때만 쓴다", () => {
  assert.deepEqual(inventoryFactsOf(STORED, "customer-eks", REGION), { ok: true, facts: FACTS });
  const no = (x: InventoryFacts) => (x.ok ? "ok" : x.reason);
  assert.match(no(inventoryFactsOf(undefined, "customer-eks", REGION)), /아직 읽지 않았다/);
  assert.match(no(inventoryFactsOf({ ok: false, cluster: "customer-eks", region: REGION, reason: "사설 서브넷이 두 영역(AZ) 이상에 없다" }, "customer-eks", REGION)),
    /쓸 수 없다: 사설 서브넷이 두 영역/);
  assert.match(no(inventoryFactsOf(STORED, "other-eks", REGION)), /환경의 클러스터\(other-eks\)와 다르다/);
  assert.match(no(inventoryFactsOf({ ...STORED, region: "us-east-1" }, "customer-eks", REGION)), /us-east-1 은 아직 못 쓴다/);
  assert.match(no(inventoryFactsOf({ ...STORED, facts: { vpcId: 1 } }, "customer-eks", REGION)), /모양이 틀리다/);
});

test("TF_FACT_* 없이 계획: 계획서 targetFacts 에 도착 EKS 의 클러스터·VPC·서브넷이 실린다 (환경 층 칸은 없음)", () => {
  const p = plan({}, { ok: true, facts: FACTS });
  assert.equal(p.envLayer, undefined);
  assert.equal(p.targetFacts?.clusterName, "customer-eks");
  assert.equal(p.targetFacts?.vpcId, FACTS.vpcId);
  assert.equal(p.targetFacts?.dbSubnetIdsJson, FACTS.dbSubnetIdsJson);
  assert.equal(p.targetFacts?.accountId, ACCOUNT);
  assert.equal(plan({}, { ok: false, reason: "x" }).targetFacts?.vpcId, undefined, "못 쓰면 계획은 사실 없이 (apply 가 이유를 들고 멈춘다)");
});

test("TF_FACT_* 없이 apply: 실자원 사실로 aws/root 자리표시를 채운다", async () => {
  const p = plan({}, { ok: true, facts: FACTS });
  const { r, root } = await apply(p, {}, async () => ({ ok: true, facts: FACTS }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(root.seen[0]!.cluster_name, "customer-eks");
  assert.equal(root.seen[0]!.vpc_id, FACTS.vpcId);
  assert.equal(root.seen[0]!.db_subnet_ids_json, FACTS.dbSubnetIdsJson);
  assert.equal(root.seen[0]!.expected_account_id, ACCOUNT);
  assert.equal((r.detail.envLayer as { source: string }).source, "inventory");
});

test("거부: 실자원 사실을 못 쓰면 Terraform 을 부르지 않고 TARGET_FACTS_UNAVAILABLE + 이유 (감사에도)", async () => {
  const p = plan({}, null);
  const { r, root, audits } = await apply(p, {}, async () => ({ ok: false, reason: "도착 EKS 를 아직 읽지 않았다" }));
  assert.equal(r.ok, false);
  assert.equal((r as { failureCode: string }).failureCode, "TARGET_FACTS_UNAVAILABLE");
  assert.match(JSON.stringify(r.detail), /아직 읽지 않았다/);
  const d = (r.detail as { envLayer: { missing: string[]; hint: string } }).envLayer;
  assert.deepEqual(d.missing, ["inventory.targetFacts"]);
  assert.match(d.hint, /도착 환경 화면을 다시 열어/);
  assert.match(d.hint, /TF_FACT_VPC_ID/);
  assert.equal(root.seen.length, 0, "Terraform 안 부름");
  assert.deepEqual(audits.map((a) => a.action), ["env_layer.facts_unavailable"]);
});

test("거부: 승인 뒤 읽어 둔 VPC·서브넷이 바뀌면 TF_PLAN_DRIFT (계획서 targetFacts 와 대조)", async () => {
  const p = plan({}, { ok: true, facts: FACTS });
  const { r, root } = await apply(p, {}, async () => ({ ok: true, facts: { ...FACTS, vpcId: "vpc-0fff9999eeee8888d" } }));
  assert.equal((r as { failureCode: string }).failureCode, "TF_PLAN_DRIFT");
  assert.match(JSON.stringify(r.detail), /vpcId/);
  assert.equal(root.seen.length, 0);
});

test("TF_FACT_* 가 있으면 예전 길 그대로: 실자원 사실을 읽지도 않는다", async () => {
  const TF = { TF_FACT_VPC_ID: "vpc-env", TF_FACT_DB_SUBNET_IDS_JSON: '["subnet-a","subnet-b"]', TF_FACT_CLUSTER_NAME: "env-eks" };
  const p = plan(TF, { ok: true, facts: FACTS });
  assert.equal(p.targetFacts?.vpcId, "vpc-env");
  const { r, root } = await apply(p, TF, async () => { throw new Error("읽으면 안 된다"); });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(root.seen[0]!.vpc_id, "vpc-env");
});
