// G5-1 (ADR-066): provisioning 실패로 만든 도착 자원 자동 지우기 작업. 진짜 terraform·클라우드 호출 0 (가짜 exec)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let adapters: typeof import("@svc/adapters");
let job: typeof import("../src/jobs/target-destroy.js");
let slug: (t: string) => string;
let owner: pg.Client;
const T = randomUUID();
const root = mkdtempSync(join(tmpdir(), "g5-1-tf-"));

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  adapters = await import("@svc/adapters");
  job = await import("../src/jobs/target-destroy.js");
  slug = (await import("../src/gitops/bundle.js")).tenantSlug;
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-g5-1')", [T]);
});
after(async () => {
  rmSync(root, { recursive: true, force: true });
  if (skip) return;
  await core.pool.end(); await owner.end();
});

async function seed(status: string, provider = "aws") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,$4,'g','connected')`, [src, dst, T, provider]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, failed_at_status) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, T, src, dst, status, status === "failed" ? "provisioning" : null]);
  return id;
}
// apply 가 남긴 작업 폴더 모양 (<뿌리>/t-xxxxxxxx/<이전>/terraform.tfvars.json + state)
function workDir(id: string, extra: Record<string, string> = {}) {
  const d = join(root, slug(T), id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "terraform.tfvars.json"), "{}");
  writeFileSync(join(d, "main.tf"), "");
  for (const [f, v] of Object.entries(extra)) writeFileSync(join(d, f), v);
  return d;
}
// 가짜 terraform: 부른 명령을 적고 정해진 종료 코드
function fakeTf(code: (args: string[]) => number) {
  const calls: string[][] = [];
  const exec = async (_cmd: string, args: string[]) => { calls.push(args); return { code: code(args), stdout: "", stderr: "", ms: 1 }; };
  return { calls, runner: adapters.createRealTerraformRunner({ exec, workRoot: root, env: { TF_WORK_DIR: root } }) };
}
const data = (id: string) => ({ tenantId: T, requestId: "r-g5-1", migrationId: id });
const env = { TF_WORK_DIR: root };
const audits = async (id: string) => (await owner.query(
  `SELECT action, result, detail FROM audit_events WHERE target=$1 AND action LIKE 'target_teardown.%' ORDER BY seq`, [id])).rows;

test("G5-1 정상: failed(provisioning) → 그 이전 작업 폴더에서 terraform destroy -auto-approve, 감사 done(auto), 상태 failed 그대로", { skip }, async () => {
  const id = await seed("failed");
  const dir = workDir(id);
  const tf = fakeTf(() => 0);
  assert.equal(await job.handleTargetDestroy(data(id), { env, runner: tf.runner }), "destroyed");
  const destroy = tf.calls.find((a) => a.includes("destroy"));
  assert.ok(destroy, JSON.stringify(tf.calls));
  assert.ok(destroy!.includes("-auto-approve"));
  const a = await audits(id);
  assert.equal(a.at(-1).action, "target_teardown.done");
  assert.equal(a.at(-1).detail.mode, "auto");
  assert.equal(a.at(-1).detail.workDir, dir);
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "failed");
});

test("G5-1 거부: 다시 계획으로 움직인 이전(prechecking)은 지우지 않는다 (새 apply 가 같은 폴더를 쓴다)", { skip }, async () => {
  const id = await seed("prechecking");
  workDir(id);
  const tf = fakeTf(() => 0);
  assert.equal(await job.handleTargetDestroy(data(id), { env, runner: tf.runner }), "skipped");
  assert.equal(tf.calls.length, 0);
  assert.equal((await audits(id)).at(-1).action, "target_teardown.skipped");
});

test("G5-1 거부: destroy 실패 → 감사 failed(error, 사람 명령 힌트) + 늦춰 다시 넣기 (PF FM-ORC-12)", { skip }, async () => {
  const id = await seed("failed");
  workDir(id);
  const tf = fakeTf((a) => (a.includes("destroy") ? 1 : 0));
  const sent: number[] = [];
  const requeue = async (_j: unknown, sec: number) => { sent.push(sec); };
  assert.equal(await job.handleTargetDestroy(data(id), { env, runner: tf.runner, requeue }), "retrying");
  const all = await audits(id);
  const f = all.find((x: { action: string }) => x.action === "target_teardown.failed");
  assert.equal(f.result, "error");
  assert.match(f.detail.hint, /tf:real -- destroy/);
  assert.equal(all.at(-1).action, "target_teardown.retry_scheduled");
  assert.deepEqual(sent, [60]);
});

test("PF FM-ORC-12·25 거부: 실패가 이어지면 1·2·5…분으로 늘려 다시 넣고, 다 쓰면 gave_up(error) 하고 더 안 넣음", { skip }, async () => {
  const id = await seed("failed");
  workDir(id);
  const tf = fakeTf((a) => (a.includes("destroy") ? 1 : 0));
  const sent: number[] = [];
  const requeue = async (_j: unknown, sec: number) => { sent.push(sec); };
  const e2 = { ...env, TEARDOWN_RETRY_SEC: "60,120,300" };
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(await job.handleTargetDestroy(data(id), { env: e2, runner: tf.runner, requeue }));
  assert.deepEqual(outs, ["retrying", "retrying", "retrying", "gave_up"]);
  assert.deepEqual(sent, [60, 120, 300]);
  const last = (await audits(id)).at(-1);
  assert.equal(last.action, "target_teardown.gave_up");
  assert.equal(last.result, "error");
  assert.deepEqual(job.teardownRetrySec({}), [60, 120, 300, 600, 1200, 1200, 1200]);
});

test("G5-1: 작업 폴더 없음(terraform 시작 전 실패) → 지울 것 없음 / 가져온 기존 자원(imported.json)은 안 지움", { skip }, async () => {
  const none = await seed("failed");
  const tf = fakeTf(() => 0);
  assert.equal(await job.handleTargetDestroy(data(none), { env, runner: tf.runner }), "nothing");
  assert.equal(tf.calls.length, 0);
  const imp = await seed("failed");
  workDir(imp, { "imported.json": JSON.stringify({ source: "discover", tfOutputs: {}, resources: [] }) });
  assert.equal(await job.handleTargetDestroy(data(imp), { env, runner: tf.runner }), "nothing");
  assert.equal(tf.calls.length, 0, "가져온 자원에 destroy 를 부르지 않는다");
  assert.equal((await audits(imp)).at(-1).detail.imported, true);
});

test("G5-1: 흉내(MOCK_IAC=1)는 stub 감사만, 실행기 안 만듦", { skip }, async () => {
  const id = await seed("cancelled");
  assert.equal(await job.handleTargetDestroy(data(id), { env: { MOCK_IAC: "1", TF_WORK_DIR: root } }), "stub");
  assert.equal((await audits(id)).at(-1).detail.stub, true);
});

test("PF FM-ORC-07 거부: terraform 실행 자체가 예외(명령 없음 등)여도 감사 target_teardown.failed 가 남고 늦춰 다시", { skip }, async () => {
  const id = await seed("failed");
  workDir(id);
  const runner = { destroy: async () => { throw new Error("spawn terraform ENOENT"); } };
  assert.equal(await job.handleTargetDestroy(data(id), { env, runner: runner as never, requeue: async () => {} }), "retrying");
  const a = (await audits(id)).find((x: { action: string }) => x.action === "target_teardown.failed");
  assert.match(a.detail.error, /ENOENT/);
});

test("PF FM-OPS-05 거부: apply 가 작업 폴더를 적었는데 지금 못 찾으면(TF_WORK_DIR 다름) '지울 것 없음'이 아니라 failed + 경로 힌트", { skip }, async () => {
  const id = await seed("failed");
  await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "apply.failed", target: id, result: "ok",
    detail: { workDir: `/elsewhere/${slug(T)}/${id}`, failureCode: "TF_APPLY_FAILED" } }));
  const tf = fakeTf(() => 0);
  assert.equal(await job.handleTargetDestroy(data(id), { env, runner: tf.runner }), "missing");
  assert.equal(tf.calls.length, 0);
  const a = (await audits(id)).at(-1);
  assert.equal(a.action, "target_teardown.failed");
  assert.match(a.detail.recordedWorkDir, /elsewhere/);
});

test("PF FM-ORC-P01: destroy 실패 원인 갈래 — 삭제 보호는 재시도 없이 blocked + 힌트, 잠금은 재시도(예외)", { skip }, async () => {
  assert.equal(job.destroyFailureCause(["Error: cannot destroy instance without setting deletion_protection=false"]), "DELETION_PROTECTED");
  assert.equal(job.destroyFailureCause(["Error: InvalidParameterCombination: Cannot delete protected DB Instance"]), "DELETION_PROTECTED");
  assert.equal(job.destroyFailureCause(["Error: Error acquiring the state lock"]), "STATE_LOCKED");
  assert.equal(job.destroyFailureCause(["AccessDenied: not authorized to perform rds:DeleteDBInstance"]), "ACCESS_DENIED");
  assert.equal(job.destroyFailureCause(["boom"]), "TF_DESTROY_FAILED");
  const id = await seed("failed");
  workDir(id);
  const exec = async (_c: string, args: string[]) => args.includes("destroy")
    ? { code: 1, stdout: "", stderr: "Error: cannot destroy instance without setting deletion_protection=false", ms: 1 }
    : { code: 0, stdout: "", stderr: "", ms: 1 };
  const runner = adapters.createRealTerraformRunner({ exec, workRoot: root, env: { TF_WORK_DIR: root } });
  assert.equal(await job.handleTargetDestroy(data(id), { env, runner }), "blocked");
  const a = (await audits(id)).at(-1);
  assert.equal(a.detail.cause, "DELETION_PROTECTED");
  assert.match(a.detail.hint, /DB_DISPOSABLE/);
});
