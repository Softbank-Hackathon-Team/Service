// 환경 층 실행기 (infra/modules/gcp/env): 작업 폴더 모양, 1차·2차 apply, 단계마다 새 env, 실패 때 지우지 않음 (terraform 은 가짜 exec)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tfBudget } from "@svc/contracts";
import { createEnvLayerRunner, createRealTerraformRunner, envLayerBackend, envLayerDirOf, envLayerFactsOf, envLayerVars, envLayerVarsHash, factsOfLayer,
  mergeFacts, sourceDbLinkInputFromEnv, type Exec } from "../src/index.js";

const TENANT = "t-0123abcd";
const ENV_ID = "33333333-3333-4333-8333-333333333333";
const VARS = envLayerVars({ projectId: "mig-target-proj", region: "asia-northeast3" });
const OUT = { network_id: { value: "projects/p/global/networks/platform-target" }, cluster_name: { value: "platform-target" },
  cluster_location: { value: "asia-northeast3-a" }, nat_egress_ips: { value: ["34.64.1.2"] }, cluster_endpoint: { value: "1.2.3.4" },
  registry_host: { value: "asia-northeast3-docker.pkg.dev/p/platform" }, secret_store_name: { value: "gcp-secret-manager" }, eso_service_account_email: { value: "x" } };

function fake(o: { failAt?: string } = {}) {
  const calls: { args: string[]; tfvars: Record<string, unknown>; token?: string; cwd: string }[] = [];
  const exec: Exec = async (_cmd, args, x) => {
    const tfvars = JSON.parse(readFileSync(join(x.cwd, "terraform.tfvars.json"), "utf8")) as Record<string, unknown>;
    calls.push({ args, tfvars, token: x.env.CLOUDSDK_AUTH_ACCESS_TOKEN, cwd: x.cwd });
    const step = args[1]!;
    const tag = `${tfvars.create_eso ? "eso" : "cluster"}:${step}`;
    if (o.failAt === tag) return { code: 1, stdout: "", stderr: "Error: googleapi: Error 403", ms: 1 };
    return { code: 0, stdout: step === "output" ? JSON.stringify(OUT) : "ok", stderr: "", ms: 1 };
  };
  return { calls, exec };
}

test("1차(create_eso=false)·2차(create_eso=true) 순서로 init·plan·apply, 끝에 output → 사실 (비밀 아닌 값만)", async () => {
  const work = mkdtempSync(join(tmpdir(), "envl-"));
  const f = fake();
  let n = 0;
  const r = await createEnvLayerRunner({ exec: f.exec, workRoot: work, env: () => ({ PATH: "/bin", CLOUDSDK_AUTH_ACCESS_TOKEN: `tok-${++n}`, CLOUDFLARE_API_TOKEN: "cf" }) })
    .apply(TENANT, ENV_ID, VARS);
  assert.equal(r.ok, true, r.log.join("\n"));
  assert.deepEqual(f.calls.map((c) => `${c.tfvars.create_eso ? "eso" : "cluster"}:${c.args[1]}`),
    ["cluster:init", "cluster:plan", "cluster:apply", "eso:init", "eso:plan", "eso:apply", "eso:output"]);
  assert.ok(f.calls.every((c) => c.args[0] === "-chdir=modules/gcp/env"));
  assert.ok(f.calls.every((c) => c.tfvars.project_id === "mig-target-proj" && c.tfvars.create_gke === true));
  // B-2: 노드는 고객 svc-gke-node 로 돈다 (기본 Compute SA 아님)
  assert.ok(f.calls.every((c) => c.tfvars.node_service_account === "svc-gke-node@mig-target-proj.iam.gserviceaccount.com"));
  // 단계마다 env() 를 다시 불러 그 순간의 토큰 (1차 tok-2, 2차 tok-3: tok-1 은 실행기 만들 때 설정 읽기)
  assert.deepEqual([...new Set(f.calls.map((c) => c.token))], ["tok-2", "tok-3"]);
  assert.deepEqual(r.facts, { network_id: "projects/p/global/networks/platform-target", cluster_name: "platform-target", cluster_location: "asia-northeast3-a",
    nat_egress_ips: ["34.64.1.2"], registry_host: "asia-northeast3-docker.pkg.dev/p/platform", secret_store_name: "gcp-secret-manager" });
  // 작업 폴더: TF_WORK_DIR/<회사>/env-<환경>, 모듈과 차트가 모듈 상대 경로(../../../charts) 그대로, backend 는 폴더 위 state
  const dir = envLayerDirOf(work, TENANT, ENV_ID);
  assert.equal(r.workDir, dir);
  assert.ok(existsSync(join(dir, "modules/gcp/env/main.tf")));
  assert.ok(existsSync(join(dir, "charts/cluster-secret-store/Chart.yaml")));
  assert.match(readFileSync(join(dir, "modules/gcp/env/zz_backend.tf"), "utf8"), /path = "\.\.\/\.\.\/\.\.\/terraform\.tfstate"/);
  assert.equal(envLayerBackend(dir).file, join(dir, "terraform.tfstate"));
  assert.ok(!existsSync(join(dir, "modules/gcp/env/tests")), "시험 폴더는 복사하지 않는다");
});

