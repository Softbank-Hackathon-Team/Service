// sandbox_runs 저장소 DB 시험 (db 0046). DATABASE_URL·OWNER_DATABASE_URL 이 없으면 건너뛴다.
// 리허설 작업 한 건: queued → running → passed 결과 + 감사 + 기다리던 deploy 작업 깨우기, 남의 회사 줄은 안 보임, 워커가 먼저 닫으면 덮어쓰지 않음.
// 기한은 둘: 줄 서기 기한(워커가 넣을 때) 안에만 잡고, 잡으면서 실행 기한 = 지금 + runBudgetSec
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let agent: typeof import("@svc/agent");
let h: typeof import("../src/handle-rehearsal.js");
let st: typeof import("../src/pg-sandbox-run-store.js");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID(), S = randomUUID(), G = randomUUID();

const input = (sha: string) => ({
  version: 1, target: "aws-eks", app: "shop", namespace: "app-shop", bundleSha256: sha, k8sMinor: "1.35",
  original: [{ path: "m.yaml", yaml: JSON.stringify({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cfg" } }) }],
  apply: [{ path: "m.yaml", yaml: JSON.stringify({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" },
    spec: { selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image: "x" }] } } } }) }],
  images: [], imagesMirrored: true, runBudgetSec: 300, databases: [], targetPodSecurity: "privileged", targetQuota: null, edges: [],
  fidelity: { version: 1, target: "aws-eks", bundleSha256: sha, items: [{ id: "manifests", status: "identical", real: "a", sandbox: "a", reason: "r", refs: [] }] },
});

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  agent = await import("@svc/agent");
  h = await import("../src/handle-rehearsal.js");
  st = await import("../src/pg-sandbox-run-store.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await core.startBoss();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-rehearsal'), ($2, 'test-rehearsal-other')", [T, OTHER]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'aws','g','connected')`, [S, G, T]);
});
after(async () => { if (skip) return; await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end(); });

// queuedAgoSec: 줄을 선 지 몇 초 지났나 (앞 리허설이 길어 줄에서 기다린 시간). 줄 서기 기한은 넣은 때 + 60분
async function queuedRun(queuedAgoSec = 0) {
  const m = randomUUID(), id = randomUUID();
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'deploying')`, [m, T, S, G]);
  await owner.query(`INSERT INTO sandbox_runs (id, tenant_id, migration_id, epoch, status, bundle_sha256, input, created_at, deadline_at)
    VALUES ($1,$2,$3,1,'queued',$4,$5, now() - make_interval(secs => $6), now() - make_interval(secs => $6) + interval '60 minutes')`,
    [id, T, m, "e".repeat(64), JSON.stringify(input("e".repeat(64))), queuedAgoSec]);
  // 워커 deploy 작업이 RetryLater 로 10분 뒤에 다시 보도록 미뤄 둔 모양
  await core.boss.send("deploy", { tenantId: T, requestId: randomUUID(), migrationId: m }, { singletonKey: `deploy:${m}`, startAfter: 600 });
  return { m, id };
}

test("Postgres: 리허설 결과를 쓰고(passed, phase done, 지운 때) 감사 한 줄, 기다리던 deploy 작업을 바로 깨운다", { skip }, async () => {
  const { m, id } = await queuedRun();
  const phases: string[] = [];
  const store = st.pgSandboxRunStore();
  const r = await h.handleRehearsal({ tenantId: T, requestId: "r1", sandboxRunId: id }, {
    store: { ...store, phase: async (t, i, p) => { phases.push(p); await store.phase(t, i, p); } },
    rehearse: async (i, run) => { await run.onPhase?.("creating"); await run.onPhase?.("checking"); return agent.mockRehearsalResult(i, run.id, "pass"); },
  });
  assert.deepEqual(r, { skipped: false, status: "passed", failureCode: null, woken: 1 });
  const row = (await owner.query("SELECT * FROM sandbox_runs WHERE id = $1", [id])).rows[0];
  assert.equal(row.status, "passed");
  assert.equal(row.phase, "done");
  assert.equal(row.failure_code, null);
  assert.equal(row.sandbox_name, agent.sandboxName("rehearsal", id));
  assert.ok(row.started_at && row.finished_at && row.deleted_at);
  assert.equal(row.result.sandbox.mock, true);
  assert.deepEqual(phases, ["creating", "checking"]);
  const audit = (await owner.query("SELECT action, result, detail FROM audit_events WHERE tenant_id = $1 AND target = $2", [T, m])).rows;
  assert.deepEqual(audit.map((a) => [a.action, a.result, a.detail.sandboxRunId]), [["sandbox.rehearsal", "ok", id]]);
  const job = (await owner.query(`SELECT start_after <= now() AS due FROM pgboss.job WHERE name = 'deploy' AND singleton_key = $1`, [`deploy:${m}`])).rows;
  assert.deepEqual(job, [{ due: true }]);
  // 같은 작업이 또 오면 아무것도 안 한다
  assert.deepEqual(await h.handleRehearsal({ tenantId: T, requestId: "r2", sandboxRunId: id }, { store, rehearse: async () => { throw new Error("돌면 안 됨"); } }),
    { skipped: true, reason: "not_queued" });
});

