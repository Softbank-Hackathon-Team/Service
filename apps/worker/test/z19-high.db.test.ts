// DB 시험(작업 Z19): 코드 리뷰 Z10 높음 H1·H3·H4 재현 → 고친 뒤 통과.
// H2(컷오버 울타리)는 진짜 복제 DB가 필요해서 packages/replication/test/z19-switchover.it.ts, H5는 packages/traffic/test/z19-controller.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let step: typeof import("../src/jobs/_step.js");
let shift: typeof import("../src/jobs/shift.js");
let sync: typeof import("../src/jobs/sync.js");
let plan: typeof import("../src/jobs/plan.js");
let rollback: typeof import("../src/jobs/rollback.js");
let platform: typeof import("../src/platform.js");
let adapters: typeof import("@svc/adapters");
let owner: pg.Client;
const T = randomUUID();
const audit = { actor: "test", action: "t", target: "t", result: "ok" as const };

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "50";
  process.env.TRAFFIC_TICK_MS = "5";
  // 다른 시험 파일의 워커가 다시 넣은 sync 작업을 먼저 집지 않게 대기를 길게 (값 자체는 아래에서 확인)
  process.env.SYNC_RETRY_DELAYS_SEC = "600,601,602";
  core = await import("@svc/core");
  step = await import("../src/jobs/_step.js");
  shift = await import("../src/jobs/shift.js");
  sync = await import("../src/jobs/sync.js");
  plan = await import("../src/jobs/plan.js");
  rollback = await import("../src/jobs/rollback.js");
  platform = await import("../src/platform.js");
  adapters = await import("@svc/adapters");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z19')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(s: string, o: { locks?: boolean; plan?: boolean } = {}) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, src, dst, s]);
  if (o.locks) await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [src, dst, T, id]);
  if (o.plan) {   // shift 작업이 ①에서 계획서를 읽는다 (단계 없음 → 기본 10·50·100)
    const planId = randomUUID(), exp = new Date(Date.now() + 2 * 3600_000).toISOString();
    const doc = { planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [],
      rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
      tfPlanHash: "tf", helmValuesHash: "hv", planHash: "hp", expiresAt: exp };
    await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
      VALUES ($1,$2,$3,$4,'hp',$5)`, [planId, T, id, JSON.stringify(doc), exp]);
  }
  return { id, src, dst };
}
const st = async (id: string) => (await owner.query(
  "SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0] as { status: string; failure_code: string | null };
const job = (id: string) => ({ tenantId: T, requestId: `r-z19-${id.slice(0, 8)}`, migrationId: id });
const auditOf = async (id: string, action: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND action=$2 ORDER BY at", [id, action])).rows.map((r) => r.detail);
// spec v1 = 가져오기가 만든 판(검토 끝), v2 = AI 초안(_draft + needs_review 칸 하나, 명세 모양도 깨짐)
async function seedSpecs(id: string) {
  const { ONE } = await import("./demo-one.js");
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES
    ($1,$2,1,'{}','{}',$3), ($1,$2,2,'{}', '{"_draft":{"by":"agent"}}', $4)`,
    [T, id, JSON.stringify({ spec: ONE, fieldMeta: {}, unmapped: [], ids: {} }),
     JSON.stringify({ spec: { draft: "not an AppSpec" }, fieldMeta: { "components.shop-api.resources": { source: "agent", confidence: 0.5, needs_review: true } }, unmapped: [], ids: {} })]);
}

// ── H1 ─────────────────────────────────────────────────────────────
test("H1 AI 초안 판이 있어도 명세 확정(T04 spec_review → prechecking)이 막히지 않는다 (예전: 409 '1 field(s) need review')", { skip }, async () => {
  const m = await seed("spec_review");
  await seedSpecs(m.id);
  await core.withTenant(T, (tx) => core.advance(tx, { id: m.id, tenantId: T }, "spec_review", "prechecking", { audit }));
  assert.equal((await st(m.id)).status, "prechecking");
});

