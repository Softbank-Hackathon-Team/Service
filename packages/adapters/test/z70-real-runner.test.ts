// Z70: 진짜 terraform 실행기 시험. terraform·aws·gcloud 는 절대 부르지 않는다 (가짜 exec 가 받은 명령만 적는다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealTerraformRunner, workDirOf, findWorkDir, PLAN_ONLY_ID, planOnlyId, realTerraformEnabled, factEnvName, factsFromEnv, fillTfVars, parseOutputs, childEnv,
  type Exec, type ExecResult } from "../src/index.js";

const MID = "4a8c0000-0000-4000-8000-0000000000aa";
const PASSWORD = "s3cr3t-pw-should-not-leak";
const OUTPUTS = JSON.stringify({
  db_address: { value: "shop.abc.ap-northeast-2.rds.amazonaws.com", sensitive: false },
  db_master_secret_arn: { value: "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:rds!db-x", sensitive: false },
  app_role_arn: { value: "arn:aws:iam::111122223333:role/app", sensitive: false },
  hidden: { value: "nope", sensitive: true },
  ports: { value: [5432], sensitive: false },
});

function fakeExec(fail?: string) {
  const calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }[] = [];
  const exec: Exec = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env, signal: o.signal });
    const r = (code: number, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr, ms: 5 });
    // 루트 배치는 -chdir=root 같은 전역 인자가 앞에 붙는다 → 첫 하위 명령으로 본다
    const sub = args.find((a) => !a.startsWith("-"));
    if (fail && sub === fail) return r(1, "", `Error: ${fail} broke`);
    if (sub === "output") return r(0, OUTPUTS);
    if (sub === "secretsmanager") return r(0, JSON.stringify({ username: "postgres", password: PASSWORD }));
    if (sub === "plan") return r(0, "Plan: 7 to add, 0 to change, 0 to destroy.");
    return r(0, "ok");
  };
  return { exec, calls };
}
const subOf = (args: string[]) => args.find((a) => !a.startsWith("-"));
const tmp = () => mkdtempSync(join(tmpdir(), "z70-"));

test("Z89: 기본이 진짜 terraform, MOCK_IAC=1 일 때만 흉내 (예전 스위치 둘은 무시)", () => {
  assert.equal(realTerraformEnabled({}), true);
  assert.equal(realTerraformEnabled({ MOCK_IAC: "1" }), false);
  assert.equal(realTerraformEnabled({ MOCK_IAC: "0" }), true);
  assert.equal(realTerraformEnabled({ MOCK_IAC: "" }), true);
  assert.equal(realTerraformEnabled({ USE_TERRAFORM: "0", TF_REAL_APPLY: "0" }), true);
  assert.equal(realTerraformEnabled({ USE_TERRAFORM: "1", TF_REAL_APPLY: "1", MOCK_IAC: "1" }), false);
});

test("자리표시 <env:키> 는 TF_FACT_* 로 채우고, 빈 것은 이름을 알려 준다", () => {
  assert.equal(factEnvName("dbSubnetIdsJson"), "TF_FACT_DB_SUBNET_IDS_JSON");
  const facts = factsFromEnv({ TF_FACT_VPC_ID: "vpc-1", TF_FACT_CLUSTER_NAME: "c1" }, { accountId: "111122223333", projectId: undefined });
  assert.deepEqual(facts, { accountId: "111122223333", vpcId: "vpc-1", clusterName: "c1" });
  const r = fillTfVars({ a: "<env:vpcId>", b: "arn:aws:iam::<env:accountId>:policy/x", c: "<env:dbSubnetIdsJson>", n: 3 }, facts);
  assert.deepEqual(r.vars, { a: "vpc-1", b: "arn:aws:iam::111122223333:policy/x", c: "<env:dbSubnetIdsJson>", n: 3 });
  assert.deepEqual(r.missing, ["dbSubnetIdsJson"]);
});

test("output -json: sensitive 는 빼고, 목록은 JSON 문자열", () => {
  const o = parseOutputs(OUTPUTS);
  assert.equal(o.hidden, undefined);
  assert.equal(o.ports, "[5432]");
  assert.equal(o.db_address, "shop.abc.ap-northeast-2.rds.amazonaws.com");
});

