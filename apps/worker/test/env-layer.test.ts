// 환경 층 (도착 GCP 의 VPC·GKE·AR·ESO): 사실 고르는 순서, 만들기·멈춤, 계획 지문 대조 (DB·클라우드 없이, 실행기·저장소·gcloud 는 가짜)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENV_LAYER_MODULE_DIGEST, envLayerVars, envLayerVarsHash, type EnvLayerFacts, type EnvLayerResult, type EnvLayerRunnerOpts, type Exec, type RealApplyResult } from "@svc/adapters";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { realApply, realApplyWithEnvLayer } from "../src/jobs/apply-real.js";
import { factsDrift } from "../src/jobs/plan-facts.js";
import { chooseEnvLayerSource, ensureEnvLayer, planEnvLayer, type EnvLayerRow, type EnvLayerStore } from "../src/env-layer.js";
import { ONE } from "./demo-one.js";

const ENV_ID = "33333333-3333-4333-8333-333333333333";
const MID = "4a8c0000-0000-4000-8000-0000000000a1";
const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "mig-target-proj";
const REGION = "asia-northeast3";
const now = new Date("2026-11-07T00:00:00Z");
const FACTS: EnvLayerFacts = { network_id: "projects/mig-target-proj/global/networks/platform-target", cluster_name: "platform-target",
  cluster_location: "asia-northeast3-a", nat_egress_ips: ["34.64.1.2"], registry_host: "asia-northeast3-docker.pkg.dev/mig-target-proj/platform", secret_store_name: "gcp-secret-manager" };
const VARS_HASH = envLayerVarsHash(envLayerVars({ projectId: PROJECT, region: REGION }));
const TF_GCP = { TF_FACT_NETWORK_ID: "net-env", TF_FACT_CLUSTER_NAME: "gke-env", TF_FACT_CLUSTER_LOCATION: "asia-northeast3-b" };
const READY: EnvLayerRow = { status: "ready", facts: FACTS, varsHash: VARS_HASH, moduleDigest: ENV_LAYER_MODULE_DIGEST };

const plan = (env: NodeJS.ProcessEnv, row: EnvLayerRow | null) => {
  const el = planEnvLayer("gcp", row, env, PROJECT, REGION);
  return buildPlanDoc({ planId: "7f000000-0000-4000-8000-0000000000d3", migrationId: MID, spec: ONE, precheck: stubPrecheck(), now,
    target: { envId: ENV_ID, provider: "gcp", region: "default" }, accountId: PROJECT,
    ...(el.envLayer ? { envLayer: el.envLayer } : {}), ...(el.dbFacts ? { envLayerFacts: el.dbFacts } : {}) }, env);
};

