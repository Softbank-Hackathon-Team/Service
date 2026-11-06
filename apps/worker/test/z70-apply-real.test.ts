// Z70: apply 작업의 진짜 terraform 길 (DB 없이 realApply 만). 실행기·fetch 는 가짜
import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE } from "./demo-one.js";
import { type RealApplyResult } from "@svc/adapters";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { realApply, type RealApplyInput } from "../src/jobs/apply-real.js";
import { provisionOf, factsDrift, targetFactsOf } from "../src/jobs/plan-facts.js";
import { isNoCluster } from "../src/jobs/deploy.js";
import { withServedBy, servedByName } from "../src/gitops/index.js";

const ENV_ID = "33333333-3333-4333-8333-333333333333";
const MID = "4a8c0000-0000-4000-8000-0000000000cc";
const TENANT = "11111111-1111-4111-8111-111111111111";
const spec = ONE;
const plan = buildPlanDoc({ planId: "7f000000-0000-4000-8000-0000000000cc", migrationId: MID, spec,
  target: { envId: ENV_ID, provider: "aws", region: "default" }, precheck: stubPrecheck(), now: new Date() });
const inputBase: RealApplyInput = { migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "aws", accountId: "111122223333", spec, plan };
const input = inputBase;
const FACTS = { TF_FACT_VPC_ID: "vpc-1", TF_FACT_DB_SUBNET_IDS_JSON: '["subnet-a","subnet-b"]', TF_FACT_CLUSTER_NAME: "finals-eks" };

function fakeRunner(ok = true) {
  const seen: { provider: string; mid: string; vars: Record<string, unknown> }[] = [];
  return { seen, runner: { apply: async (provider: string, mid: string, vars: Record<string, unknown>): Promise<RealApplyResult> => {
    seen.push({ provider, mid, vars });
    return ok
      ? { ok: true, tfOutputs: { db_address: "shop.rds.example", db_master_secret_arn: "arn:x" }, workDir: `/w/${mid}`, steps: [], elapsedMs: 1, log: [], secretFetched: true }
      : { ok: false, tfOutputs: {}, workDir: `/w/${mid}`, steps: [], elapsedMs: 1, log: ["Error: quota"], failedStep: "apply" };
  } } as never };
}

test("승인 뒤 명세가 바뀌면 TF_PLAN_DRIFT, 실행기를 부르지 않는다", async () => {
  const f = fakeRunner();
  const renamed = { ...spec, app: { ...spec.app, name: "shop2" } };   // 앱 이름은 Terraform 입력(app_name)에 들어간다
  const r = await realApply({ ...input, spec: renamed }, { env: FACTS, runner: f.runner });
  assert.equal(r.ok, false);
  assert.equal((r as { failureCode: string }).failureCode, "TF_PLAN_DRIFT");
  assert.equal(f.seen.length, 0);
});

test("env 모듈 사실이 비면 TF_FACTS_MISSING + 넣어야 할 환경변수 이름", async () => {
  const f = fakeRunner();
  const r = await realApply(input, { env: {}, runner: f.runner });
  assert.equal(r.ok, false);
  assert.equal((r as { failureCode: string }).failureCode, "TF_FACTS_MISSING");
  assert.deepEqual((r.detail.missing as string[]).sort(), ["TF_FACT_CLUSTER_NAME", "TF_FACT_DB_SUBNET_IDS_JSON", "TF_FACT_VPC_ID"]);
  assert.equal(f.seen.length, 0);
});

test("자리표시를 다 채워 실행기로 넘기고, 출력 + cluster_name 을 돌려준다", async () => {
  const f = fakeRunner();
  const r = await realApply(input, { env: FACTS, runner: f.runner });
  assert.equal(r.ok, true);
  const vars = f.seen[0]!.vars;
  assert.equal(JSON.stringify(vars).includes("<env:"), false);
  assert.equal(vars.expected_account_id, "111122223333");
  assert.equal(vars.vpc_id, "vpc-1");
  assert.equal(vars.tenant_id, "t-11111111");
  assert.deepEqual((r as { tfOutputs: Record<string, string> }).tfOutputs,
    { cluster_name: "finals-eks", db_address: "shop.rds.example", db_master_secret_arn: "arn:x" });
});

test("apply 실패 → TF_APPLY_FAILED + 파기 명령 안내", async () => {
  const r = await realApply(input, { env: FACTS, runner: fakeRunner(false).runner });
  assert.equal(r.ok, false);
  assert.equal((r as { failureCode: string }).failureCode, "TF_APPLY_FAILED");
  assert.equal(r.detail.cleanup, `npm run tf:real -- destroy ${MID}`);
  assert.equal(r.detail.failedStep, "apply");
});