test("자식 프로세스에는 클라우드 자격·경로만. DB 비밀번호·API 키는 안 넘긴다", () => {
  const e = childEnv({ PATH: "/bin", AWS_PROFILE: "finals", CLOUDSDK_CORE_PROJECT: "p", HTTPS_PROXY: "http://p",
    REPL_TARGET_URL: "postgres://u:pw@h/db", ANTHROPIC_API_KEY: "k", CLOUDFLARE_API_TOKEN: "t", GITOPS_WRITE_TOKEN: "g", DATABASE_URL: "x" });
  assert.deepEqual(Object.keys(e).sort(), ["AWS_PROFILE", "CLOUDSDK_CORE_PROJECT", "HTTPS_PROXY", "PATH", "TF_INPUT", "TF_IN_AUTOMATION"]);
});

test("apply: init → plan -out → apply tfplan → output → 비밀번호 꺼내기. 이전마다 작업 폴더 하나", async () => {
  const root = tmp(); const { exec, calls } = fakeExec();
  const ac = new AbortController();
  const r = createRealTerraformRunner({ exec, workRoot: root, env: { PATH: "/bin", AWS_PROFILE: "finals", REPL_TARGET_URL: "postgres://x" } });
  const res = await r.apply("aws", MID, { app_name: "shop", db_enabled: true }, ac.signal);
  assert.equal(res.ok, true);
  assert.deepEqual(calls.map((c) => `${c.cmd} ${subOf(c.args)}`), ["terraform init", "terraform plan", "terraform apply", "terraform output", "aws secretsmanager"]);
  assert.ok(calls[1]!.args.includes("-out=../tfplan") && calls[1]!.args.includes("-var-file=../terraform.tfvars.json"));
  assert.equal(calls[2]!.args.at(-1), "../tfplan");
  assert.ok(calls.every((c) => c.cwd === join(root, MID) && c.signal === ac.signal));
  assert.ok(calls.every((c) => c.env.REPL_TARGET_URL === undefined));
  // 모듈 파일이 복사되고 tests/ 는 빠진다
  assert.ok(existsSync(join(root, MID, "root", "main.tf")));
  assert.equal(existsSync(join(root, MID, "root", "tests")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(root, MID, "terraform.tfvars.json"), "utf8")), { app_name: "shop", db_enabled: true });
  assert.equal(res.tfOutputs.db_address, "shop.abc.ap-northeast-2.rds.amazonaws.com");
  assert.equal(res.secretFetched, true);
  // 비밀번호는 0600 파일에만. 결과·로그·outputs.json 에 없다
  const sf = join(root, MID, "db-secret.json");
  assert.equal(statSync(sf).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(sf, "utf8")).db_password, PASSWORD);
  assert.equal(JSON.stringify(res).includes(PASSWORD), false);
  assert.equal(readFileSync(join(root, MID, "outputs.json"), "utf8").includes(PASSWORD), false);
  // RV-15: 작업 폴더(tfstate 에 GCP DB 비밀번호 원문)·outputs.json 도 나만 읽게
  assert.equal(statSync(join(root, MID)).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, MID, "outputs.json")).mode & 0o777, 0o600);
});

// 묶음 이미지(dist/worker)는 import.meta.url 로 레포 뿌리를 못 찾는다 → Dockerfile 이 TF_MODULE_ROOT=/app/infra/modules 를 준다
test("TF_MODULE_ROOT: 모듈을 그 폴더에서 복사한다. 없으면 레포 infra/modules, 거기 루트 모듈이 없으면 apply 전에 멈춘다", async () => {
  const mods = tmp();
  mkdirSync(join(mods, "onprem", "root"), { recursive: true });
  writeFileSync(join(mods, "onprem", "root", "main.tf"), "# from TF_MODULE_ROOT\n");
  const root = tmp(); const { exec } = fakeExec();
  const res = await createRealTerraformRunner({ exec, workRoot: root, env: { TF_MODULE_ROOT: mods } }).apply("onprem", MID, { app_name: "shop" });
  assert.equal(res.ok, true);
  assert.equal(readFileSync(join(root, MID, "root", "main.tf"), "utf8"), "# from TF_MODULE_ROOT\n");
  // 거부: 그 폴더에 aws 루트가 없으면 terraform 을 부르기 전에 멈춘다 (레포 모듈로 몰래 넘어가지 않는다)
  const { exec: e2, calls } = fakeExec();
  await assert.rejects(createRealTerraformRunner({ exec: e2, workRoot: tmp(), env: { TF_MODULE_ROOT: mods } }).apply("aws", MID, { app_name: "shop" }), /no root module for aws/);
  assert.equal(calls.length, 0);
});

