// DB 시험: deploy 리허설 문 (설계 2.2·2.5·2.8). 진짜 handleDeploy + 진짜 GitopsRepo(git) + 진짜 sandbox_runs·pg-boss.
//   gitops 레포는 시험이 만든 작은 레포다 (tools/render.mjs 가 값으로 매니페스트를 쓰고 지문을 plan.json 에, validate 는 통과).
//   agent-worker(PR4) 자리는 completeAsAgentWorker 가 한다: 결과 줄 쓰기 + core wakeQueued 로 deploy 작업 깨우기 (같은 트랜잭션)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let adapters: typeof import("@svc/adapters");
let contracts: typeof import("@svc/contracts");
let dp: typeof import("../src/jobs/deploy.js");
let planV2: typeof import("../src/jobs/plan-v2.js");
let step: typeof import("../src/jobs/_step.js");
let owner: pg.Client;
let gitDir = "";
const T = randomUUID();
const KEYS = ["MOCK_IAC", "MOCK_ARGO", "GITOPS_DISABLE", "GITOPS_REPO_DIR", "GITOPS_REPO_URL", "GITOPS_PUSH", "STUB_DELAY_MS",
  "SANDBOX_REHEARSAL", "MOCK_SANDBOX", "SANDBOX_IMAGE_REGISTRY", "REHEARSAL_POLL_SEC", "REHEARSAL_TIMEOUT_SEC", "REHEARSAL_QUEUE_TIMEOUT_SEC"];
const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
type Raw = Record<string, any>;

