// TA3: 명세(IR) → 계획·적용·배포 연결 (DB 없이). 실행기는 가짜
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, PlanDoc } from "@svc/contracts";
import {
  AdapterError, flattenTfOutputsV2, resolveSpecV2, specV2ForPlan, stubTfOutputsV2, v2PrecheckItems,
  type RealApplyResult,
} from "@svc/adapters";
import { buildPlanDoc, planOnError } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { realApply } from "../src/jobs/apply-real.js";
import { approvedValues, fillPlaceholders, GitopsError, withServedBy, type DeployInput } from "../src/gitops/index.js";
import { ONE } from "./demo-one.js";

const ENV_ID = "33333333-3333-4333-8333-333333333333";
const MID = "4a8c0000-0000-4000-8000-0000000000d3";
const TENANT = "11111111-1111-4111-8111-111111111111";
const v2 = ONE;
const now = new Date("2026-11-07T00:00:00Z");
const base = { planId: "7f000000-0000-4000-8000-0000000000d3", migrationId: MID, spec: v2, precheck: stubPrecheck(), now };
const tgt = (provider: "aws" | "gcp" | "onprem" | "azure_mock") => ({ envId: ENV_ID, provider, region: "default" });

test("계획서: 네 도착 모두 instances 가 있고 PlanDoc 을 통과, 같은 입력 = 같은 지문, 명세가 바뀌면 지문도 바뀜", () => {
  for (const p of ["aws", "gcp", "onprem", "azure_mock"] as const) {
    const b = buildPlanDoc({ ...base, target: tgt(p) }, {});
    assert.equal(PlanDoc.safeParse(b).success, true, p);
    assert.equal("irVersion" in b || "specSource" in b, false, "예전 구분 칸 없음");
    assert.ok(Array.isArray(b.instances) && b.instances.length > 0, p);
    assert.match(b.adapterVersion, /-target@/);
    assert.equal(buildPlanDoc({ ...base, target: tgt(p) }, {}).planHash, b.planHash);
    const more = structuredClone(v2);
    (more.components.find((c) => c.id === "shop-api") as { props: { replicas: unknown } }).props.replicas = { min: 3, max: 6 };
    assert.notEqual(buildPlanDoc({ ...base, spec: more, target: tgt(p) }, {}).planHash, b.planHash, p);
  }
});

test("거부: 도착이 못 그리는 명세(postgres 두 개)는 UNSUPPORTED_V2 → planOnError 가 바로 failed", async () => {
  const pg = v2.components.find((c) => c.kind === "postgres")!;
  const two = AppSpecV2.parse({ ...v2, components: [...v2.components, { ...pg, id: `${pg.id}-2` }] });
  let err: unknown;
  try { buildPlanDoc({ ...base, spec: two, target: tgt("azure_mock") }, {}); } catch (e) { err = e; }
  assert.ok(err instanceof AdapterError);
  assert.deepEqual(await planOnError(err), { to: "failed", failureCode: "UNSUPPORTED_V2", detail: { error: (err as Error).message } });
  assert.equal((await planOnError(new AdapterError("NEEDS_HUMAN", "x")))?.failureCode, "NEEDS_HUMAN");
  assert.equal(await planOnError(new AdapterError("OTHER", "x")), null);
  // precheck 대조도 같은 칸을 block 으로
  assert.ok(v2PrecheckItems("azure_mock", { specV2: two }).some((i) => i.id.startsWith("PC-V2-UNSUP-")));
});

test("resolveSpecV2: 명세 있음 → ok / 없음(예전 형식 판)·모양 틀림 → NEEDS_HUMAN, specV2ForPlan 은 null", () => {
  const a = resolveSpecV2({ specV2: v2 });
  assert.equal(a.ok, true);
  const b = resolveSpecV2({ specV2: null });
  assert.equal(!b.ok && b.code, "NEEDS_HUMAN");
  const d = resolveSpecV2({ specV2: { schemaVersion: "2" } });
  assert.equal(d.ok, false);
  assert.equal(specV2ForPlan({ specV2: null }), null);
  assert.ok(specV2ForPlan({ specV2: v2 }));
});