test("APP_LINK_TARGET_FROM_TF=1: 프록시마다 POST /upstream target=새 DB 주소. 하나라도 실패하면 APP_LINK_UPSTREAM_FAILED", async () => {
  const calls: { url: string; body: unknown; auth?: string }[] = [];
  const okFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization });
    return new Response("{}", { status: url.includes("bad") ? 409 : 200 });
  }) as unknown as typeof fetch;
  const env = { ...FACTS, APP_LINK_TARGET_FROM_TF: "1", APP_LINK_URLS: "http://p1:6480,http://p2:6480", APP_LINK_TOKEN: "tok" };
  const r = await realApply(input, { env, runner: fakeRunner().runner, fetch: okFetch });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.url), ["http://p1:6480/upstream", "http://p2:6480/upstream"]);
  assert.deepEqual(calls[0]!.body, { name: "target", host: "shop.rds.example", port: 5432 });
  assert.equal(calls[0]!.auth, "Bearer tok");
  const bad = await realApply(input, { env: { ...env, APP_LINK_URLS: "http://p1:6480,http://bad:6480" }, runner: fakeRunner().runner, fetch: okFetch });
  assert.equal(bad.ok, false);
  assert.equal((bad as { failureCode: string }).failureCode, "APP_LINK_UPSTREAM_FAILED");
  // 끄면 부르지 않는다
  calls.length = 0;
  await realApply(input, { env: FACTS, runner: fakeRunner().runner, fetch: okFetch });
  assert.equal(calls.length, 0);
});

test("배포 값에 SERVED_BY=<클라우드>-<구역> 한 줄 (이미 있으면 그대로)", () => {
  const b = { tenant: "t-11111111", app: "shop", env: "aws-eks" as const };
  assert.equal(servedByName(b), "aws-app-shop");
  const v = withServedBy({ env: [{ name: "A", value: "1" }] }, b);
  assert.deepEqual(v.env, [{ name: "A", value: "1" }, { name: "SERVED_BY", value: "aws-app-shop" }]);
  const keep = { env: [{ name: "SERVED_BY", value: "x" }] };
  assert.equal(withServedBy(keep, b), keep);
  assert.deepEqual(withServedBy({}, { ...b, env: "gcp-gke" }).env, [{ name: "SERVED_BY", value: "gcp-app-shop" }]);
});

// ---- Z77: 데모 DB 네트워크 변수는 계획 지문에 들어간다 ----
const PUB = { DB_PUBLIC: "1", DB_PEER_CIDRS: "203.0.113.7/32", DB_DISPOSABLE: "1" };
const planInput = { planId: "7f000000-0000-4000-8000-0000000000cc", migrationId: MID, spec,
  target: { envId: ENV_ID, provider: "aws" as const, region: "default" }, precheck: stubPrecheck(), now: new Date() };

test("Z77: DB_PUBLIC 을 안 켜면 계획 지문이 예전과 같고, 켜면 달라진다", () => {
  assert.equal(buildPlanDoc(planInput, {}).tfPlanHash, plan.tfPlanHash);
  assert.notEqual(buildPlanDoc(planInput, PUB).tfPlanHash, plan.tfPlanHash);
});

test("Z77: 공개로 승인한 계획 → 공개 변수 + 공개 서브넷을 채워 실행, 감사 detail 에 dbNetwork", async () => {
  const f = fakeRunner();
  const env = { ...FACTS, ...PUB, TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON: '["subnet-p1","subnet-p2"]' };
  const r = await realApply({ ...input, plan: buildPlanDoc(planInput, env) }, { env, runner: f.runner });
  assert.equal(r.ok, true);
  const pg0 = JSON.parse(f.seen[0]!.vars.postgres_json as string)[0];
  assert.equal(pg0.public, true);
  assert.equal(pg0.deletion_protection, false);
  assert.equal(pg0.public_subnet_ids_json, '["subnet-p1","subnet-p2"]');
  assert.deepEqual((r.detail.dbNetwork as { peerCidrs: string[] }).peerCidrs, ["203.0.113.7/32"]);
});

test("Z77: 사설로 승인한 뒤 .env 에 DB_PUBLIC 을 켜면 TF_PLAN_DRIFT (승인 없이 공개 안 됨)", async () => {
  const f = fakeRunner();
  const r = await realApply(input, { env: { ...FACTS, ...PUB, TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON: '["a","b"]' }, runner: f.runner });
  assert.equal((r as { failureCode: string }).failureCode, "TF_PLAN_DRIFT");
  assert.equal(f.seen.length, 0);
});