// 작은 gitops 레포: 계약(WORKER-CONTRACT) 의 파일 자리만 같고 렌더는 값에서 바로 만든다. tools/extra.json 의 문서를 더 그린다 (차트 바뀜 흉내)
const RENDER = `import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
const root = new URL("..", import.meta.url).pathname;
const dir = resolve(root, process.argv[2]);
const values = JSON.parse(readFileSync(join(dir, "values.yaml"), "utf8"));
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const extraFile = join(root, "tools", "extra.json");
const extra = existsSync(extraFile) ? JSON.parse(readFileSync(extraFile, "utf8")) : [];
const ns = plan.target.namespace;
const docs = [];
for (const w of values.workloads ?? []) if (w.kind !== "job")
  docs.push({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: w.name, namespace: ns },
    spec: { replicas: w.replicas ?? 1, selector: { matchLabels: { app: w.name } },
      template: { metadata: { labels: { app: w.name } }, spec: { containers: [{ name: "app", image: w.image, env: w.env ?? [] }] } } } });
for (const s of values.externalSecrets?.secrets ?? [])
  docs.push({ apiVersion: "external-secrets.io/v1", kind: "ExternalSecret", metadata: { name: s.name, namespace: ns },
    spec: { target: { name: s.name }, data: (s.keys ?? []).map((k) => ({ secretKey: k, remoteRef: { key: s.remoteKey, property: k } })) } });
for (const d of extra) docs.push({ ...d, metadata: { ...d.metadata, namespace: ns } });
const md = join(dir, "manifests");
rmSync(md, { recursive: true, force: true }); mkdirSync(md, { recursive: true });
const files = docs.map((d) => ({ name: d.kind.toLowerCase() + "-" + d.metadata.name + ".yaml", text: JSON.stringify(d, null, 2) + "\\n" }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));
for (const f of files) writeFileSync(join(md, f.name), f.text);
plan.bundleSha256 = createHash("sha256").update(files.map((f) => f.name + "\\0" + f.text).join("\\0")).digest("hex");
writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2) + "\\n");
`;
const git = (...a: string[]) => execFileSync("git", ["-C", gitDir, "-c", "user.name=t", "-c", "user.email=t@x", ...a], { encoding: "utf8" }).trim();
function makeGitopsRepo() {
  gitDir = mkdtempSync(join(tmpdir(), "rehearsal-gate-gitops-"));
  for (const d of ["tools/node_modules", "charts/app", "platform"]) mkdirSync(join(gitDir, d), { recursive: true });
  writeFileSync(join(gitDir, "tools", "render.mjs"), RENDER);
  writeFileSync(join(gitDir, "tools", "validate.mjs"), "process.exit(0);\n");
  writeFileSync(join(gitDir, "tools", "extra.json"), "[]\n");
  writeFileSync(join(gitDir, "charts", "app", "Chart.yaml"), "apiVersion: v2\nname: app\nversion: 0.4.0\n");
  writeFileSync(join(gitDir, "platform", "project-platform-root.yaml"), "spec:\n  sourceRepos:\n    - https://example.invalid/gitops.git\n");
  writeFileSync(join(gitDir, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["init", "-q", "-b", "main", gitDir]);
  git("add", "-A"); git("commit", "-q", "-m", "seed");
}
const setExtra = (docs: unknown[]) => { writeFileSync(join(gitDir, "tools", "extra.json"), JSON.stringify(docs) + "\n"); git("commit", "-q", "-am", "chart change"); };

before(async () => {
  if (skip) return;
  makeGitopsRepo();
  Object.assign(process.env, { STUB_DELAY_MS: "5", MOCK_IAC: "1", MOCK_ARGO: "1", GITOPS_REPO_DIR: gitDir, GITOPS_PUSH: "0", REHEARSAL_POLL_SEC: "30" });
  delete process.env.GITOPS_DISABLE; delete process.env.GITOPS_REPO_URL;
  core = await import("@svc/core");
  adapters = await import("@svc/adapters");
  contracts = await import("@svc/contracts");
  dp = await import("../src/jobs/deploy.js");
  planV2 = await import("../src/jobs/plan-v2.js");
  step = await import("../src/jobs/_step.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-rehearsal-gate')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id = $1", [T]);
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
  rmSync(gitDir, { recursive: true, force: true });
});

type Kind = "k8s" | "ecs";
/** deploying 이전 하나: k8s(GKE 데모) 또는 ECS 출발 → dst 도착. k8s 는 계획 Helm 값 지문을 진짜로 (approvedValues 를 지나야 렌더한다) */
async function seed(o: { kind?: Kind; dst?: "aws" | "gcp" | "azure_mock"; outputs?: (x: Record<string, string>) => Record<string, string> } = {}) {
  const kind = o.kind ?? "k8s", dst = o.dst ?? "aws";
  const id = randomUUID(), s = randomUUID(), d = randomUUID(), planId = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'gcp','s','connected'), ($2,$3,$4,'d','connected')`, [s, d, T, dst]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'deploying')`, [id, T, s, d]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at) VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [s, d, T, id]);
  const raw = structuredClone(adapters.normalizeV2(adapters.DEMO_INVENTORY[kind === "k8s" ? "gcp" : "aws"]!).result);
  // Azure Mock 도착은 신원 1개만 그린다 → 서비스 하나짜리 명세 (demo-one.ts)
  const result = contracts.ImportResultV2.parse(dst === "azure_mock" ? { ...raw, spec: (await import("./demo-one.js")).ONE } : raw);
  const base = { ...adapters.STUB_TF_OUTPUTS, ...adapters.stubTfOutputsV2(result.spec) };
  const helmValuesHash = kind === "k8s"
    ? step.stableHash(planV2.helmValuesV2(result.spec, { envId: d, provider: dst, region: "default", migrationId: id })) : "h";
  await core.withTenant(T, async (tx) => {
    await core.saveSpecRevision(tx, { tenantId: T, migrationId: id, specV2: result });
    await core.savePlan(tx, T, contracts.PlanDoc.parse({
      planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [], rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
      tfPlanHash: "t", helmValuesHash, planHash: "p", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    await core.saveInfraReady(tx, { tenantId: T, migrationId: id, planId, tfOutputs: o.outputs ? o.outputs(base) : base, helmValuesKey: "k" });
  });
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-gate-${id.slice(0, 8)}`, migrationId: id });
const mig = async (id: string) => (await owner.query(`SELECT status, failure_code, version FROM migrations WHERE id=$1`, [id])).rows[0] as { status: string; failure_code: string | null; version: number };
const runs = async (id: string) => (await owner.query(`SELECT * FROM sandbox_runs WHERE migration_id=$1 ORDER BY epoch, created_at`, [id])).rows as Raw[];
const lastAudit = async (id: string, action: string) => (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action=$2 ORDER BY seq DESC LIMIT 1`, [id, action])).rows[0]?.detail as Raw | undefined;
const deployJobs = async (id: string) => (await owner.query(
  `SELECT state, start_after > now() + interval '20 seconds' AS later FROM pgboss.job WHERE name='deploy' AND singleton_key=$1 AND state IN ('created','retry')`, [`deploy:${id}`])).rows as Array<{ state: string; later: boolean }>;
const retryAudits = async (id: string) => (await owner.query(
  `SELECT result FROM audit_events WHERE target=$1 AND action='deploy.retry_scheduled' ORDER BY seq`, [id])).rows.map((r) => r.result as string);
const rehearsalJobs = async (runId: string) => (await owner.query(
  `SELECT singleton_key FROM pgboss.job WHERE name='sandbox-rehearsal' AND data->>'sandboxRunId' = $1`, [runId])).rows as Array<{ singleton_key: string }>;
const commits = () => Number(git("rev-list", "--count", "HEAD"));
// paused → deploying 재개 흉내 (advance 처럼 version + 1 = 새 차례). syncing 에서 되돌릴 때는 앞이 넣은 sync 작업을 지운다
async function resume(id: string) {
  await owner.query(`DELETE FROM pgboss.job WHERE name='sync' AND singleton_key=$1`, [`sync:${id}`]);
  await owner.query(`UPDATE migrations SET status='deploying', failure_code=NULL, version = version + 1 WHERE id=$1`, [id]);
}

/** agent-worker(PR4) 자리: 결과를 조건부로 쓰고 같은 트랜잭션에서 deploy 작업을 깨운다 */
async function completeAsAgentWorker(runId: string, verdict: "passed" | "failed", code: string | null = null) {
  const row = (await owner.query(`SELECT tenant_id, migration_id, input FROM sandbox_runs WHERE id=$1`, [runId])).rows[0] as Raw;
  const input = contracts.RehearsalInput.parse(row.input);
  const result = contracts.RehearsalResult.parse({
    verdict, failureCode: code,
    sandbox: { name: "sbx-test", hostNamespace: "sbx-test", chart: "vcluster-0.37.6", k8sVersion: "v1.35.0", podSecurity: "baseline", runtimeClass: null, mock: true },
    bundleSha256: input.bundleSha256,
    checks: [{ id: "rollout", subject: "Deployment/shop-api", required: true, ok: verdict === "passed", ms: 10, detail: verdict === "passed" ? "ready 1/1" : "재시작 5번 (CrashLoopBackOff)" }],
    fidelity: { ...input.fidelity, items: [...input.fidelity.items,
      { id: "sandbox_pod_security", status: "substituted", real: "도착 수준", sandbox: "baseline", reason: "r", refs: [] },
      { id: "runtime_isolation", status: "substituted", real: "도착 노드", sandbox: "같은 커널, 전용 노드", reason: "r", refs: [] }] },
    warnings: [], timingsMs: { create: 1, apply: 1, check: 1, delete: 1 }, deleted: true,
  });
  await core.withTenant(row.tenant_id, async (tx) => {
    const u = await tx.query(`UPDATE sandbox_runs SET status=$2, failure_code=$3, phase='done', sandbox_name='sbx-test', result=$4, started_at=now(), finished_at=now(), deleted_at=now()
      WHERE id=$1 AND status IN ('queued','running')`, [runId, verdict, code, JSON.stringify(result)]);
    assert.equal(u.rowCount, 1);
    await core.wakeQueued(tx, contracts.QUEUES.deploy, core.jobKey(contracts.QUEUES.deploy, { migrationId: row.migration_id })!);
  });
  return input;
}

test("끔(기본): 예전처럼 커밋 → syncing, 근거 rehearsal=disabled 와 skipped(disabled) 줄 하나, gitops detail 모양 그대로", { skip }, async () => {
  delete process.env.SANDBOX_REHEARSAL;
  const id = await seed();
  const before = commits();
  await dp.handleDeploy(job(id));
  assert.equal((await mig(id)).status, "syncing");
  assert.equal(commits(), before + 1);
  const a = (await lastAudit(id, "deploy.syncing"))!;
  assert.equal(a.evidence.rehearsal, "disabled");
  assert.equal(a.evidence.securityParity, "not_measured", "보안 동등성은 잰 근거가 없어 true 라고 하지 않는다");
  assert.ok(a.gitops.commit && a.gitops.argoApp && !("rehearsal" in a.gitops), "gitops detail 은 예전 칸 그대로");
  assert.deepEqual((await runs(id)).map((r) => [r.status, r.skip_reason, r.epoch, r.phase]), [["skipped", "disabled", (await mig(id)).version - 1, "done"]]);
});

test("켬: 줄 queued + sandbox-rehearsal 작업(회사 키) → 기다림(RetryLater), 두 번 배달해도 줄·작업 하나 → agent-worker 통과 + 깨우기 → 같은 지문으로 커밋 → syncing(passed)", { skip }, async () => {
  Object.assign(process.env, { SANDBOX_REHEARSAL: "on", MOCK_SANDBOX: "1" });
  const id = await seed();
  const c0 = commits();
  assert.equal(await dp.handleDeploy(job(id)), "skipped");
  assert.equal((await mig(id)).status, "deploying");
  const [run] = await runs(id);
  assert.equal(run!.status, "queued");
  assert.ok(run!.deadline_at > new Date(Date.now() + 3500_000), "queued 줄의 기한 = 줄 서기 기한 REHEARSAL_QUEUE_TIMEOUT_SEC(3600)");
  assert.deepEqual([run!.input.runBudgetSec, run!.input.imagesMirrored], [1200, false], "실행 기한은 agent-worker 가 잡을 때부터, 흉내 복사는 입력에 남는다");
  assert.deepEqual(await rehearsalJobs(run!.id), [{ singleton_key: `sandbox-rehearsal:tenant:${run!.tenant_id}` }], "회사마다 키 하나 (다른 회사 리허설과 같이 돈다)");
  assert.deepEqual(await deployJobs(id), [{ state: "created", later: true }], "deploy 작업이 REHEARSAL_POLL_SEC 뒤로 다시 들어감");
  assert.deepEqual(await retryAudits(id), ["ok"], "리허설 기다림은 오류가 아니다");
  assert.equal(commits(), c0, "기다리는 동안 커밋 없음");
  assert.equal(git("status", "--porcelain"), "", "렌더 뒤 작업 복사본 되돌림");
  // 두 번 배달: 같은 줄을 보고 기다림만
  await owner.query(`DELETE FROM pgboss.job WHERE name='deploy' AND singleton_key=$1`, [`deploy:${id}`]);
  assert.equal(await dp.handleDeploy(job(id)), "skipped");
  assert.equal((await runs(id)).length, 1);
  assert.equal((await rehearsalJobs(run!.id)).length, 1);

  const input = await completeAsAgentWorker(run!.id, "passed");
  assert.deepEqual(await deployJobs(id), [{ state: "created", later: false }], "깨우기: 기다리던 deploy 작업을 지금으로");
  assert.equal(await dp.handleDeploy(job(id)), "advanced");
  assert.equal((await mig(id)).status, "syncing");
  assert.equal(commits(), c0 + 1);
  const a = (await lastAudit(id, "deploy.syncing"))!;
  assert.equal(a.evidence.rehearsal, "passed");
  assert.equal(a.rehearsal.sandboxRunId, run!.id);
  assert.equal(a.deploy.bundleHash, input.bundleSha256, "커밋한 지문 = 리허설한 지문");
  // 커밋된 바이트 = 리허설 원본 바이트
  const dir = join(gitDir, "tenants", `t-${T.replace(/-/g, "").slice(0, 8)}`, "apps", input.app, "aws-eks", "manifests");
  assert.deepEqual(readdirSync(dir).sort().map((n) => ({ path: `manifests/${n}`, yaml: readFileSync(join(dir, n), "utf8") })), input.original);
  // 같은 계획·같은 지문으로 재개(새 차례) → 재사용 줄, 새 리허설 없음
  await resume(id);
  assert.equal(await dp.handleDeploy(job(id)), "advanced");
  const all = await runs(id);
  assert.equal(all.length, 2);
  assert.deepEqual([all[1]!.status, all[1]!.reused_from, all[1]!.phase], ["passed", run!.id, "done"]);
  assert.equal((await lastAudit(id, "deploy.syncing"))!.evidence.rehearsal, "reused");
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE name='sandbox-rehearsal' AND data->>'sandboxRunId' = $1`, [all[1]!.id])).rows[0].n, 0);
});

test("켬: 리허설 실패 → paused + 줄의 코드, detail 에 실패한 검사. 재개하면 새 차례에서 처음부터", { skip }, async () => {
  Object.assign(process.env, { SANDBOX_REHEARSAL: "on", MOCK_SANDBOX: "1" });
  const id = await seed();
  const c0 = commits();
  await dp.handleDeploy(job(id));
  const [run] = await runs(id);
  await completeAsAgentWorker(run!.id, "failed", "REHEARSAL_CRASHLOOP");
  await dp.handleDeploy(job(id));
  assert.deepEqual([(await mig(id)).status, (await mig(id)).failure_code], ["paused", "REHEARSAL_CRASHLOOP"]);
  const a = (await lastAudit(id, "deploy.paused"))!;
  assert.deepEqual(a.rehearsal.failedChecks, [{ id: "rollout", subject: "Deployment/shop-api", detail: "재시작 5번 (CrashLoopBackOff)" }]);
  assert.match(a.deploy.reason, /rollout/);
  assert.equal(commits(), c0, "실패하면 커밋 없음");
  // 재개: 실패 줄은 재사용하지 않는다 → 새 차례 queued
  await resume(id);
  await dp.handleDeploy(job(id));
  const all = await runs(id);
  assert.deepEqual(all.map((r) => r.status), ["failed", "queued"]);
});

test("켬: 그 단계 기한(줄 서기·실행)이 지나면 error(REHEARSAL_TIMEOUT) → paused, 어느 단계였는지 남는다. 늦게 온 agent-worker 결과는 조건부 UPDATE 가 막는다", { skip }, async () => {
  Object.assign(process.env, { SANDBOX_REHEARSAL: "on", MOCK_SANDBOX: "1" });
  for (const [status, stage] of [["queued", "queue"], ["running", "run"]] as const) {
    const id = await seed();
    await dp.handleDeploy(job(id));
    const [run] = await runs(id);
    await owner.query(`UPDATE sandbox_runs SET status=$2, started_at = CASE WHEN $2 = 'running' THEN now() END, deadline_at = now() - interval '1 second' WHERE id=$1`, [run!.id, status]);
    await dp.handleDeploy(job(id));
    assert.deepEqual([(await mig(id)).status, (await mig(id)).failure_code], ["paused", "REHEARSAL_TIMEOUT"], status);
    assert.equal((await lastAudit(id, "deploy.paused"))!.rehearsal.stage, stage);
    const [after] = await runs(id);
    assert.deepEqual([after!.status, after!.failure_code, after!.phase], ["error", "REHEARSAL_TIMEOUT", "done"], status);
    const late = await owner.query(`UPDATE sandbox_runs SET status='passed' WHERE id=$1 AND status IN ('queued','running')`, [run!.id]);
    assert.equal(late.rowCount, 0);
  }
});

test("켬: 앞 리허설 때문에 실행 기한(300초)보다 오래 줄을 서도 줄 서기 기한 안이면 REHEARSAL_TIMEOUT 이 아니라 계속 기다린다", { skip }, async () => {
  Object.assign(process.env, { SANDBOX_REHEARSAL: "on", MOCK_SANDBOX: "1", REHEARSAL_TIMEOUT_SEC: "300", REHEARSAL_QUEUE_TIMEOUT_SEC: "3600" });
  try {
    const id = await seed();
    await dp.handleDeploy(job(id));
    const [run] = await runs(id);
    // 10분이 지났다 (앞 회사 리허설이 도는 동안 줄에서 기다림)
    await owner.query(`UPDATE sandbox_runs SET created_at = created_at - interval '600 seconds', deadline_at = deadline_at - interval '600 seconds' WHERE id=$1`, [run!.id]);
    await owner.query(`DELETE FROM pgboss.job WHERE name='deploy' AND singleton_key=$1`, [`deploy:${id}`]);
    assert.equal(await dp.handleDeploy(job(id)), "skipped");
    assert.deepEqual([(await mig(id)).status, (await runs(id))[0]!.status], ["deploying", "queued"]);
    assert.deepEqual(await deployJobs(id), [{ state: "created", later: true }]);
  } finally {
    delete process.env.REHEARSAL_TIMEOUT_SEC; delete process.env.REHEARSAL_QUEUE_TIMEOUT_SEC;
  }
});

test("켬: 리허설이 넣자마자 끝나도 기다리던 deploy 작업을 깨운다 (줄·작업·다시 넣는 deploy 작업이 한 트랜잭션)", { skip }, async () => {
  Object.assign(process.env, { SANDBOX_REHEARSAL: "on", MOCK_SANDBOX: "1" });
  const id = await seed();
  // 워커를 다시 넣기 트랜잭션 안(감사 쓰기의 회사 잠금)에 세워 둔다. 그동안 줄이 보이면 agent-worker 가 바로 끝내고 깨운다
  const lock = new pg.Client({ connectionString: OWNER }); await lock.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('audit:' || $1))", [T]);
    const worker = dp.handleDeploy(job(id));
    for (let i = 0; ; i++) {
      const waiting = await owner.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND objid::bigint = (hashtext('audit:' || $1)::bigint & 4294967295)`, [T]);
      if (waiting.rowCount) break;
      assert.ok(i < 400, "워커가 감사 잠금에서 기다려야 한다");
      await new Promise((r) => setTimeout(r, 25));
    }
    const [early] = await runs(id);
    if (early) await completeAsAgentWorker(early.id, "passed");
    await lock.query("SELECT pg_advisory_unlock(hashtext('audit:' || $1))", [T]);
    assert.equal(await worker, "skipped");
    const [run] = await runs(id);
    if (run!.status === "queued") await completeAsAgentWorker(run!.id, "passed");
    assert.deepEqual(await deployJobs(id), [{ state: "created", later: false }], "결과를 쓴 뒤 deploy 작업이 바로 돈다 (REHEARSAL_POLL_SEC 를 기다리지 않음)");
  } finally {
    await lock.end();
  }
  assert.equal(await dp.handleDeploy(job(id)), "advanced");
  assert.equal((await mig(id)).status, "syncing");
});

