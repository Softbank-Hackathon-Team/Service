// DB 시험(작업 Z38, 통합본 2차 리뷰): 리뷰에서 고친 상태기계·잠금 구멍 4개를 재현한다.
// 고치기 전 코드에서는 각 시험이 실패한다 (REVIEW-2.md 표 참고). DATABASE_URL·OWNER_DATABASE_URL이 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
// Z32 8th-c: z75-38 뒤 shift 는 10%·50% 단계마다도 최소 관찰(TRAFFIC_OBSERVE_SEC, 기본 30초)을 채운다 → 이 파일의 shift 2회가 30초씩이라
//   파일 전체가 --test-timeout 60초를 넘겼다(int5-8·9 npm test). 시험은 관찰 길이가 아니라 전이·잠금을 보므로 1초로 준다 (TESTENV: .env 값과 상관없이 늘. 예전 ||= 는 .env 30 이면 시간 초과).
//   주의: @svc/core 를 아래 before() 에서 동적으로 불러오기 전에 정해야 한다(OBSERVE_MIN_SEC 는 불러올 때 한 번 읽음)
process.env.TRAFFIC_OBSERVE_SEC = "1";
// Z32 8th-d (맥 9차): .env 에 PROM_URL 이 있으면 guards.observeMinSec 가 30초로 올리고(진짜 지표 = 압축 금지) 판정도 진짜 Prometheus 1초 간격이 된다.
//   이 시험은 가짜 지표로 전이만 본다 → 비운다. 빈 값은 node --env-file 이 덮지 않는다(값이 이미 있으면 .env 를 안 씀)
process.env.PROM_URL = "";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let lease: typeof import("../src/lease/index.js");
let apply: typeof import("../src/jobs/apply.js");
let imp: typeof import("../src/jobs/import.js");
let step: typeof import("../src/jobs/_step.js");
let shift: typeof import("../src/jobs/shift.js");
let platform: typeof import("../src/platform.js");
let owner: pg.Client;
const T = randomUUID();   // 감사 체인을 다른 시험과 섞지 않게 회사를 새로 만든다

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "0";
  core = await import("@svc/core");
  lease = await import("../src/lease/index.js");
  apply = await import("../src/jobs/apply.js");
  imp = await import("../src/jobs/import.js");
  step = await import("../src/jobs/_step.js");
  process.env.TRAFFIC_TICK_MS = "1";
  shift = await import("../src/jobs/shift.js");
  platform = await import("../src/platform.js");
  await core.startBoss();
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z38')", [T]);
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false });
  await lease.closeHeartbeatPool(); await core.pool.end(); await owner.end();
});

// 이전 하나 (환경은 매번 새로: 잠금 줄이 환경 번호 기준이라 겹치면 안 된다)
async function setup(status: string, lock?: { holder: string; leaseSql: string }, extra = "") {
  const id = randomUUID(), s = randomUUID(), g = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, g, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status${extra ? ", paused_from" : ""})
    VALUES ($1,$2,$3,$4,$5${extra ? ", $6" : ""})`, extra ? [id, T, s, g, status, extra] : [id, T, s, g, status]);
  if (lock) await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,$5, ${lock.leaseSql}), ($2,$3,$4,$5, ${lock.leaseSql})`, [s, g, T, id, lock.holder]);
  return { id, s, g };
}
const row = async (id: string) => (await owner.query(
  "SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const lockCount = async (id: string) =>
  (await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [id])).rows[0].n as number;

test("Z38-1 (P-4): cleanup 에서 멈춘 이전은 rolling_back 으로 못 간다 (advance 가 GuardFailed)", { skip }, async () => {
  const m = await setup("paused", { holder: "reserved", leaseSql: "now() + interval '10 minutes'" }, "cleanup");
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id: m.id, tenantId: T }, "paused", "rolling_back",
    { audit: { actor: "test", action: "migration.rolling_back", target: m.id, result: "ok" } })), /rollback window is over/);
  assert.equal((await row(m.id)).status, "paused");
  // 다른 단계에서 멈춘 것은 그대로 롤백된다
  const n = await setup("paused", { holder: "reserved", leaseSql: "now() + interval '10 minutes'" }, "syncing");
  await core.withTenant(T, (tx) => core.advance(tx, { id: n.id, tenantId: T }, "paused", "rolling_back",
    { audit: { actor: "test", action: "migration.rolling_back", target: n.id, result: "ok" } }));
  assert.equal((await row(n.id)).status, "rolling_back");
});