test("plan 이 실패하면 apply 를 부르지 않고 failedStep=plan, 로그에 오류 줄", async () => {
  const root = tmp(); const { exec, calls } = fakeExec("plan");
  const res = await createRealTerraformRunner({ exec, workRoot: root, env: {} }).apply("gcp", MID, { app_name: "shop" });
  assert.equal(res.ok, false);
  assert.equal(res.failedStep, "plan");
  assert.deepEqual(calls.map((c) => subOf(c.args)), ["init", "plan"]);
  assert.ok(res.log.some((l) => l.includes("plan broke")));
});

test("TF_FETCH_DB_SECRET=0 이면 비밀번호를 꺼내지 않는다. azure_mock 은 진짜 모듈이 없다", async () => {
  const root = tmp(); const { exec, calls } = fakeExec();
  const r = createRealTerraformRunner({ exec, workRoot: root, env: { TF_FETCH_DB_SECRET: "0" } });
  const res = await r.apply("aws", MID, {});
  assert.equal(res.secretFetched, false);
  assert.equal(calls.some((c) => c.cmd === "aws"), false);
  await assert.rejects(r.apply("azure_mock", MID, {}), /no real terraform module/);
  await assert.rejects(r.apply("aws", "../../etc", {}), /bad migration id/);
});

test("destroy·list: 같은 작업 폴더에서 -var-file 로 파기, state 자원 수를 센다", async () => {
  const root = tmp(); const { exec, calls } = fakeExec();
  const r = createRealTerraformRunner({ exec, workRoot: root, env: {} });
  assert.equal((await r.destroy(MID)).skipped, "no_work_dir");
  await r.apply("onprem", MID, { app_name: "shop" });
  writeFileSync(join(root, MID, "terraform.tfstate"), JSON.stringify({ resources: [{}, {}, {}] }));
  assert.deepEqual(r.list().map((x) => [x.migrationId, x.provider, x.resources]), [[MID, "onprem", 3]]);
  calls.length = 0;
  const d = await r.destroy(MID);
  assert.equal(d.ok, true);
  assert.deepEqual(calls.map((c) => subOf(c.args)), ["init", "destroy"]);
  assert.ok(calls[1]!.args.includes("-var-file=../terraform.tfvars.json") && calls[1]!.args.includes("-auto-approve"));
});

test("기본 exec(spawn): 잠금을 잃으면(abort) SIGINT 로 바로 멈춘다, 제한 시간도", async () => {
  const { spawnExec } = await import("../src/index.js");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  const r = await spawnExec("sleep", ["5"], { cwd: tmpdir(), env: { PATH: process.env.PATH }, signal: ac.signal, timeoutMs: 10_000 });
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < 2000);
  const t = await spawnExec("sleep", ["5"], { cwd: tmpdir(), env: { PATH: process.env.PATH }, timeoutMs: 100 });
  assert.notEqual(t.code, 0);
  assert.match(t.stderr, /timeout 100ms/);
  const nf = await spawnExec("no-such-binary-z70", [], { cwd: tmpdir(), env: {}, timeoutMs: 1000 });
  assert.equal(nf.code, 127);
});

test("tf:real plan: 전용 작업 폴더 id가 workDirOf 검사를 통과한다 (옛 \"00000000-plan-only\"는 막혔음)", () => {
  assert.equal(workDirOf("/r", PLAN_ONLY_ID), join("/r", PLAN_ONLY_ID));
  assert.throws(() => workDirOf("/r", "00000000-plan-only"), /bad migration id/);
});