test("켬: 통과 뒤 차트가 바뀌어 커밋 직전 렌더가 다르면 커밋하지 않고 REHEARSAL_BUNDLE_MISMATCH", { skip }, async () => {
  Object.assign(process.env, { SANDBOX_REHEARSAL: "on", MOCK_SANDBOX: "1" });
  const id = await seed();
  await dp.handleDeploy(job(id));
  const [run] = await runs(id);
  await completeAsAgentWorker(run!.id, "passed");
  setExtra([{ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "late-change" }, data: { a: "1" } }]);
  const c0 = commits();
  await dp.handleDeploy(job(id));
  assert.deepEqual([(await mig(id)).status, (await mig(id)).failure_code], ["paused", "REHEARSAL_BUNDLE_MISMATCH"]);
  assert.equal(commits(), c0);
  assert.equal(git("status", "--porcelain"), "");
  setExtra([]);
});

test("켬: 치환 표 밖 종류 → failed(REHEARSAL_UNSUPPORTED_KIND), 이미지 복사 실패 → error(REHEARSAL_IMAGE_MIRROR_FAILED). 둘 다 paused, 작업 없음", { skip }, async () => {
  Object.assign(process.env, { SANDBOX_REHEARSAL: "on", MOCK_SANDBOX: "1" });
  // NetworkPolicy 는 온프레 DB 이전 터널 때문에 표에 들어왔다 → 표 밖 종류의 예는 Role
  setExtra([{ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "deny" }, rules: [] }]);
  const a = await seed();
  await dp.handleDeploy(job(a));
  assert.deepEqual([(await mig(a)).status, (await mig(a)).failure_code], ["paused", "REHEARSAL_UNSUPPORTED_KIND"]);
  assert.deepEqual((await runs(a)).map((r) => [r.status, r.failure_code, r.phase]), [["failed", "REHEARSAL_UNSUPPORTED_KIND", "done"]]);
  assert.match((await lastAudit(a, "deploy.paused"))!.deploy.reason, /Role\/(.*\/)?deny/);
  setExtra([]);
  // 진짜 복사 길인데 샌드박스 레지스트리 설정이 없음
  delete process.env.MOCK_SANDBOX; delete process.env.SANDBOX_IMAGE_REGISTRY;
  const b = await seed();
  await dp.handleDeploy(job(b));
  assert.deepEqual([(await mig(b)).status, (await mig(b)).failure_code], ["paused", "REHEARSAL_IMAGE_MIRROR_FAILED"]);
  assert.deepEqual((await runs(b)).map((r) => [r.status, r.failure_code, r.phase]), [["error", "REHEARSAL_IMAGE_MIRROR_FAILED", "done"]]);
  const pb = (await lastAudit(b, "deploy.paused"))!;
  assert.equal(pb.rehearsal.mirror.reason, "registry_unset");
  // 멈춤 화면용 고칠 자리 (deploy 칸의 error·reason 옆): 차트 값 이름 + 고칠 길
  assert.deepEqual(pb.deploy.missing, ["helm: sandbox.imageRegistry"]);
  assert.match(pb.deploy.hint, /SANDBOX_IMAGE_REGISTRY/);
});