test("H1 계획 작업은 초안 판이 아니라 사람이 확정한 최신 판으로 계획을 만든다 (예전: 초안을 읽어 AppSpec 오류)", { skip }, async () => {
  const m = await seed("planning");
  await seedSpecs(m.id);
  assert.equal(await plan.handlePlan({ ...job(m.id), planId: randomUUID() }), "advanced");
  assert.equal((await st(m.id)).status, "awaiting_approval");
});

// ── H3 ─────────────────────────────────────────────────────────────
test("H3 shift가 50%로 올리려는 순간 사람이 롤백 → 끝 상태 rolled_back이면 가중치는 출발 100% (예전: 도착 50% 잔류)", { skip }, async () => {
  const m = await seed("shifting", { locks: true, plan: true });
  const sw = platform.trafficSwitcher();
  const realSet = sw.set.bind(sw);
  const order: string[] = [];
  let race: Promise<unknown> | null = null;
  // 50%를 처음 쓰려는 순간에 API 롤백(advance → rolling_back)과 rollback 작업을 끼워 넣는다.
  // 고친 코드: advance가 shift의 FOR SHARE에 막혀 기다린다(1초 안에 안 끝남) → 50% 뒤에 롤백이 온다
  // 예전 코드: 롤백이 먼저 끝나고(출발 100%) 그 뒤에 50%가 덮어쓴다
  sw.set = async (lb, w) => {
    if (lb === m.id && w.target === 0.5 && !race) {
      race = (async () => {
        await core.withTenant(T, (tx) => core.advance(tx, { id: m.id, tenantId: T }, "shifting", "rolling_back",
          { failureCode: "USER_REQUESTED", audit: { ...audit, action: "migration.rolling_back" } }));
        order.push("api.rolling_back");
        await rollback.handleRollback(job(m.id));
        order.push("rollback.done");
      })();
      await Promise.race([race, new Promise((r) => setTimeout(r, 1000))]);
    }
    if (lb === m.id) order.push(`set ${w.target}`);
    return realSet(lb, w);
  };
  try {
    const r = await shift.handleShift(job(m.id));
    assert.equal(r, "skipped", "상태가 바뀐 걸 보고 손 뗀다");
    await race;
  } finally { sw.set = realSet; }
  assert.equal((await st(m.id)).status, "rolled_back");
  assert.deepEqual(await sw.get(m.id), { source: 1, target: 0 }, `순서: ${order.join(" → ")}`);
  assert.ok(order.indexOf("set 0.5") < order.indexOf("api.rolling_back"), `롤백 확정은 50% PATCH 뒤: ${order.join(" → ")}`);
  assert.ok(!order.slice(order.indexOf("api.rolling_back")).some((x) => x === "set 1"), "롤백 뒤에 shift가 100%로 올리지 않는다");
});