function memStore(row: EnvLayerRow | null) {
  const s = { row, audits: [] as { action: string; detail: Record<string, unknown> }[], claims: 0, readyCalls: 0 };
  const store: EnvLayerStore = {
    get: async () => s.row,
    claim: async (_t, _e, varsHash, moduleDigest) => {
      s.claims++;
      if (s.row && s.row.status !== "failed") return false;
      s.row = { status: "creating", facts: s.row?.facts ?? null, varsHash, moduleDigest }; return true;
    },
    ready: async (_t, _e, facts, varsHash, moduleDigest) => { s.readyCalls++; s.row = { status: "ready", facts, varsHash, moduleDigest }; },
    failed: async () => { s.row = { ...s.row!, status: "failed" }; },
    audit: async (_t, _m, action, _r, detail) => { s.audits.push({ action, detail }); },
  };
  return { s, store };
}
const rootRunner = () => {
  const seen: Record<string, unknown>[] = [];
  return { seen, runner: { apply: async (_p: string, mid: string, vars: Record<string, unknown>): Promise<RealApplyResult> => {
    seen.push(vars);
    return { ok: true, tfOutputs: { link_outputs: "{}" }, workDir: `/w/${mid}`, steps: [], elapsedMs: 1, log: [], secretFetched: false };
  } } as never };
};
/** 가짜 환경 층 실행기: 단계마다 env() 를 불러 토큰을 기록한다 (진짜 실행기와 같은 약속) */
const envRunner = (o: { fail?: boolean; order: string[]; tokens: (string | undefined)[]; envs: NodeJS.ProcessEnv[] }) => (opts: EnvLayerRunnerOpts) => ({
  apply: async (_tenant: string, _env: string, vars: ReturnType<typeof envLayerVars>): Promise<EnvLayerResult> => {
    for (const phase of ["cluster", "eso"] as const) {
      const e = opts.env(); o.envs.push(e); o.tokens.push(e.CLOUDSDK_AUTH_ACCESS_TOKEN);
      o.order.push(`${phase}:create_eso=${phase === "eso"}:${vars.project_id}`);
      if (o.fail && phase === "eso") return { ok: false, workDir: "/w/env", steps: [], log: ["helm 실패"], elapsedMs: 1, failedPhase: "eso", failedStep: "apply" };
    }
    return { ok: true, workDir: "/w/env", steps: [], log: [], elapsedMs: 1, facts: FACTS };
  },
});
const gcloud = (names: string[] | "error"): Exec => async () =>
  names === "error" ? { code: 1, stdout: "", stderr: "ERROR: PERMISSION_DENIED", ms: 1 } : { code: 0, stdout: JSON.stringify(names.map((name) => ({ name }))), stderr: "", ms: 1 };