test("Z77: 0.0.0.0/0 같은 넓은 허용은 DB_NETWORK_INVALID, 실행기 안 부름", async () => {
  const f = fakeRunner();
  const r = await realApply(input, { env: { ...FACTS, DB_PUBLIC: "1", DB_PEER_CIDRS: "0.0.0.0/0" }, runner: f.runner });
  assert.equal((r as { failureCode: string }).failureCode, "DB_NETWORK_INVALID");
  assert.equal(f.seen.length, 0);
});

// ---- Z77: 클러스터 없이 RDS 만 (env 모듈 create_eks=false, 맥 B 회차) ----
test("Z77: TF_FACT_CLUSTER_NAME=\"\" 는 aws 에서 받아들이고, cluster_name=\"\" + noCluster 로 넘긴다 → deploy 는 STUB", async () => {
  const f = fakeRunner();
  const r = await realApply(input, { env: { ...FACTS, TF_FACT_CLUSTER_NAME: "" }, runner: f.runner });
  assert.equal(r.ok, true);
  assert.equal(f.seen[0]!.vars.cluster_name, "");
  const out = (r as { tfOutputs: Record<string, string> }).tfOutputs;
  assert.equal(out.cluster_name, "");
  assert.equal(r.detail.noCluster, true);
  assert.equal(isNoCluster(out), true);
  assert.equal(isNoCluster({ cluster_name: "finals-eks" }), false);
  assert.equal(isNoCluster({ db_address: "x" }), false);   // STUB·Mock 출력처럼 키가 없으면 클러스터 없음이 아니다
  assert.equal(isNoCluster(null), false);
});

test("Z77: 다른 사실의 빈 값은 여전히 모자란 것으로 본다 (TF_FACT_VPC_ID=\"\" → TF_FACTS_MISSING)", async () => {
  const f = fakeRunner();
  const r = await realApply(input, { env: { ...FACTS, TF_FACT_CLUSTER_NAME: "", TF_FACT_VPC_ID: "" }, runner: f.runner });
  assert.equal((r as { failureCode: string }).failureCode, "TF_FACTS_MISSING");
  assert.deepEqual(r.detail.missing, ["TF_FACT_VPC_ID"]);
  assert.equal(f.seen.length, 0);
});

test("Z77: gcp 는 클러스터 없이 안 된다 (TF_FACT_CLUSTER_NAME=\"\" → TF_FACTS_MISSING)", async () => {
  const gspec = ONE;
  const gplan = buildPlanDoc({ ...planInput, spec: gspec, target: { envId: ENV_ID, provider: "gcp", region: "default" } }, {});
  const f = fakeRunner();
  const r = await realApply({ ...input, provider: "gcp", accountId: "finals-demo", spec: gspec, plan: gplan },
    { env: { TF_FACT_CLUSTER_NAME: "", TF_FACT_NETWORK_ID: "n", TF_FACT_CLUSTER_LOCATION: "l" }, runner: f.runner });
  assert.equal((r as { failureCode: string }).failureCode, "TF_FACTS_MISSING");
  assert.deepEqual(r.detail.missing, ["TF_FACT_CLUSTER_NAME"]);
  assert.equal(f.seen.length, 0);
});

test("AWS→GCP 중계기: 작업 폴더 repl-network.json 이 있으면 postgres_json 에 복제 길(repl_public·허용 주소)·앱 로그인 SQL 을 덧씌운다 (지문 밖, 감사 detail 에 남김)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "repl-net-"));
  const gplan = buildPlanDoc({ ...planInput, spec, target: { envId: ENV_ID, provider: "gcp", region: "default" } }, {});
  const gin = { ...input, provider: "gcp" as const, accountId: "finals-demo", plan: gplan };
  const env = { TF_WORK_DIR: root, TF_FACT_CLUSTER_NAME: "c", TF_FACT_NETWORK_ID: "n", TF_FACT_CLUSTER_LOCATION: "l" };
  const pg = (vars: Record<string, unknown>) => JSON.parse(String(vars.postgres_json)) as Record<string, unknown>[];
  const before = fakeRunner();
  const r0 = await realApply(gin, { env, runner: before.runner });
  assert.equal(r0.ok, true, JSON.stringify(r0.detail));
  assert.ok(pg(before.seen[0]!.vars).length >= 1 && pg(before.seen[0]!.vars).every((p) => p.app_login_sql === undefined), "파일 없으면 그대로");
  mkdirSync(join(root, "t-11111111", MID), { recursive: true });
  writeFileSync(join(root, "t-11111111", MID, "repl-network.json"), JSON.stringify({ peerCidrs: ["198.51.100.7/32", "203.0.113.50/32"], appLoginSql: true }));
  const f = fakeRunner();
  const r = await realApply(gin, { env, runner: f.runner });
  assert.equal(r.ok, true);
  for (const p of pg(f.seen[0]!.vars)) {
    assert.equal(p.repl_public, true);
    assert.equal(p.app_login_sql, true);
    assert.deepEqual(JSON.parse(String(p.repl_peer_cidrs_json)), ["198.51.100.7/32", "203.0.113.50/32"]);
    assert.equal(p.public, pg(before.seen[0]!.vars)[0]!.public, "앱 공개 값은 그대로 (앱 주소 link.host 가 안 바뀜)");
  }
  assert.deepEqual(r.detail.replicationNetwork, { replPublic: true, peerCidrs: ["198.51.100.7/32", "203.0.113.50/32"], appLoginSql: true });
  writeFileSync(join(root, "t-11111111", MID, "repl-network.json"), JSON.stringify({ peerCidrs: ["0.0.0.0/0"], appLoginSql: true }));
  const bad = await realApply(gin, { env, runner: fakeRunner().runner });
  assert.equal((bad as { failureCode: string }).failureCode, "DB_NETWORK_INVALID", "세상 전체는 허용 주소로 안 받는다");
});

