// PF-E35 APP-22 (가) DECISION(team, 11/4 01:57Z): Terraform 이 앱을 띄우는 도착(ECS·Cloud Run·VM)은
//   apply 때 출발 경로로 띄우고(db_writer_json active=source, 비밀번호는 도착 그릇에만), 컷오버·롤백 때 active 만 바꿔 다시 apply (실패해도 destroy 안 함).
//   DB 없이 realApply·reapplyDbWriter 만. 실행기·그릇 넣기는 가짜
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSpecV2 } from "@svc/contracts";
import { DEMO_INVENTORY, normalizeV2, workDirOf, type RealApplyResult } from "@svc/adapters";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { realApply, reapplyDbWriter, type RealApplyInput } from "../src/jobs/apply-real.js";
import { cutoverAppLinkBlock } from "../src/app-link.js";

const ENV_ID = "33333333-3333-4333-8333-333333333333";
const MID = "4a8c0000-0000-4000-8000-0000000000e5";
const TENANT = "11111111-1111-4111-8111-111111111111";
const spec = AppSpecV2.parse(normalizeV2(DEMO_INVENTORY.aws!).result.spec);   // ECS 3티어 + postgres (비밀 짝 있음)
const plan = buildPlanDoc({ planId: "7f000000-0000-4000-8000-0000000000e5", migrationId: MID, spec,
  target: { envId: ENV_ID, provider: "aws", region: "default" }, precheck: stubPrecheck(), now: new Date() });
const input: RealApplyInput = { migrationId: MID, tenantId: TENANT, envId: ENV_ID, provider: "aws", accountId: "111122223333", spec, plan };
const PW = "s3cr3t-link-pw";
const baseEnv = () => ({
  TF_FACT_VPC_ID: "vpc-1", TF_FACT_DB_SUBNET_IDS_JSON: '["subnet-a","subnet-b"]', TF_FACT_CLUSTER_NAME: "finals-eks",
  TF_WORK_DIR: mkdtempSync(join(tmpdir(), "pfe35-")), REPL_SOURCE_URL: "postgres://admin:x@src-db.example:5432/shop",
  APP_LINK_SOURCE_URL: `postgres://svc_link_4a8c0000:${PW}@src-db.example:5432/shop`,
});

function fakeRunner(ok = true) {
  const seen: { vars: Record<string, unknown>; o?: { keepOnFail?: boolean } }[] = [];
  return { seen, runner: { apply: async (_p: string, mid: string, vars: Record<string, unknown>, _s?: AbortSignal, _t?: string, o?: { keepOnFail?: boolean }): Promise<RealApplyResult> => {
    seen.push({ vars, o });
    return ok ? { ok: true, tfOutputs: { db_address: "shop.rds.example" }, workDir: `/w/${mid}`, steps: [], elapsedMs: 1, log: [] }
      : { ok: false, tfOutputs: {}, workDir: `/w/${mid}`, steps: [], elapsedMs: 1, log: ["Error"], failedStep: "apply" };
  } } as never };
}
const writer = (vars: Record<string, unknown>) => JSON.parse(String(vars.db_writer_json));

test("PF-E35 정상: apply = 출발 쪽으로 띄움(비밀번호는 그릇에만) → 컷오버 = target 으로 다시 apply → 롤백 = source 로 다시 apply", async () => {
  const env = baseEnv();
  const puts: { name: string; password: string }[] = [];
  const f = fakeRunner();
  const r = await realApply(input, { env, runner: f.runner, putSecret: async (_p, name, password) => { puts.push({ name, password }); } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const w0 = writer(f.seen[0]!.vars);
  assert.equal(w0.active, "source");
  assert.equal(Object.values(w0.link as Record<string, { host: string; user: string }>)[0]!.host, "src-db.example");
  assert.deepEqual(puts, [{ name: w0.external[0], password: PW }], "비밀번호는 그릇에 한 번");
  assert.equal(JSON.stringify(f.seen[0]!.vars).includes(PW), false, "Terraform 변수에 비밀번호가 없다");
  const state = readFileSync(join(workDirOf(env.TF_WORK_DIR, MID, "t-11111111"), "db-writer.json"), "utf8");
  assert.equal(state.includes(PW), false, "상태 파일에 비밀번호가 없다");

  const cut = await reapplyDbWriter(input, "target", { env, runner: f.runner });
  assert.equal(cut.ok, true, JSON.stringify(cut));
  assert.equal(writer(f.seen[1]!.vars).active, "target");
  assert.equal(f.seen[1]!.o?.keepOnFail, true, "다시 apply 가 실패해도 도착을 지우지 않는다");
  const back = await reapplyDbWriter(input, "source", { env, runner: f.runner });
  assert.equal(back.ok, true);
  assert.equal(writer(f.seen[2]!.vars).active, "source");
  // 컷오버 막기: 상태가 있으면 Terraform 실행 방식도 진행
  assert.equal(cutoverAppLinkBlock({ on: true, proxy: false, appKind: "terraform_runtime", bundle: false, runtimeReady: true }), null);
});

test("PF-E35 거부: 출발 경로가 없으면 apply 를 안 돌리고 APP_LINK_SOURCE_MISSING, apply 상태 없이 다시 apply 는 APP_LINK_STATE_MISSING", async () => {
  const env = { ...baseEnv(), APP_LINK_SOURCE_URL: "" };
  const f = fakeRunner();
  const r = await realApply(input, { env, runner: f.runner, putSecret: async () => { throw new Error("must not be called"); } });
  assert.equal(r.ok, false);
  assert.equal((r as { failureCode: string }).failureCode, "APP_LINK_SOURCE_MISSING");
  assert.equal(f.seen.length, 0);
  const re = await reapplyDbWriter(input, "target", { env, runner: f.runner });
  assert.equal(re.ok, false);
  assert.equal((re as { failureCode: string }).failureCode, "APP_LINK_STATE_MISSING");
  assert.match(String(cutoverAppLinkBlock({ on: true, proxy: false, appKind: "terraform_runtime", bundle: true, runtimeReady: false })), /db-writer\.json/);
  // 끄면(시험 전용) 예전처럼 db_writer_json 없이 apply
  const off = fakeRunner();
  const r2 = await realApply(input, { env: { ...env, APP_LINK: "0" }, runner: off.runner });
  assert.equal(r2.ok, true);
  assert.equal(off.seen[0]!.vars.db_writer_json, undefined);
});