test("tf:real plan onprem: planOnly 가 init·plan 만 부르고 요약을 돌려준다 (가짜 exec)", async () => {
  const { exec, calls } = fakeExec();
  const root = mkdtempSync(join(tmpdir(), "tf-plan-"));
  const r = await createRealTerraformRunner({ exec, workRoot: root, env: {} }).planOnly("onprem", { app_name: "shop" });
  assert.equal(r.ok, true);
  assert.equal(r.workDir, join(root, PLAN_ONLY_ID));
  assert.match(r.summary ?? "", /Plan: 7 to add/);
  assert.deepEqual(calls.map((c) => subOf(c.args)), ["init", "plan"]);
});

// Z38 REVIEW-6 R6-1: plan 전용 폴더가 프로바이더마다 달라서, aws plan 뒤 gcp plan 이 aws 파일과 섞이지 않는다
test("tf:real plan: 프로바이더마다 다른 작업 폴더 (onprem 은 예전 번호)", async () => {
  const { exec } = fakeExec();
  const root = mkdtempSync(join(tmpdir(), "tf-plan-"));
  const r = createRealTerraformRunner({ exec, workRoot: root, env: {} });
  const dirs = await Promise.all((["aws", "gcp", "onprem"] as const).map(async (p) => (await r.planOnly(p, { app_name: "shop" })).workDir));
  assert.equal(new Set(dirs).size, 3);
  assert.equal(dirs[2], join(root, PLAN_ONLY_ID));
  for (const p of ["aws", "gcp", "onprem"] as const) assert.doesNotThrow(() => workDirOf(root, planOnlyId(p)));
  const awsOnly = readdirSync(join(root, planOnlyId("aws"), "root")).filter((f) => f.endsWith(".tf"));
  const gcpOnly = readdirSync(join(root, planOnlyId("gcp"), "root")).filter((f) => f.endsWith(".tf"));
  assert.ok(awsOnly.length > 0 && gcpOnly.length > 0);
  assert.equal(readFileSync(join(root, planOnlyId("gcp"), "provider.txt"), "utf8"), "gcp");
});

// ---- Z89 ----
const TEN = "t-1a2b3c4d";

test("Z89: 회사를 주면 state 폴더가 <뿌리>/<회사>/<이전>, 회사 모양이 아니면 거부", async () => {
  const root = tmp(); const { exec, calls } = fakeExec();
  const r = createRealTerraformRunner({ exec, workRoot: root, env: { TF_FETCH_DB_SECRET: "0" } });
  const res = await r.apply("aws", MID, { app_name: "shop" }, undefined, TEN);
  assert.equal(res.ok, true);
  assert.equal(res.workDir, join(root, TEN, MID));
  assert.ok(calls.every((c) => c.cwd === join(root, TEN, MID)));
  assert.equal(readFileSync(join(root, TEN, MID, "tenant.txt"), "utf8"), TEN);
  assert.ok(calls.find((c) => subOf(c.args) === "apply")!.args.includes("-lock-timeout=60s"));
  await assert.rejects(r.apply("aws", MID, {}, undefined, "../x"), /bad tenant/);
  assert.throws(() => workDirOf(root, MID, "T-ABC"), /bad tenant/);
  // 찾기·목록·파기는 회사 폴더를 본다
  assert.equal(findWorkDir(root, MID), join(root, TEN, MID));
  assert.deepEqual(r.list().map((x) => [x.migrationId, x.tenant, x.provider]), [[MID, TEN, "aws"]]);
  calls.length = 0;
  const d = await r.destroy(MID);
  assert.equal(d.ok, true);
  assert.equal(d.workDir, join(root, TEN, MID));
  assert.deepEqual(calls.map((c) => subOf(c.args)), ["init", "destroy"]);
});