test("Z38-3: apply 재확인 실패(승인 없음) → 조용히 skipped 가 아니라 failed(APPLY_RECHECK_FAILED) + 잠금 해제", { skip }, async () => {
  const m = await setup("provisioning", { holder: "reserved", leaseSql: "now() + interval '2 hours'" });
  const r = await apply.handleApply({ tenantId: T, requestId: "z38", migrationId: m.id, planId: randomUUID(), planHash: "x" });
  assert.equal(r, "advanced");
  assert.deepEqual(await row(m.id), { status: "failed", failure_code: "APPLY_RECHECK_FAILED" });
  assert.equal(await lockCount(m.id), 0, "provisioning 실패는 잠금을 푼다 (다시 계획 가능)");
});

test("Z38-4: import 가 재시도를 다 쓰면 importing 에 남지 않고 failed(IMPORT_FAILED)", { skip }, async () => {
  const m = await setup("importing");
  // 실패 원인 만들기: 판 1이 이미 있어 INSERT 가 23505 로 깨진다 (Zod 오류가 아닌 "다시 해 볼 만한" 실패)
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta) VALUES ($1,$2,1,'{}','{}')`, [T, m.id]);
  const job = { tenantId: T, requestId: "z38", migrationId: m.id };
  // 첫 시도: 던져서 pg-boss 재시도에 맡기고, 시도 기록 1줄
  await assert.rejects(imp.handleImport(job));
  assert.equal(await step.failedAttempts(job, "import"), 1);
  assert.equal((await row(m.id)).status, "importing");
  await assert.rejects(imp.handleImport(job));
  await assert.rejects(imp.handleImport(job));
  // 네 번째(= 첫 시도 + retryLimit 3): 더 던지지 않고 failed
  await imp.handleImport(job);
  assert.deepEqual(await row(m.id), { status: "failed", failure_code: "IMPORT_FAILED" });
});

test("Z38-5: 청소가 목록을 읽은 뒤 워커가 잠금을 다시 인수했으면 그 이전을 건드리지 않는다", { skip }, async () => {
  const m = await setup("provisioning", { holder: "worker:old", leaseSql: "now() - interval '1 second'" });
  const snapshot = { tenantId: T, envId: m.s, migrationId: m.id, holder: "worker:old", jobId: null, jobQueue: null, status: "provisioning" };
  // 목록과 처리 사이에 새 워커가 인수 (acquireEnvLock 은 기한 지난 잠금을 허용한다)
  await owner.query(`UPDATE env_locks SET holder='worker:new', lease_expires_at = now() + interval '90 seconds' WHERE migration_id=$1`, [m.id]);
  const r1 = await lease.reapLock(snapshot);
  assert.equal(r1.applied, false);
  assert.equal(r1.action.kind, "skip");
  assert.deepEqual(await row(m.id), { status: "provisioning", failure_code: null });
  // 정말 기한이 지난 채면 예전처럼 failed(WORKER_LOST)
  const n = await setup("provisioning", { holder: "worker:old", leaseSql: "now() - interval '1 second'" });
  assert.equal((await lease.reapLock({ ...snapshot, envId: n.s, migrationId: n.id })).applied, true);
  assert.deepEqual(await row(n.id), { status: "failed", failure_code: "WORKER_LOST" });
});

test("R3-3: 50% 에서 멈췄다 재개한 shift 는 10% 로 안 내리고 50% 부터 이어 간다", { skip }, async () => {
  const m = await setup("shifting", { holder: "reserved", leaseSql: "now() + interval '10 minutes'" });
  const a = (action: string) => ({ actor: "test", action, target: m.id, result: "ok" as const });
  // 실제 길: shifting → paused(실패 코드) → 재개 paused → shifting (감사에 from=shifting 이 남는다)
  await core.withTenant(T, (tx) => core.advance(tx, { id: m.id, tenantId: T }, "shifting", "paused", { failureCode: "JOB_FAILED_SHIFT", audit: a("migration.paused") }));
  await core.withTenant(T, (tx) => core.advance(tx, { id: m.id, tenantId: T }, "paused", "shifting", { evidence: { ruleCleared: true }, audit: a("migration.resumed") }));
  const sw = platform.trafficSwitcher();
  await sw.set(m.id, { source: 0.5, target: 0.5 });     // mock LB: 멈춘 때 50%
  // 3차: 판정 수 대신 LB 에 실제로 보낸 가중치를 본다 (관찰 시간 설정과 무관). 처음부터면 0.1 이 들어간다
  const sent: number[] = [];
  const realSet = sw.set.bind(sw);
  sw.set = async (id, w) => { if (id === m.id) sent.push(w.target); return realSet(id, w); };
  try {
    assert.equal(await shift.handleShift({ tenantId: T, requestId: "z38", migrationId: m.id }), "advanced");
  } finally { sw.set = realSet; }
  assert.ok(sent.length > 0 && Math.min(...sent) >= 0.5, `LB 에 보낸 도착 비율 ${JSON.stringify(sent)} (50% 아래로 내려가면 안 됨)`);
  const d = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='shift.cutover'`, [m.id])).rows[0].detail;
  assert.equal(d.resumeFromPct, 50);
  // 통합: 판정 수는 Z20 M7 이후 시계 기준 관찰(TRAFFIC_OBSERVE_SEC)이라 환경마다 달라 세지 않는다. 시작 단계는 resumeFromPct 로 본다
  assert.equal(d.reachedPct, 100);
  assert.equal((await row(m.id)).status, "cutover");
});

