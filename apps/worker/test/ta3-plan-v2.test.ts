// TA3: PLAN_IR=v2 계획·적용·배포 연결 (DB 없이). 실행기는 가짜
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, AppSpecV2, PlanDoc, upconvertV1 } from "@svc/contracts";
import {
  adapterFor, AdapterError, DEMO_INVENTORY, flattenTfOutputsV2, resolveSpecV2, specV2ForPlan, stubTfOutputsV2, v2PrecheckItems,
  type RealApplyResult,
} from "@svc/adapters";
import { buildPlanDoc, planOnError } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { realApply } from "../src/jobs/apply-real.js";
import { approvedValues, fillPlaceholders, GitopsError, withServedBy, type DeployInput } from "../src/gitops/index.js";
import { planIrV2 } from "../src/jobs/plan-v2.js";

const ENV_ID = "33333333-3333-4333-8333-333333333333";
const MID = "4a8c0000-0000-4000-8000-0000000000d3";
const TENANT = "11111111-1111-4111-8111-111111111111";
const spec = AppSpec.parse(adapterFor("aws").normalize(DEMO_INVENTORY.aws).spec);
const v2 = upconvertV1(spec).spec;
const now = new Date("2026-11-07T00:00:00Z");
const base = { planId: "7f000000-0000-4000-8000-0000000000d3", migrationId: MID, spec, precheck: stubPrecheck(), now };
const tgt = (provider: "aws" | "gcp" | "onprem" | "azure_mock") => ({ envId: ENV_ID, provider, region: "default" });

test("깃발: PLAN_IR=v2 일 때만 켜짐 (기본 v1)", () => {
  assert.equal(planIrV2({}), false);
  assert.equal(planIrV2({ PLAN_IR: "v1" }), false);
  assert.equal(planIrV2({ PLAN_IR: "v2" }), true);
});

test("v1 계획서엔 새 키가 없고, v2 계획서엔 irVersion·specSource·instances 가 있으며 지문이 다르다", () => {
  for (const p of ["aws", "gcp", "onprem", "azure_mock"] as const) {
    const a = buildPlanDoc({ ...base, target: tgt(p) }, {});
    assert.equal("irVersion" in a || "specSource" in a || "instances" in a, false, p);
    const b = buildPlanDoc({ ...base, target: tgt(p), specV2: { spec: v2, source: "upconvert" } }, {});
    assert.equal(PlanDoc.safeParse(b).success, true, p);
    assert.equal(b.irVersion, "2");
    assert.equal(b.specSource, "upconvert");
    assert.ok(Array.isArray(b.instances) && b.instances.length > 0, p);
    assert.notEqual(a.planHash, b.planHash, p);
    assert.match(b.adapterVersion, /-target@/);
    // 같은 입력 = 같은 지문
    assert.equal(buildPlanDoc({ ...base, target: tgt(p), specV2: { spec: v2, source: "upconvert" } }, {}).planHash, b.planHash);
  }
});

test("거부: 도착이 못 그리는 명세(postgres 두 개)는 UNSUPPORTED_V2 → planOnError 가 바로 failed", async () => {
  const pg = v2.components.find((c) => c.kind === "postgres")!;
  const two = AppSpecV2.parse({ ...v2, components: [...v2.components, { ...pg, id: `${pg.id}-2` }] });
  let err: unknown;
  try { buildPlanDoc({ ...base, target: tgt("gcp"), specV2: { spec: two, source: "spec_v2" } }, {}); } catch (e) { err = e; }
  assert.ok(err instanceof AdapterError);
  assert.deepEqual(await planOnError(err), { to: "failed", failureCode: "UNSUPPORTED_V2", detail: { error: (err as Error).message } });
  assert.equal((await planOnError(new AdapterError("NEEDS_HUMAN", "x")))?.failureCode, "NEEDS_HUMAN");
  assert.equal(await planOnError(new AdapterError("OTHER", "x")), null);
  // precheck 대조도 같은 칸을 block 으로
  assert.ok(v2PrecheckItems("gcp", { spec, specV2: two, hadV2Before: false }).some((i) => i.id.startsWith("PC-V2-UNSUP-")));
});

test("resolveSpecV2: spec_v2 → spec_v2 / 없음 → upconvert / 앞 판엔 있었는데 없음 → NEEDS_HUMAN", () => {
  const a = resolveSpecV2({ spec, specV2: v2, hadV2Before: false });
  assert.equal(a.ok && a.source, "spec_v2");
  const b = resolveSpecV2({ spec, specV2: null, hadV2Before: false });
  assert.equal(b.ok && b.source, "upconvert");
  const c = resolveSpecV2({ spec, specV2: null, hadV2Before: true });
  assert.equal(!c.ok && c.code, "NEEDS_HUMAN");
  const d = resolveSpecV2({ spec, specV2: { schemaVersion: "2" }, hadV2Before: false });
  assert.equal(d.ok, false);
  // 계획서 출처와 지금 판 출처가 다르면 null (몰래 바꿔 타지 않음)
  assert.equal(specV2ForPlan({ spec, specV2: null, hadV2Before: false }, "spec_v2"), null);
  assert.ok(specV2ForPlan({ spec, specV2: v2, hadV2Before: false }, "spec_v2"));
});

test("precheck v2 대조: 출처 info 한 줄, 사람 확인 판은 block", () => {
  const ok = v2PrecheckItems("gcp", { spec, specV2: null, hadV2Before: false });
  assert.equal(ok[0]!.id, "PC-V2-SOURCE");
  assert.equal(ok.filter((i) => i.level === "block").length, 0);
  const bad = v2PrecheckItems("gcp", { spec, specV2: null, hadV2Before: true });
  assert.deepEqual(bad.map((i) => [i.id, i.level]), [["PC-V2-HUMAN", "block"]]);
});