let token = "tok-1";
const CRED = { metadataHost: "127.0.0.1:9", token: () => token, projectId: PROJECT };
const AUTO = { ENV_LAYER_AUTO: "1", PATH: "/bin", GOOGLE_APPLICATION_CREDENTIALS: "/var/run/worker-sa.json", CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/var/run/gcp-cred/worker.json" };

test("사실 고르는 순서: DB ready > TF_FACT_* > (gcp + ENV_LAYER_AUTO=1) 만들기 > 없음", () => {
  assert.equal(chooseEnvLayerSource("gcp", READY, { ...TF_GCP, ENV_LAYER_AUTO: "1" }), "db");
  assert.equal(chooseEnvLayerSource("gcp", { ...READY, status: "failed" }, TF_GCP), "env");
  assert.equal(chooseEnvLayerSource("gcp", null, { ENV_LAYER_AUTO: "1" }), "create");
  assert.equal(chooseEnvLayerSource("gcp", null, {}), "none");
  assert.equal(chooseEnvLayerSource("aws", null, { ENV_LAYER_AUTO: "1" }), "none", "gcp 만 만든다");
  assert.equal(chooseEnvLayerSource("aws", null, { TF_FACT_CLUSTER_NAME: "" }), "env", "클러스터 없이(\"\") 뜻은 그대로");
});

test("DB 사실 ready → env apply 안 함, 앱 층이 DB 값을 쓴다 (워커 TF_FACT_* 보다 먼저)", async () => {
  const { s, store } = memStore(READY);
  const p = plan(TF_GCP, READY);
  assert.equal(p.envLayer?.mode, "existing");
  assert.equal(p.targetFacts?.clusterName, "platform-target");
  const o = { order: [] as string[], tokens: [], envs: [] };
  const root = rootRunner();
  const r = await realApplyWithEnvLayer({ migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "gcp", accountId: PROJECT, spec: ONE, plan: p },
    { env: TF_GCP, runner: root.runner, gcpCred: CRED, envLayer: { store, runner: envRunner(o) } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(o.order, [], "환경 층 apply 없음");
  assert.equal(s.claims, 0);
  assert.equal(root.seen[0]!.cluster_name, "platform-target");
  assert.equal(root.seen[0]!.cluster_location, "asia-northeast3-a");
  assert.equal(root.seen[0]!.network_id, FACTS.network_id);
  assert.equal((r as { tfOutputs: Record<string, string> }).tfOutputs.cluster_name, "platform-target");
});

test("TF_FACT_* 만 있음 → 지금과 같다 (계획 칸·지문 그대로, 환경 층 저장소도 안 건드림)", async () => {
  const before = buildPlanDoc({ planId: "7f000000-0000-4000-8000-0000000000d3", migrationId: MID, spec: ONE, precheck: stubPrecheck(), now,
    target: { envId: ENV_ID, provider: "gcp", region: "default" }, accountId: PROJECT }, TF_GCP);
  const p = plan(TF_GCP, null);
  assert.equal(p.envLayer, undefined);
  assert.equal(p.planHash, before.planHash, "예전 지문");
  const { s, store } = memStore(null);
  const root = rootRunner();
  const r = await realApplyWithEnvLayer({ migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "gcp", accountId: PROJECT, spec: ONE, plan: p },
    { env: { ...TF_GCP, ENV_LAYER_AUTO: "1" }, runner: root.runner, envLayer: { store } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(root.seen[0]!.cluster_name, "gke-env");
  assert.equal(s.claims + s.audits.length, 0);
});

test("둘 다 없음 + ENV_LAYER_AUTO=1 → 1차(클러스터)·2차(ESO) 순서, 단계마다 최신 빌린 토큰, 사실 저장, 이어서 앱 층", async () => {
  const { s, store } = memStore(null);
  const p = plan(AUTO, null);
  assert.equal(p.envLayer?.mode, "create");
  assert.equal(p.envLayer?.varsHash, VARS_HASH);
  assert.match(p.envLayer?.notice ?? "", /GKE.*비용/);
  assert.ok(p.acknowledgements?.some((a) => a.kind === "env_layer_create"), "승인 확인 항목");
  const o = { order: [] as string[], tokens: [] as (string | undefined)[], envs: [] as NodeJS.ProcessEnv[] };
  const root = rootRunner();
  token = "tok-1";
  const listed: NodeJS.ProcessEnv[] = [];
  const exec: Exec = async (cmd, args, x) => { listed.push(x.env); return gcloud([])(cmd, args, x); };
  const r = await realApplyWithEnvLayer({ migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "gcp", accountId: PROJECT, spec: ONE, plan: p },
    { env: AUTO, runner: root.runner, gcpCred: CRED, envLayer: { store, exec, runner: envRunner(o) } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(o.order, [`cluster:create_eso=false:${PROJECT}`, `eso:create_eso=true:${PROJECT}`]);
  assert.equal(s.row?.status, "ready");
  assert.deepEqual(s.row?.facts, FACTS);
  assert.equal(s.row?.varsHash, VARS_HASH);
  assert.equal(root.seen.length, 1, "앱 층 apply 가 이어서 돈다");
  assert.equal(root.seen[0]!.cluster_name, "platform-target");
  assert.deepEqual(s.audits.map((a) => a.action), ["env_layer.creating", "env_layer.ready"]);
  // 자식 환경: 빌린 토큰만, 워커 자기 자격(svc-worker 키 파일)은 없다
  for (const e of [...o.envs, ...listed]) {
    assert.equal(e.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(e.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, undefined);
    assert.equal(e.GCE_METADATA_HOST, "127.0.0.1:9");
    assert.equal(e.CLOUDSDK_CORE_PROJECT, PROJECT);
  }
  assert.deepEqual(o.tokens, ["tok-1", "tok-1"]);
  // 감사·결과에 토큰이 안 남는다
  assert.ok(!JSON.stringify({ r, a: s.audits }).includes("tok-"), "토큰이 결과·감사에 없다");
});

test("단계마다 env() 를 다시 불러 재발급된 토큰으로 시작한다", async () => {
  const { store } = memStore(null);
  const o = { order: [] as string[], tokens: [] as (string | undefined)[], envs: [] as NodeJS.ProcessEnv[] };
  let n = 0;
  const cred = { metadataHost: "127.0.0.1:9", token: () => `tok-${++n}`, projectId: PROJECT };
  const r = await ensureEnvLayer({ tenantId: TENANT, migrationId: MID, envId: ENV_ID, provider: "gcp", projectId: PROJECT, region: REGION, plan: plan(AUTO, null) },
    { env: AUTO, store, gcpCred: cred, exec: gcloud([]), runner: envRunner(o) });
  assert.equal(r.ok, true);
  assert.equal(new Set(o.tokens).size, 2, `1차·2차가 서로 다른(최신) 토큰: ${o.tokens.join(",")}`);
});

test("둘 다 없음 + ENV_LAYER_AUTO 꺼짐 → 지금과 같은 TF_FACTS_MISSING (환경 층 안 건드림)", async () => {
  const { s, store } = memStore(null);
  const p = plan({}, null);
  assert.equal(p.envLayer, undefined);
  const r = await realApplyWithEnvLayer({ migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "gcp", accountId: PROJECT, spec: ONE, plan: p },
    { env: {}, runner: rootRunner().runner, envLayer: { store } });
  const old = await realApply({ migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "gcp", accountId: PROJECT, spec: ONE, plan: p },
    { env: {}, runner: rootRunner().runner });
  assert.equal(r.ok, false);
  assert.equal((r as { failureCode: string }).failureCode, "TF_FACTS_MISSING");
  assert.deepEqual(r, old, "예전 결과와 똑같다");
  assert.equal(s.claims + s.audits.length, 0);
});

test("도착 프로젝트에 클러스터는 있는데 DB 사실 없음 → NEEDS_HUMAN, 만들지 않음. 목록을 못 읽어도 만들지 않음", async () => {
  for (const names of [["customer-gke"], "error"] as const) {
    const { s, store } = memStore(null);
    const o = { order: [] as string[], tokens: [], envs: [] };
    const root = rootRunner();
    const r = await realApplyWithEnvLayer({ migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "gcp", accountId: PROJECT, spec: ONE, plan: plan(AUTO, null) },
      { env: AUTO, runner: root.runner, gcpCred: CRED, envLayer: { store, exec: gcloud(names as never), runner: envRunner(o) } });
    assert.equal(r.ok, false);
    assert.equal((r as { failureCode: string }).failureCode, "NEEDS_HUMAN");
    assert.deepEqual(o.order, []);
    assert.equal(s.claims, 0);
    assert.equal(s.row, null);
    assert.equal(root.seen.length, 0, "앱 층도 안 돈다");
    assert.equal(s.audits[0]?.action, "env_layer.needs_human");
  }
});

test("env apply 실패 → status=failed, 이전 멈춤(ENV_LAYER_APPLY_FAILED), 자동 삭제 없음, 앱 층 안 돎. 다시 하면 클러스터 검사 없이 이어 만든다", async () => {
  const { s, store } = memStore(null);
  const o = { order: [] as string[], tokens: [], envs: [], fail: true };
  const root = rootRunner();
  const p = plan(AUTO, null);
  const r = await realApplyWithEnvLayer({ migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "gcp", accountId: PROJECT, spec: ONE, plan: p },
    { env: AUTO, runner: root.runner, gcpCred: CRED, envLayer: { store, exec: gcloud([]), runner: envRunner(o) } });
  assert.equal(r.ok, false);
  assert.equal((r as { failureCode: string }).failureCode, "ENV_LAYER_APPLY_FAILED");
  assert.equal(s.row?.status, "failed");
  assert.ok(!o.order.some((x) => /destroy/.test(x)));
  const d = (r as unknown as { detail: { envLayer: Record<string, unknown> } }).detail.envLayer;
  assert.equal(d.autoDestroy, false);
  assert.equal(d.failedPhase, "eso");
  assert.equal(root.seen.length, 0);
  // 다시: 실패 줄이 있으면 (우리 state 로 이어 만드는 중) 이미 생긴 클러스터가 있어도 NEEDS_HUMAN 이 아니다
  o.fail = false; o.order.length = 0;
  const again = await realApplyWithEnvLayer({ migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "gcp", accountId: PROJECT, spec: ONE, plan: p },
    { env: AUTO, runner: root.runner, gcpCred: CRED, envLayer: { store, exec: gcloud(["platform-target"]), runner: envRunner(o) } });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(s.row?.status, "ready");
});

test("빌린 토큰이 없으면 만들지 않는다 (svc-worker 로 떨어지지 않음) / 다른 이전이 만드는 중이면 ENV_LAYER_BUSY", async () => {
  const a = memStore(null);
  const o = { order: [] as string[], tokens: [], envs: [] };
  const r = await ensureEnvLayer({ tenantId: TENANT, migrationId: MID, envId: ENV_ID, provider: "gcp", projectId: PROJECT, region: REGION, plan: plan(AUTO, null) },
    { env: AUTO, store: a.store, exec: gcloud([]), runner: envRunner(o) });
  assert.equal(r.ok, false);
  assert.equal((r as { failureCode: string }).failureCode, "ENV_LAYER_CRED_MISSING");
  assert.deepEqual(o.order, []);
  const b = memStore({ status: "creating", facts: null, varsHash: VARS_HASH, moduleDigest: ENV_LAYER_MODULE_DIGEST });
  const busy = await ensureEnvLayer({ tenantId: TENANT, migrationId: MID, envId: ENV_ID, provider: "gcp", projectId: PROJECT, region: REGION, plan: plan(AUTO, null) },
    { env: AUTO, store: b.store, gcpCred: CRED, exec: gcloud([]), runner: envRunner(o) });
  assert.equal((busy as { failureCode: string }).failureCode, "ENV_LAYER_BUSY");
  assert.deepEqual(o.order, []);
});

test("승인 대조: 계획서에 환경 층 생성이 없거나 입력 지문이 다르면 만들지 않는다 (TF_PLAN_DRIFT)", async () => {
  const o = { order: [] as string[], tokens: [], envs: [] };
  const noCreate = await ensureEnvLayer({ tenantId: TENANT, migrationId: MID, envId: ENV_ID, provider: "gcp", projectId: PROJECT, region: REGION, plan: plan({}, null) },
    { env: AUTO, store: memStore(null).store, gcpCred: CRED, exec: gcloud([]), runner: envRunner(o) });
  assert.equal((noCreate as { failureCode: string }).failureCode, "TF_PLAN_DRIFT");
  const otherRegion = await ensureEnvLayer({ tenantId: TENANT, migrationId: MID, envId: ENV_ID, provider: "gcp", projectId: PROJECT, region: "us-central1", plan: plan(AUTO, null) },
    { env: AUTO, store: memStore(null).store, gcpCred: CRED, exec: gcloud([]), runner: envRunner(o) });
  assert.equal((otherRegion as { failureCode: string }).failureCode, "TF_PLAN_DRIFT");
  assert.deepEqual(o.order, []);
});

test("factsDrift: create 계획은 환경 층 키를 빼고 vars_hash 로 대조 (같으면 통과, 다르면 drift)", () => {
  const p = plan(AUTO, null);
  assert.equal(p.targetFacts?.clusterName, undefined, "계획 때는 클러스터 이름을 모른다");
  const nowFacts = { ...p.targetFacts, networkId: FACTS.network_id, clusterName: FACTS.cluster_name, clusterLocation: FACTS.cluster_location };
  assert.equal(factsDrift(p, nowFacts, null, { varsHash: VARS_HASH }), null);
  assert.match(factsDrift(p, nowFacts, null, { varsHash: "other" }) ?? "", /vars_hash/);
  assert.match(factsDrift(p, nowFacts, null, null) ?? "", /환경 층 사실이 없다/);
  assert.match(factsDrift(p, { ...nowFacts, projectId: "other-proj" }, null, { varsHash: VARS_HASH }) ?? "", /projectId/, "환경 층 밖 키는 그대로 비교");
  // existing 계획은 클러스터 키도 비교한다 (승인 뒤 환경 층이 바뀌면 drift)
  const e = plan({}, READY);
  assert.match(factsDrift(e, { ...e.targetFacts, clusterName: "other" }, null, { varsHash: VARS_HASH }) ?? "", /clusterName/);
});