test("거부: 2차(ESO) apply 실패 → ok=false, destroy 를 부르지 않는다 (환경 소유, 자동 삭제 없음)", async () => {
  const f = fake({ failAt: "eso:apply" });
  const r = await createEnvLayerRunner({ exec: f.exec, workRoot: mkdtempSync(join(tmpdir(), "envl-")), env: () => ({ PATH: "/bin" }) }).apply(TENANT, ENV_ID, VARS);
  assert.equal(r.ok, false);
  assert.equal(r.failedPhase, "eso");
  assert.equal(r.failedStep, "apply");
  assert.ok(!f.calls.some((c) => c.args.includes("destroy")));
  assert.ok(r.log.some((l) => /403/.test(l)));
});

test("예산: 1·2차가 TF_ENV_LAYER_BUDGET_SEC 하나를 나눠 쓴다 (다 쓰면 다음 단계는 안 돌림). ENV_LAYER_AUTO=1 이면 큐 기한에 더한다", async () => {
  const f = fake();
  const r = await createEnvLayerRunner({ exec: f.exec, workRoot: mkdtempSync(join(tmpdir(), "envl-")), env: () => ({ PATH: "/bin", TF_ENV_LAYER_BUDGET_SEC: "0" }) })
    .apply(TENANT, ENV_ID, VARS);
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 0);
  assert.equal(r.steps[0]?.code, 124);
  const off = tfBudget({}), on = tfBudget({ ENV_LAYER_AUTO: "1" });
  assert.equal(on.applyExpireSec - off.applyExpireSec, on.envLayerSec + on.graceSec);
  assert.equal(off.applyExpireSec, off.jobSec + off.destroySec + 2 * off.graceSec + 300, "꺼져 있으면 예전 기한");
});

test("사실: DB 사실이 TF_FACT_* 를 이기고, 출력에 클러스터가 없으면 null. 입력 지문은 create_eso 와 무관", () => {
  assert.deepEqual(mergeFacts({ clusterName: "db" }, { clusterName: "env", vpcId: "v" }), { clusterName: "db", vpcId: "v" });
  assert.deepEqual(mergeFacts(null, { clusterName: "env" }), { clusterName: "env" });
  assert.equal(envLayerFactsOf({ cluster_name: "", network_id: "n", cluster_location: "z" }), null);
  const f = factsOfLayer({ network_id: "n", cluster_name: "c", cluster_location: "z", nat_egress_ips: ["1.1.1.1"] });
  assert.equal(f.natEgressIpsJson, '["1.1.1.1"]');
  assert.equal(envLayerVarsHash(VARS), envLayerVarsHash({ ...VARS }));
  assert.notEqual(envLayerVarsHash(VARS), envLayerVarsHash(envLayerVars({ projectId: "other", region: "asia-northeast3" })));
  assert.throws(() => envLayerDirOf("/w", "../x", ENV_ID));
  // 출발 DB 잇기: 환경 층 NAT IP 가 TF_FACT_NAT_EGRESS_IPS_JSON 보다 먼저
  assert.deepEqual(sourceDbLinkInputFromEnv({ TF_FACT_NAT_EGRESS_IPS_JSON: '["9.9.9.9"]' }, f).egressCidrs, ["1.1.1.1/32"]);
  assert.deepEqual(sourceDbLinkInputFromEnv({ TF_FACT_NAT_EGRESS_IPS_JSON: '["9.9.9.9"]' }).egressCidrs, ["9.9.9.9/32"]);
});

test("DB 비밀 꺼내기의 --project 는 빌린 토큰 env 의 도착 프로젝트가 TF_FACT_PROJECT_ID 보다 먼저", async () => {
  const seen: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === "gcloud") seen.push(args);
    return { code: 0, stdout: args.includes("output") ? JSON.stringify({ db_password_secret_id: { value: "sec" } }) : cmd === "gcloud" ? "pw" : "", stderr: "", ms: 1 };
  };
  const run = (env: NodeJS.ProcessEnv) => createRealTerraformRunner({ env, exec, workRoot: mkdtempSync(join(tmpdir(), "envl-")) })
    .apply("gcp", "4a8c0000-0000-4000-8000-0000000000a1", {} as never);
  await run({ PATH: "/bin", TF_FACT_PROJECT_ID: "demo-proj", CLOUDSDK_CORE_PROJECT: "mig-target-proj" });
  await run({ PATH: "/bin", TF_FACT_PROJECT_ID: "demo-proj" });
  assert.ok(seen[0]!.includes("--project=mig-target-proj"), seen[0]!.join(" "));
  assert.ok(seen[1]!.includes("--project=demo-proj"), "토큰 env 가 없으면 예전 그대로");
});