test("Postgres: 실패 결과는 failed + 코드, 남의 회사 번호로 온 작업은 줄이 안 보인다", { skip }, async () => {
  const { id } = await queuedRun();
  const store = st.pgSandboxRunStore();
  assert.deepEqual(await h.handleRehearsal({ tenantId: OTHER, requestId: "x", sandboxRunId: id }, { store, rehearse: async () => { throw new Error("돌면 안 됨"); } }),
    { skipped: true, reason: "missing" });
  const r = await h.handleRehearsal({ tenantId: T, requestId: "r", sandboxRunId: id }, { store, rehearse: async (i, run) => agent.mockRehearsalResult(i, run.id, "fail") });
  assert.deepEqual([r.skipped, !r.skipped && r.status, !r.skipped && r.failureCode], [false, "failed", "REHEARSAL_CRASHLOOP"]);
  const row = (await owner.query("SELECT status, failure_code FROM sandbox_runs WHERE id = $1", [id])).rows[0];
  assert.deepEqual(row, { status: "failed", failure_code: "REHEARSAL_CRASHLOOP" });
});

test("Postgres: 앞 리허설 때문에 실행 기한(300초)보다 오래 줄을 섰어도 잡으면 실행 기한 300초를 새로 받는다", { skip }, async () => {
  const { id } = await queuedRun(25 * 60);
  const store = st.pgSandboxRunStore();
  const seen: Array<Date | null | undefined> = [];
  const r = await h.handleRehearsal({ tenantId: T, requestId: "r", sandboxRunId: id }, { store, rehearse: async (i, run) => {
    seen.push(run.deadlineAt);
    return agent.mockRehearsalResult(i, run.id, "pass");
  } });
  assert.equal(r.skipped, false, JSON.stringify(r));
  const row = (await owner.query(`SELECT deadline_at, EXTRACT(EPOCH FROM deadline_at - started_at)::int AS budget FROM sandbox_runs WHERE id = $1`, [id])).rows[0];
  assert.equal(row.budget, 300, "실행 기한 = 잡은 때 + runBudgetSec");
  assert.deepEqual(seen, [row.deadline_at], "실행기는 그 기한을 받아 스스로 멈출 때를 정한다");
});

test("Postgres: 줄 서기 기한이 지난 줄은 잡지 않는다 (expired, 줄은 queued 그대로 → 워커가 REHEARSAL_TIMEOUT 으로 닫는다)", { skip }, async () => {
  const { id } = await queuedRun(61 * 60);
  const store = st.pgSandboxRunStore();
  assert.deepEqual(await h.handleRehearsal({ tenantId: T, requestId: "r", sandboxRunId: id }, { store, rehearse: async () => { throw new Error("돌면 안 됨"); } }),
    { skipped: true, reason: "expired" });
  assert.deepEqual((await owner.query("SELECT status, started_at FROM sandbox_runs WHERE id = $1", [id])).rows[0], { status: "queued", started_at: null });
});

test("Postgres: 워커가 기한으로 먼저 닫은 줄(error REHEARSAL_TIMEOUT)은 덮어쓰지 않고 expired 로 알린다", { skip }, async () => {
  const { id } = await queuedRun();
  const store = st.pgSandboxRunStore();
  const r = await h.handleRehearsal({ tenantId: T, requestId: "r", sandboxRunId: id }, { store, rehearse: async (i, run) => {
    await owner.query("UPDATE sandbox_runs SET status = 'error', phase = 'done', failure_code = 'REHEARSAL_TIMEOUT' WHERE id = $1 AND status IN ('queued','running')", [id]);
    return agent.mockRehearsalResult(i, run.id, "pass");
  } });
  assert.deepEqual(r, { skipped: true, reason: "expired" });
  const row = (await owner.query("SELECT status, failure_code, result FROM sandbox_runs WHERE id = $1", [id])).rows[0];
  assert.deepEqual(row, { status: "error", failure_code: "REHEARSAL_TIMEOUT", result: null });
});