test("terraform 맵 출력 펼치기 + 자리표시 키에 . - 허용 (예전 키도 그대로)", () => {
  const out = flattenTfOutputsV2({ db_address: "x", link_outputs: JSON.stringify({ "shop-db": { host: "h", port: 5432 } }),
    identity_gsa_emails: JSON.stringify({ api: "a@p.iam" }) });
  assert.equal(out["link.shop-db.host"], "h");
  assert.equal(out["link.shop-db.port"], "5432");
  assert.equal(out["identity.api.gsa_email"], "a@p.iam");
  assert.equal(out.db_address, "x");
  const r = fillPlaceholders({ a: "<tf-output:link.shop-db.host>:<tf-output:db_address>", b: "<tf-output:link.none.host>" }, { tf: out, env: {} });
  assert.deepEqual(r.values, { a: "h:x", b: "<tf-output:link.none.host>" });
  assert.deepEqual(r.missing, ["<tf-output:link.none.host>"]);
  // 흉내 출력은 결정적이고 postgres 마다 link.<id>.host
  const s = stubTfOutputsV2(v2);
  assert.deepEqual(s, stubTfOutputsV2(v2));
  assert.ok(Object.keys(s).some((k) => /^link\.[^.]+\.host$/.test(k)));
});

test("SERVED_BY: v2 값은 서비스 워크로드마다, v1 값은 예전처럼 최상위 env", () => {
  const b = { tenant: "t-1", app: "shop", env: "gcp-gke" as const };
  const v1 = withServedBy({ env: [{ name: "A", value: "1" }] }, b);
  assert.deepEqual((v1.env as { name: string }[]).map((e) => e.name), ["A", "SERVED_BY"]);
  const w = withServedBy({ workloads: [{ id: "api", kind: "service", env: [] }, { id: "n", kind: "job", env: [] }] }, b);
  const ws = w.workloads as { kind: string; env: { name: string }[] }[];
  assert.deepEqual(ws[0]!.env.map((e) => e.name), ["SERVED_BY"]);
  assert.deepEqual(ws[1]!.env, []);
  assert.equal("env" in w, false);
  assert.deepEqual(withServedBy(w, b), w);   // 두 번 넣지 않음
});

test("배포 값: v2 계획서면 v2 값으로 대조, v2 명세가 없으면 GITOPS_VALUES_DRIFT", () => {
  const t = { envId: ENV_ID, provider: "gcp" as const, region: "default", accountId: "demo-project" };
  const plan = buildPlanDoc({ ...base, target: tgt("gcp"), specV2: { spec: v2, source: "upconvert" } }, {});
  const i: DeployInput = { tenantId: TENANT, spec, plan, target: t, tfOutputs: {}, specV2: v2 };
  const v = approvedValues(i);
  assert.equal(v.irVersion, "2");
  assert.ok(Array.isArray(v.workloads));
  assert.throws(() => approvedValues({ ...i, specV2: null }), (e: unknown) => e instanceof GitopsError && e.code === "GITOPS_VALUES_DRIFT");
  const changed = upconvertV1({ ...spec, service: { ...spec.service, image: "registry/x@sha256:" + "9".repeat(64) } }).spec;
  assert.throws(() => approvedValues({ ...i, specV2: changed }), (e: unknown) => e instanceof GitopsError && e.code === "GITOPS_VALUES_DRIFT");
});

function fakeRunner() {
  const seen: { layout: unknown; vars: Record<string, unknown> }[] = [];
  return { seen, runner: { apply: async (_p: string, mid: string, vars: Record<string, unknown>, _s?: unknown, _t?: string, layout?: unknown): Promise<RealApplyResult> => {
    seen.push({ layout, vars });
    return { ok: true, tfOutputs: { db_address: "shop.rds.example", db_master_secret_arn: "arn:x",
      link_outputs: JSON.stringify({ [v2.components.find((c) => c.kind === "postgres")!.id]: { host: "shop.rds.example" } }) },
      workDir: `/w/${mid}`, steps: [], elapsedMs: 1, log: [], secretFetched: true };
  } } as never };
}
const FACTS = { TF_FACT_VPC_ID: "vpc-1", TF_FACT_DB_SUBNET_IDS_JSON: '["subnet-a","subnet-b"]', TF_FACT_CLUSTER_NAME: "finals-eks" };

test("적용 v2: 계획서 irVersion 으로 v2 루트를 부르고 맵 출력을 펼친다. v2 명세가 없으면 TF_PLAN_DRIFT (실행기 안 부름)", async () => {
  const plan = buildPlanDoc({ ...base, target: tgt("aws"), specV2: { spec: v2, source: "upconvert" } }, {});
  const input = { migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "aws" as const, accountId: "111122223333", spec, plan };
  const f = fakeRunner();
  const miss = await realApply({ ...input, specV2: null }, { env: FACTS, runner: f.runner });
  assert.equal(miss.ok, false);
  assert.equal((miss as { failureCode: string }).failureCode, "TF_PLAN_DRIFT");
  assert.equal(f.seen.length, 0);
  const r = await realApply({ ...input, specV2: v2 }, { env: FACTS, runner: f.runner });
  if (!r.ok) {
    // env 사실 이름이 v2 루트에서 다르면 무엇이 빠졌는지 보이게
    assert.fail(JSON.stringify(r));
  }
  assert.equal(f.seen[0]!.layout, "v2");
  const pg = v2.components.find((c) => c.kind === "postgres")!.id;
  assert.equal(r.tfOutputs[`link.${pg}.host`], "shop.rds.example");
});