// Z89-03: imported.json 이 있으면 terraform(실행기)을 안 부르고, 같은 폴더에 outputs.json 을 남긴다 (복제 {tf:키} 가 읽는다)
test("Z89-03: imported 길 — 실행기 안 부름, outputs.json = imported tfOutputs, db-secret.json 없으면 dbSecret=false", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "z89-imp-"));
  const dir = join(root, "t-11111111", MID);   // tenantSlug(TENANT)
  mkdirSync(dir, { recursive: true });
  const outs = { db_address: "m1.rds.example", db_master_secret_arn: "arn:m1" };
  const imp = { source: "z88-import", tfOutputs: outs, resources: ["aws_db_instance.db"] };
  writeFileSync(join(dir, "imported.json"), JSON.stringify(imp));
  // G7-4: 재사용 계획은 계획서에도 provision 이 실려 있어야 한다 (계획 때 본 imported.json 과 같음)
  const input = { ...inputBase, plan: { ...plan, provision: provisionOf({ ...imp, file: "" }) } };
  const f = fakeRunner();
  const r = await realApply(input, { env: { ...FACTS, TF_WORK_DIR: root }, runner: f.runner });
  assert.equal(r.ok, true);
  assert.equal(f.seen.length, 0, "terraform 을 부르지 않는다");
  const d = (r as { detail: Record<string, unknown> }).detail;
  assert.equal(d.imported, true);
  assert.equal(d.dbSecret, false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "outputs.json"), "utf8")), outs);
  assert.equal(statSync(join(dir, "outputs.json")).mode & 0o777, 0o600);
  assert.equal((r as { tfOutputs: Record<string, string> }).tfOutputs.db_address, "m1.rds.example");
  writeFileSync(join(dir, "db-secret.json"), "{}", { mode: 0o600 });
  const r2 = await realApply(input, { env: { ...FACTS, TF_WORK_DIR: root }, runner: f.runner });
  assert.equal((r2 as { detail: Record<string, unknown> }).detail.dbSecret, true);
});

// G7-3·G7-4: 계획서 지문과 apply 직전 값 비교
test("G7-4: 새로 만들기로 승인한 뒤 imported.json 이 생기면 TF_PLAN_DRIFT, 실행기 안 부름", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "g74-"));
  const dir = join(root, "t-11111111", MID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "imported.json"), JSON.stringify({ source: "x", tfOutputs: { db_address: "a" }, resources: ["aws_db_instance.db"] }));
  const f = fakeRunner();
  const r = await realApply(input, { env: { ...FACTS, TF_WORK_DIR: root }, runner: f.runner });
  assert.equal((r as { failureCode: string }).failureCode, "TF_PLAN_DRIFT");
  assert.equal(f.seen.length, 0);
});

test("G7-3: 계획서의 도착 사실(VPC)이 apply 때 바뀌면 이유에 키 이름만 (값 글자 없음)", () => {
  const vars = { vpcId: "<env:vpcId>", accountId: "<env:accountId>", tenantId: "<env:tenantId>" } as never;
  const before = targetFactsOf(vars, FACTS, "aws", "111122223333");
  assert.deepEqual(Object.keys(before ?? {}).sort(), ["accountId", "vpcId"]);
  const p = { ...plan, targetFacts: before };
  assert.equal(factsDrift(p, targetFactsOf(vars, FACTS, "aws", "111122223333"), null), null);
  const why = factsDrift(p, targetFactsOf(vars, { ...FACTS, TF_FACT_VPC_ID: "vpc-2" }, "aws", "111122223333"), null);
  assert.match(why ?? "", /vpcId/);
  assert.doesNotMatch(why ?? "", /vpc-1|vpc-2/);
  // 옛 계획서(targetFacts 없음)는 비교하지 않는다
  assert.equal(factsDrift(plan, before, null), null);
});