test("Z89: 같은 이전 id 가 두 회사 폴더에 있으면 찾기를 멈춘다 (남의 state 를 destroy 하지 않게)", async () => {
  const root = tmp(); const { exec } = fakeExec();
  const r = createRealTerraformRunner({ exec, workRoot: root, env: { TF_FETCH_DB_SECRET: "0" } });
  await r.apply("aws", MID, {}, undefined, TEN);
  await r.apply("aws", MID, {}, undefined, "t-99999999");
  assert.throws(() => findWorkDir(root, MID), /2 tenants/);
  await assert.rejects(r.destroy(MID), /2 tenants/);
});

test("Z89: TF_DESTROY_ON_FAIL=1 이면 apply 단계 실패 → 같은 폴더에서 바로 destroy (기본·0 이면 안 함 = Jeong 11/4 01:53Z, abort 면 안 함)", async () => {
  const root = tmp();
  let f = fakeExec("apply");
  let res = await createRealTerraformRunner({ exec: f.exec, workRoot: root, env: { TF_DESTROY_ON_FAIL: "1" } }).apply("aws", MID, {}, undefined, TEN);
  assert.equal(res.ok, false); assert.equal(res.failedStep, "apply");
  assert.deepEqual(f.calls.map((c) => subOf(c.args)), ["init", "plan", "apply", "destroy"]);
  assert.ok(f.calls[3]!.args.includes("-var-file=../terraform.tfvars.json") && f.calls[3]!.args.includes("-auto-approve"));
  assert.deepEqual(res.destroyedAfterFail, { ok: true, ms: 5 });
  f = fakeExec("apply");
  res = await createRealTerraformRunner({ exec: f.exec, workRoot: tmp(), env: { TF_DESTROY_ON_FAIL: "0" } }).apply("aws", MID, {});
  assert.deepEqual(f.calls.map((c) => subOf(c.args)), ["init", "plan", "apply"]);
  assert.equal(res.destroyedAfterFail, undefined);
  f = fakeExec("apply");
  res = await createRealTerraformRunner({ exec: f.exec, workRoot: tmp(), env: {} }).apply("aws", MID, {});
  assert.deepEqual(f.calls.map((c) => subOf(c.args)), ["init", "plan", "apply"], "기본은 지우지 않고 사람 답을 기다림");
  f = fakeExec("apply"); const ac = new AbortController(); ac.abort();
  res = await createRealTerraformRunner({ exec: f.exec, workRoot: tmp(), env: { TF_DESTROY_ON_FAIL: "1" } }).apply("aws", MID, {}, ac.signal);
  assert.equal(f.calls.some((c) => subOf(c.args) === "destroy"), false);
  // plan 실패는 만든 것이 없으니 destroy 도 안 부른다
  f = fakeExec("plan");
  await createRealTerraformRunner({ exec: f.exec, workRoot: tmp(), env: {} }).apply("aws", MID, {});
  assert.deepEqual(f.calls.map((c) => subOf(c.args)), ["init", "plan"]);
});

test("Z89: version() — 실행 파일이 없으면 ok:false + 이유", async () => {
  const none = await createRealTerraformRunner({ workRoot: tmp(), env: { PATH: process.env.PATH }, terraformBin: "no-such-terraform-z89" }).version();
  assert.equal(none.ok, false); assert.match(none.error!, /실행 파일 없음/);
  const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify({ terraform_version: "1.9.8" }), stderr: "", ms: 1 });
  assert.deepEqual(await createRealTerraformRunner({ exec, workRoot: tmp(), env: {} }).version(), { ok: true, version: "1.9.8" });
});

test("Z89: imported.json 이 있으면 그 출력·자원 목록을 읽는다 (없으면 null)", async () => {
  const { readImported } = await import("../src/index.js");
  const root = tmp();
  assert.equal(readImported(root, MID, TEN), null);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, TEN, MID), { recursive: true });
  writeFileSync(join(root, TEN, MID, "imported.json"), JSON.stringify({ source: "z88-import", tfOutputs: { db_address: "x.rds", n: 3 }, resources: ["aws_db_instance.db", 7] }));
  const r = readImported(root, MID, TEN)!;
  assert.deepEqual([r.source, r.tfOutputs, r.resources], ["z88-import", { db_address: "x.rds" }, ["aws_db_instance.db"]]);
});
