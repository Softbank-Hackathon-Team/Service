// VTA3: TA3(PLAN_IR=v2 계획·적용·배포 연결) 빠진 경계·거부 시험. DB·실행기 없음 (가짜 runner)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, AppSpecV2, PlanDoc, upconvertV1 } from "@svc/contracts";
import {
  adapterFor, DEMO_INVENTORY, DbNetworkError, flattenTfOutputsV2, specV2ForPlan, v2PrecheckItems, type RealApplyResult,
} from "@svc/adapters";
import { buildPlanDoc, planOnError } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { realApply } from "../src/jobs/apply-real.js";
import { approvedValues, type DeployInput } from "../src/gitops/index.js";

const ENV_ID = "33333333-3333-4333-8333-333333333333";
const MID = "4a8c0000-0000-4000-8000-0000000000e3";
const TENANT = "11111111-1111-4111-8111-111111111111";
const spec = AppSpec.parse(adapterFor("aws").normalize(DEMO_INVENTORY.aws).spec);
const v2 = upconvertV1(spec).spec;
const now = new Date("2026-11-07T00:00:00Z");
const base = { planId: "7f000000-0000-4000-8000-0000000000e3", migrationId: MID, spec, precheck: stubPrecheck(), now };
const tgt = (provider: "aws" | "gcp" | "onprem" | "azure_mock") => ({ envId: ENV_ID, provider, region: "default" });
const pgId = v2.components.find((c) => c.kind === "postgres")!.id;
const withPg = (s: AppSpecV2, props: Record<string, unknown>) => AppSpecV2.parse({ ...s,
  components: s.components.map((c) => (c.kind === "postgres" ? { ...c, props: { ...c.props, ...props } } : c)) });

test("거부: 출발 방화벽을 못 읽은 컴포넌트(ingress unknown)는 사전 점검에서 사람 확인 block", () => {
  const unk = AppSpecV2.parse({ ...v2, posture: { ...v2.posture,
    network: [{ scope: "component", subject: pgId, mode: "mirror", ingress: "unknown", public: null }] } });
  const items = v2PrecheckItems("gcp", { spec, specV2: unk, hadV2Before: false });
  const human = items.filter((i) => i.id.startsWith("PC-V2-HUMAN-"));
  assert.equal(human.length, 1);
  assert.equal(human[0]!.level, "block");
  assert.match(human[0]!.message, new RegExp(pgId));
});

test("거부: v2 판의 spec_v2 모양이 틀리면 사전 점검 block 한 줄 (출처 줄 없음)", () => {
  const items = v2PrecheckItems("aws", { spec, specV2: { schemaVersion: "2", components: "x" }, hadV2Before: false });
  assert.deepEqual(items.map((i) => [i.id, i.level]), [["PC-V2-HUMAN", "block"]]);
});

test("출처 바뀜: upconvert 로 승인했는데 다시 가져와 spec_v2 가 생기면 null(drift), 출처를 안 적은 계획서는 아무 출처나", () => {
  assert.equal(specV2ForPlan({ spec, specV2: v2, hadV2Before: false }, "upconvert"), null);
  assert.ok(specV2ForPlan({ spec, specV2: null, hadV2Before: false }, "upconvert"));
  assert.ok(specV2ForPlan({ spec, specV2: v2, hadV2Before: false }, undefined));
  assert.equal(specV2ForPlan({ spec, specV2: null, hadV2Before: true }, undefined), null);
});

test("v2 계획 지문: DB_PUBLIC 데모 변수가 aws 는 지문에 들어가고 onprem 은 그대로, 틀린 허용 목록은 바로 failed", async () => {
  const on = { DB_PUBLIC: "1", DB_PEER_CIDRS: "203.0.113.7/32", DB_DISPOSABLE: "1" };
  const p = (provider: "aws" | "onprem", env: NodeJS.ProcessEnv) =>
    buildPlanDoc({ ...base, target: tgt(provider), specV2: { spec: v2, source: "upconvert" } }, env);
  assert.notEqual(p("aws", on).tfPlanHash, p("aws", {}).tfPlanHash);
  assert.equal(p("onprem", on).tfPlanHash, p("onprem", {}).tfPlanHash);
  let err: unknown;
  try { p("aws", { DB_PUBLIC: "1", DB_PEER_CIDRS: "0.0.0.0/0" }); } catch (e) { err = e; }
  assert.ok(err instanceof DbNetworkError);
  assert.equal((await planOnError(err))?.failureCode, "DB_NETWORK_INVALID");
});

