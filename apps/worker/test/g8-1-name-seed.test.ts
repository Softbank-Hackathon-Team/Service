// G8-1: 도착 자원 이름 seed 에 이전 번호를 넣는다. 계획·apply·배포가 같은 값을 넣어 지문이 맞는지 (DB 없이, 실행기는 가짜)
import { test } from "node:test";
import assert from "node:assert/strict";
import { type RealApplyResult } from "@svc/adapters";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { realApply } from "../src/jobs/apply-real.js";
import { approvedValues, type DeployInput } from "../src/gitops/index.js";
import { ONE } from "./demo-one.js";

const ENV_ID = "33333333-3333-4333-8333-333333333333";
const MID_A = "4a8c0000-0000-4000-8000-0000000000a1";
const MID_B = "4a8c0000-0000-4000-8000-0000000000b2";
const TENANT = "11111111-1111-4111-8111-111111111111";
const spec = ONE;
const now = new Date("2026-11-07T00:00:00Z");
const plan = (provider: "aws" | "gcp", migrationId: string) => buildPlanDoc({
  planId: "7f000000-0000-4000-8000-0000000000d3", migrationId, spec, precheck: stubPrecheck(), now,
  target: { envId: ENV_ID, provider, region: "default" },
}, {});

function fakeRunner() {
  const seen: Record<string, unknown>[] = [];
  return { seen, runner: { apply: async (_p: string, mid: string, vars: Record<string, unknown>): Promise<RealApplyResult> => {
    seen.push(vars);
    return { ok: true, tfOutputs: { link_outputs: "{}" }, workDir: `/w/${mid}`, steps: [], elapsedMs: 1, log: [], secretFetched: true };
  } } as never };
}
const FACTS = { TF_FACT_VPC_ID: "vpc-1", TF_FACT_DB_SUBNET_IDS_JSON: '["subnet-a","subnet-b"]', TF_FACT_CLUSTER_NAME: "finals-eks" };
const namesOf = (vars: Record<string, unknown>) => ({
  pg: (JSON.parse(String(vars.postgres_json)) as { name: string }[])[0]?.name,
  role: (JSON.parse(String(vars.identity_json)) as { name: string }[])[0]?.name,
});

test("같은 앱·같은 환경이라도 이전이 다르면 DB 이름·계획 지문이 다르다 (다시 옮겨도 AlreadyExists 안 남)", async () => {
  for (const p of ["aws", "gcp"] as const) {
    const a = plan(p, MID_A), b = plan(p, MID_B);
    assert.notEqual(a.tfPlanHash, b.tfPlanHash, p);
    assert.equal(plan(p, MID_A).tfPlanHash, a.tfPlanHash, `${p}: 같은 입력 = 같은 지문`);
  }
  // apply 가 실제로 넘기는 변수의 DB 이름이 이전마다 다르다
  const names: ReturnType<typeof namesOf>[] = [];
  for (const mid of [MID_A, MID_B]) {
    const f = fakeRunner();
    const r = await realApply({ migrationId: mid, tenantId: TENANT, envId: ENV_ID, provider: "aws", accountId: "111122223333",
      spec, plan: plan("aws", mid) }, { env: FACTS, runner: f.runner });
    assert.equal(r.ok, true, JSON.stringify(r));
    names.push(namesOf(f.seen[0]!));
  }
  assert.ok(names[0]!.pg && names[1]!.pg && names[0]!.role, JSON.stringify(names));
  assert.notEqual(names[0]!.pg, names[1]!.pg, "DB 이름");
  assert.notEqual(names[0]!.role, names[1]!.role, "IAM 역할 이름");
});

test("허브 신원: gcp 만 회사 SA 를 hub_principal 로 넘기고, 계획 지문은 그대로", async () => {
  const GCP = { TF_FACT_NETWORK_ID: "net-1", TF_FACT_CLUSTER_NAME: "finals-gke", TF_FACT_CLUSTER_LOCATION: "asia-northeast3-a" };
  const SA = "t-0123456789abcdef0123456789ab";
  const go = async (provider: "aws" | "gcp", env: Record<string, string>, sa: string | undefined) => {
    const f = fakeRunner();
    const r = await realApply({ migrationId: MID_A, tenantId: TENANT, envId: ENV_ID, provider, accountId: provider === "gcp" ? "demo-project" : "111122223333",
      spec, plan: plan(provider, MID_A) }, { env, runner: f.runner, gcpPlatformSa: async () => sa });
    assert.equal(r.ok, true, JSON.stringify(r));
    return f.seen[0]!.hub_principal;
  };
  assert.equal(await go("gcp", { ...GCP, GCP_PLATFORM_PROJECT: "platform-proj" }, SA), `${SA}@platform-proj.iam.gserviceaccount.com`);
  assert.equal(await go("gcp", GCP, SA), undefined, "플랫폼 프로젝트 설정이 없으면 안 넘긴다");
  assert.equal(await go("gcp", { ...GCP, GCP_PLATFORM_PROJECT: "platform-proj" }, undefined), undefined, "회사 SA 가 없으면 안 넘긴다");
  assert.equal(await go("aws", { ...FACTS, GCP_PLATFORM_PROJECT: "platform-proj" }, SA), undefined, "aws 는 해당 없음");
});

test("거부: 다른 이전의 계획서로 apply 하면 TF_PLAN_DRIFT, 배포 값도 이전 번호가 다르면 승인 지문과 다름", async () => {
  const f = fakeRunner();
  const r = await realApply({ migrationId: MID_B, tenantId: TENANT, envId: ENV_ID, provider: "aws", accountId: "111122223333",
    spec, plan: plan("aws", MID_A) }, { env: FACTS, runner: f.runner });
  assert.equal(r.ok, false);
  assert.equal((r as { failureCode: string }).failureCode, "TF_PLAN_DRIFT");
  assert.equal(f.seen.length, 0);
  // 배포: 계획서 migrationId 로 다시 만들면 지문이 맞는다 (계획 때와 같은 seed)
  const p = plan("gcp", MID_A);
  const i: DeployInput = { tenantId: TENANT, spec, plan: p, target: { envId: ENV_ID, provider: "gcp", region: "default", accountId: "demo-project" }, tfOutputs: {} };
  assert.doesNotThrow(() => approvedValues(i));
});