test("z75-38: shift 가 단계마다 실측 몫을 확인하고 traffic_progress 에 목표·실측·도달을 남긴다", { skip }, async () => {
  const m = await setup("shifting", { holder: "reserved", leaseSql: "now() + interval '10 minutes'" });
  assert.equal(await shift.handleShift({ tenantId: T, requestId: "z75-38", migrationId: m.id }), "advanced");
  const d = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='shift.cutover'`, [m.id])).rows[0].detail;
  // 가짜 지표는 가중치 그대로 나눈다 → 단계마다 도달, 재관찰 0
  assert.deepEqual(d.stepShares.map((s: { stepPct: number; observedPct: number; reobserve: number }) => [s.stepPct, s.observedPct, s.reobserve]),
    [[10, 10, 0], [50, 50, 0], [100, 100, 0]]);
  const p = await core.withTenant(T, async (tx) => (await tx.query(
    "SELECT target_pct, observed_pct, reached, tolerance_pct FROM traffic_progress WHERE migration_id = $1", [m.id])).rows[0]);
  assert.deepEqual(p, { target_pct: 100, observed_pct: 100, reached: true, tolerance_pct: 10 });
});

test("z75-38 R8-43: TRAFFIC_SHARE_CHECK=0 이면 예전 동작 (stepShares·진행 기록 없음)", { skip }, async () => {
  const m = await setup("shifting", { holder: "reserved", leaseSql: "now() + interval '10 minutes'" });
  process.env.TRAFFIC_SHARE_CHECK = "0";
  try {
    assert.equal(await shift.handleShift({ tenantId: T, requestId: "z75-38-off", migrationId: m.id }), "advanced");
  } finally { delete process.env.TRAFFIC_SHARE_CHECK; }
  const d = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='shift.cutover'`, [m.id])).rows[0].detail;
  assert.equal(d.stepShares, undefined);
  assert.equal(d.reachedPct, 100);
  const n = await core.withTenant(T, async (tx) => (await tx.query("SELECT 1 FROM traffic_progress WHERE migration_id = $1", [m.id])).rowCount);
  assert.equal(n, 0);
});