test("precheck 대조: 명세 있으면 PC-V2-SOURCE info 한 줄로 시작, 없으면 PC-V2-HUMAN block 하나", () => {
  const ok = v2PrecheckItems("gcp", { specV2: v2 });
  assert.equal(ok[0]!.id, "PC-V2-SOURCE");
  assert.equal(ok.filter((i) => i.id.startsWith("PC-V2-UNSUP-")).length, 0, "gcp 는 이 명세를 그릴 수 있음");
  const bad = v2PrecheckItems("gcp", { specV2: null });
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

test("SERVED_BY: 서비스 워크로드마다 넣고, 최상위 env 만 있는 값은 예전처럼 최상위 env", () => {
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

test("배포 값: 계획서 지문으로 대조, 명세가 없거나 바뀌면 GITOPS_VALUES_DRIFT", () => {
  const t = { envId: ENV_ID, provider: "gcp" as const, region: "default", accountId: "demo-project" };
  const plan = buildPlanDoc({ ...base, target: tgt("gcp") }, {});
  const i: DeployInput = { tenantId: TENANT, spec: v2, plan, target: t, tfOutputs: {} };
  const v = approvedValues(i);
  assert.ok(Array.isArray(v.workloads));
  assert.throws(() => approvedValues({ ...i, spec: null }), (e: unknown) => e instanceof GitopsError && e.code === "GITOPS_VALUES_DRIFT");
  const changed = structuredClone(v2);
  (changed.components.find((c) => c.id === "shop-api") as { props: { image: { digest: string } } }).props.image.digest = "sha256:" + "9".repeat(64);
  assert.throws(() => approvedValues({ ...i, spec: changed }), (e: unknown) => e instanceof GitopsError && e.code === "GITOPS_VALUES_DRIFT");
});

function fakeRunner() {
  const seen: { layout: unknown; vars: Record<string, unknown> }[] = [];
  return { seen, runner: { apply: async (_p: string, mid: string, vars: Record<string, unknown>, _s?: unknown, _t?: string): Promise<RealApplyResult> => {
    seen.push({ layout: undefined, vars });
    return { ok: true, tfOutputs: { db_address: "shop.rds.example", db_master_secret_arn: "arn:x",
      link_outputs: JSON.stringify({ [v2.components.find((c) => c.kind === "postgres")!.id]: { host: "shop.rds.example" } }) },
      workDir: `/w/${mid}`, steps: [], elapsedMs: 1, log: [], secretFetched: true };
  } } as never };
}
const FACTS = { TF_FACT_VPC_ID: "vpc-1", TF_FACT_DB_SUBNET_IDS_JSON: '["subnet-a","subnet-b"]', TF_FACT_CLUSTER_NAME: "finals-eks" };

test("적용: 고정 루트를 부르고 맵 출력을 펼친다. 명세가 없으면 TF_PLAN_DRIFT (실행기 안 부름)", async () => {
  const plan = buildPlanDoc({ ...base, target: tgt("aws") }, {});
  const input = { migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "aws" as const, accountId: "111122223333", plan };
  const f = fakeRunner();
  const miss = await realApply({ ...input, spec: null as never }, { env: FACTS, runner: f.runner }).catch((e: unknown) => ({ ok: false, failureCode: (e as { code?: string }).code ?? String(e) }));
  assert.equal(miss.ok, false);
  assert.equal(f.seen.length, 0);
  const r = await realApply({ ...input, spec: v2 }, { env: FACTS, runner: f.runner });
  if (!r.ok) assert.fail(JSON.stringify(r));
  const pg = v2.components.find((c) => c.kind === "postgres")!.id;
  assert.equal(r.tfOutputs[`link.${pg}.host`], "shop.rds.example");
});