/** agent-worker 가 결과 없이 끝낸 줄 (입력 거부·처리기 오류): 이유는 감사 sandbox.rehearsal 에만 남는다 (agent-worker pg-sandbox-run-store finish 와 같은 모양) */
async function errorAsAgentWorker(runId: string, reason: string) {
  const row = (await owner.query(`SELECT tenant_id, migration_id FROM sandbox_runs WHERE id=$1`, [runId])).rows[0] as Raw;
  await core.withTenant(row.tenant_id, async (tx) => {
    const u = await tx.query(`UPDATE sandbox_runs SET status='error', failure_code='REHEARSAL_SANDBOX_UNAVAILABLE', phase='done', finished_at=now()
      WHERE id=$1 AND status IN ('queued','running')`, [runId]);
    assert.equal(u.rowCount, 1);
    await core.writeAudit(tx, row.tenant_id, { actor: "agent_worker", action: "sandbox.rehearsal", target: row.migration_id, result: "error",
      detail: { sandboxRunId: runId, status: "error", failureCode: "REHEARSAL_SANDBOX_UNAVAILABLE", reason } });
    await core.wakeQueued(tx, contracts.QUEUES.deploy, core.jobKey(contracts.QUEUES.deploy, { migrationId: row.migration_id })!);
  });
}
/** agent-worker 가 샌드박스를 못 띄운 결과 (sandbox_ready 실패 줄 하나) */
async function sandboxNotReady(runId: string, code: "REHEARSAL_SANDBOX_UNAVAILABLE" | "REHEARSAL_IMAGE_MIRROR_FAILED", detail: string) {
  const row = (await owner.query(`SELECT tenant_id, migration_id, input FROM sandbox_runs WHERE id=$1`, [runId])).rows[0] as Raw;
  const input = contracts.RehearsalInput.parse(row.input);
  const result = contracts.RehearsalResult.parse({
    verdict: "error", failureCode: code,
    sandbox: { name: "sbx-test", hostNamespace: "sbx-test", chart: "vcluster-0.37.6", k8sVersion: "", podSecurity: "baseline", runtimeClass: null, mock: false },
    bundleSha256: input.bundleSha256,
    checks: [{ id: "sandbox_ready", subject: "sbx-test", required: true, ok: false, ms: 0, detail }],
    fidelity: input.fidelity, warnings: [], timingsMs: { create: 0, apply: 0, check: 0, delete: 0 }, deleted: false,
  });
  await core.withTenant(row.tenant_id, async (tx) => {
    await tx.query(`UPDATE sandbox_runs SET status='error', failure_code=$2, phase='done', result=$3, finished_at=now() WHERE id=$1`, [runId, code, JSON.stringify(result)]);
    await core.wakeQueued(tx, contracts.QUEUES.deploy, core.jobKey(contracts.QUEUES.deploy, { migrationId: row.migration_id })!);
  });
}