test("계약: 옛 v1 계획서(새 칸 없음)는 통과, 모르는 irVersion·specSource 는 거부", () => {
  const a = buildPlanDoc({ ...base, target: tgt("gcp") }, {});
  assert.equal(PlanDoc.safeParse(a).success, true);
  const b = buildPlanDoc({ ...base, target: tgt("gcp"), specV2: { spec: v2, source: "spec_v2" } }, {});
  assert.equal(PlanDoc.safeParse({ ...b, irVersion: "3" }).success, false);
  assert.equal(PlanDoc.safeParse({ ...b, specSource: "guess" }).success, false);
});

test("출력 펼치기 경계: 틀린 JSON 은 무시, 이미 있는 펼친 키는 안 덮음, null 값은 건너뜀, aws 역할 ARN", () => {
  assert.deepEqual(flattenTfOutputsV2({ link_outputs: "{not json", db_address: "x" }), { link_outputs: "{not json", db_address: "x" });
  const out = flattenTfOutputsV2({
    "link.db.host": "given", link_outputs: JSON.stringify({ db: { host: "from-map", port: null }, arr: ["x"] }),
    identity_role_arns: JSON.stringify({ api: "arn:aws:iam::1:role/app-api" }), identity_gsa_emails: "[]" });
  assert.equal(out["link.db.host"], "given");
  assert.equal(out["link.db.port"], undefined);
  assert.equal(out["identity.api.role_arn"], "arn:aws:iam::1:role/app-api");
  assert.equal(Object.keys(out).some((k) => k.startsWith("identity.") && k.endsWith("gsa_email")), false);
});

function fakeRunner() {
  let calls = 0;
  return { calls: () => calls, runner: { apply: async (_p: string, mid: string): Promise<RealApplyResult> => {
    calls++;
    return { ok: true, tfOutputs: { db_address: "a", db_master_secret_arn: "arn:x", link_outputs: "{}" },
      workDir: `/w/${mid}`, steps: [], elapsedMs: 1, log: [], secretFetched: true };
  } } as never };
}
const FACTS = { TF_FACT_VPC_ID: "vpc-1", TF_FACT_DB_SUBNET_IDS_JSON: '["subnet-a","subnet-b"]', TF_FACT_CLUSTER_NAME: "finals-eks" };

test("적용 drift: 승인 뒤 v2 명세 내용이 바뀌면(postgres 용량) TF_PLAN_DRIFT, 실행기 안 부름", async () => {
  const plan = buildPlanDoc({ ...base, target: tgt("aws"), specV2: { spec: v2, source: "spec_v2" } }, {});
  const input = { migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "aws" as const, accountId: "111122223333", spec, plan };
  const f = fakeRunner();
  const cur = (v2.components.find((c) => c.kind === "postgres")!.props as { storageGb: number }).storageGb;
  const r = await realApply({ ...input, specV2: withPg(v2, { storageGb: cur + 10 }) }, { env: FACTS, runner: f.runner });
  assert.equal(r.ok, false);
  assert.equal((r as { failureCode: string }).failureCode, "TF_PLAN_DRIFT");
  assert.equal(f.calls(), 0);
  const ok = await realApply({ ...input, specV2: v2 }, { env: FACTS, runner: f.runner });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(f.calls(), 1);
});

test("적용·배포 길은 계획서로 고른다: v1 계획서면 v2 명세가 없어도(null) v1 길 그대로", async () => {
  const plan = buildPlanDoc({ ...base, target: tgt("aws") }, {});
  const f = fakeRunner();
  const r = await realApply({ migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "aws", accountId: "111122223333",
    spec, plan, specV2: null }, { env: FACTS, runner: f.runner });
  assert.equal(r.ok, true, JSON.stringify(r));
  const gp = buildPlanDoc({ ...base, target: tgt("gcp") }, {});
  const i: DeployInput = { tenantId: TENANT, spec, plan: gp, target: { ...tgt("gcp"), accountId: "demo-project" }, tfOutputs: {}, specV2: null };
  assert.equal(approvedValues(i).irVersion, undefined);
});