// ── H4 ─────────────────────────────────────────────────────────────
test("H4 sync 재시도는 정해진 대기(첫 번째 600초 = SYNC_RETRY_DELAYS_SEC[0])로 다시 넣고 상태·잠금은 그대로 (예전: 대기 0초 재시도 1번)", { skip }, async () => {
  assert.deepEqual(sync.SYNC_RETRY_DELAYS_SEC, [600, 601, 602]);
  assert.equal(sync.SYNC_MAX_ATTEMPTS, 4);
  const m = await seed("syncing", { locks: true });
  process.env.SYNC_STUB_FAIL = "1";
  try {
    assert.equal(await sync.handleSync(job(m.id)), "skipped");
    assert.equal((await st(m.id)).status, "syncing");
    const q = await owner.query(`SELECT extract(epoch from start_after - now())::float AS wait FROM pgboss.job
      WHERE name='sync' AND singleton_key=$1 AND state='created'`, [`sync:${m.id}`]);
    assert.equal(q.rowCount, 1);
    assert.ok(q.rows[0].wait > 590 && q.rows[0].wait <= 600, `대기 ${q.rows[0].wait}초`);
    const locks = (await owner.query("SELECT holder FROM env_locks WHERE migration_id=$1", [m.id])).rows;
    assert.ok(locks.length === 2 && locks.every((l) => l.holder === "reserved"), "다음 시도가 인수하게 반납");
    // 4번째(= 3번 재시도 뒤) 실패면 paused(SYNC_FAILED) — 10/31 Jeong 기본값. 잠금은 유지
    for (let k = 2; k <= 3; k++) assert.equal(await sync.handleSync(job(m.id)), "skipped");
    assert.equal(await sync.handleSync(job(m.id)), "advanced");
  } finally { delete process.env.SYNC_STUB_FAIL; }
  assert.deepEqual(await st(m.id), { status: "paused", failure_code: "SYNC_FAILED" });
  assert.equal((await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [m.id])).rows[0].n, 2, "paused는 잠금 유지");
  const tries = await auditOf(m.id, "sync.retry_scheduled");
  assert.deepEqual(tries.map((d) => d.delaySec), [600, 601, 602]);
});

test("H4 마지막 시도가 예외로 끝나면 이전을 사람이 볼 상태로 옮긴다: deploying → paused(JOB_FAILED_DEPLOY), 마지막이 아니면 그대로", { skip }, async () => {
  const m = await seed("deploying", { locks: true });
  const boom = { name: "deploy", expect: "deploying" as const, work: async (): Promise<never> => { throw new Error("argo unreachable"); } };
  await assert.rejects(step.jobAttempt.run({ queue: "deploy", retryCount: 0, retryLimit: 2 }, () => step.runStep(job(m.id), boom)), /argo/);
  assert.equal((await st(m.id)).status, "deploying", "재시도가 남았으면 상태 그대로");
  await assert.rejects(step.jobAttempt.run({ queue: "deploy", retryCount: 2, retryLimit: 2 }, () => step.runStep(job(m.id), boom)), /argo/);
  assert.deepEqual(await st(m.id), { status: "paused", failure_code: "JOB_FAILED_DEPLOY" });
  const d = (await auditOf(m.id, "deploy.paused"))[0];
  assert.equal(d.by, "dead-letter"); assert.match(d.error, /argo unreachable/);
});

test("H4 rolling_back에서 전이 조건 실패(③ 예외)가 마지막이면 failed(JOB_FAILED_ROLLBACK) — 예전: 영원히 rolling_back", { skip }, async () => {
  const m = await seed("rolling_back", { locks: true });
  // T35 증거가 false → advance가 GuardFailed를 던진다 (② 성공, ③ 실패)
  const bad = { name: "rollback", expect: "rolling_back" as const,
    work: async () => ({ to: "rolled_back" as const, evidence: { sourceWeight100: false, sourceHealthy: false } }) };
  await assert.rejects(step.jobAttempt.run({ queue: "rollback", retryCount: 1, retryLimit: 1 }, () => step.runStep(job(m.id), bad)));
  assert.deepEqual(await st(m.id), { status: "failed", failure_code: "JOB_FAILED_ROLLBACK" });
});

test("H4 실제 pg-boss로: 큐 정책이 모든 단계 큐에 붙어 있다 (deploy 2번·10초, sync·cutover 1번 = Z32 시작 전 사망용, rollback 1번·5초)", { skip }, async () => {
  const q = await owner.query(`SELECT name, retry_limit, retry_delay FROM pgboss.queue WHERE name = ANY($1) ORDER BY name`,
    [["deploy", "sync", "shift", "cutover", "cleanup", "rollback"]]);
  const got = Object.fromEntries(q.rows.map((r) => [r.name, [r.retry_limit, r.retry_delay]]));
  assert.deepEqual(got, { cleanup: [3, 10], cutover: [1, 0], deploy: [2, 10], rollback: [1, 5], shift: [1, 5], sync: [1, 0] });
});