test("agent-worker 쪽 설정 없음: 호스트 클러스터 없음(SANDBOX_NO_HOST)·워커가 이미지를 안 복사한 입력은 paused + deploy 칸 missing·hint, 결과 없는 끝은 감사의 이유를 그대로", { skip }, async () => {
  Object.assign(process.env, { SANDBOX_REHEARSAL: "on", MOCK_SANDBOX: "1" });
  const cases: Array<[string, (runId: string) => Promise<void>, (d: Raw) => void]> = [
    ["no_host", (r) => sandboxNotReady(r, "REHEARSAL_SANDBOX_UNAVAILABLE", "SANDBOX_NO_HOST: 호스트 클러스터 접속 설정이 없음 (SANDBOX_KUBE_URL 또는 클러스터 안 실행)"), (d) => {
      assert.equal(d.error, "REHEARSAL_SANDBOX_UNAVAILABLE");
      assert.match(d.reason, /SANDBOX_NO_HOST/);
      assert.deepEqual(d.missing, ["SANDBOX_KUBE_URL"]);
      assert.match(d.hint, /sandbox\.enabled/);
    }],
    ["not_mirrored", (r) => sandboxNotReady(r, "REHEARSAL_IMAGE_MIRROR_FAILED", "이미지를 플랫폼 샌드박스 자리로 복사하지 않은 입력 (워커 MOCK_SANDBOX=1)"), (d) => {
      assert.equal(d.error, "REHEARSAL_IMAGE_MIRROR_FAILED");
      assert.deepEqual(d.missing, ["helm: sandbox.imageRegistry"]);
      assert.match(d.hint, /워커 MOCK_SANDBOX 를 끄고/);
    }],
    ["no_result", (r) => errorAsAgentWorker(r, "리허설 입력이 계약에 안 맞음: images.0.ref Invalid"), (d) => {
      assert.equal(d.reason, "리허설 error (REHEARSAL_SANDBOX_UNAVAILABLE): 리허설 입력이 계약에 안 맞음: images.0.ref Invalid", "예전엔 코드 자리표시만");
      assert.equal(d.missing, undefined, "설정 문제로 단정하지 않는다");
    }],
  ];
  for (const [name, finish, check] of cases) {
    const id = await seed();
    await dp.handleDeploy(job(id));
    const [run] = await runs(id);
    await finish(run!.id);
    await dp.handleDeploy(job(id));
    assert.equal((await mig(id)).status, "paused", name);
    check((await lastAudit(id, "deploy.paused"))!.deploy);
  }
});

test("켬: 건너뜀 표 — ECS 도착 non_k8s, 클러스터 없음 no_cluster, Azure Mock unsupported_target, GitOps 없이 MOCK_ARGO 흉내 mock. 모두 syncing + 근거", { skip }, async () => {
  Object.assign(process.env, { SANDBOX_REHEARSAL: "on", MOCK_SANDBOX: "1" });
  const cases: Array<[string, () => Promise<string>, () => void]> = [
    ["non_k8s", () => seed({ kind: "ecs" }), () => undefined],
    ["no_cluster", () => seed({ outputs: (x) => ({ ...x, cluster_name: "" }) }), () => undefined],
    ["unsupported_target", () => seed({ dst: "azure_mock" }), () => undefined],
    ["mock", () => seed(), () => { delete process.env.GITOPS_REPO_DIR; }],
  ];
  for (const [want, make, env] of cases) {
    env();
    const id = await make();
    await dp.handleDeploy(job(id));
    const m = await mig(id);
    assert.equal(m.status, "syncing", `${want}: ${m.failure_code} ${JSON.stringify((await lastAudit(id, "deploy.paused"))?.deploy)}`);
    assert.equal((await lastAudit(id, "deploy.syncing"))!.evidence.rehearsal, want);
    assert.deepEqual((await runs(id)).map((r) => [r.status, r.skip_reason, r.phase]), [["skipped", want, "done"]]);
  }
  process.env.GITOPS_REPO_DIR = gitDir;
});
