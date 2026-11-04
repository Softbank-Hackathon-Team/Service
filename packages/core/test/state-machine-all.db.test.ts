// 상태 22개 전이 전체 시험 (API·오케스트레이터 영역).
// ① 표(VALID)의 모든 길을 실제 DB 에서 advance() 로 한 번씩 지나간다: 조건을 채운 사실·증거를 만들고 → 상태·version·
//    상태별 칸(failed_at_status·paused_from·failure_code·rollback_window_ends_at)·환경 잠금(풀림·되찾음·예약)을 본다
// ② 조건이 있는 길은 조건을 비운 채로 부르면 409 GUARD_FAILED, 상태·version 그대로
// ③ 표에 없는 길(22×22 중 나머지 전부)은 409 INVALID_TRANSITION, 상태 그대로
// ④ 모든 길에 그 길을 실제로 부르는 코드가 있다 (부르는 곳이 0이면 막다른 길: G7-1 의 T11 처럼)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { VALID, MIGRATION_STATUSES, TERMINAL, type MigrationStatus, type TransitionEvidence } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let core: typeof import("../src/index.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-state-machine-all')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

type Edge = `${MigrationStatus}>${MigrationStatus}`;
const EDGES: Edge[] = MIGRATION_STATUSES.flatMap((f) => VALID[f].map((t) => `${f}>${t}` as Edge));

// 길마다 조건을 채우는 준비. seed = DB 사실, ev = 부르는 쪽 증거, failureCode = failed·paused 사유
interface Prep {
  spec?: boolean; plan?: "live" | "expired"; locks?: "reserved" | "worker" | "none";
  windowOver?: boolean; failedAt?: MigrationStatus; pausedFrom?: MigrationStatus;
  ev?: TransitionEvidence; failureCode?: string; conn?: string;
}
const OK: Partial<Record<Edge, Prep>> = {
  "importing>spec_review": { spec: true },
  "spec_review>prechecking": { spec: true },
  "prechecking>planning": { ev: { precheckBlockers: 0 } },
  "prechecking>spec_review": { ev: { precheckBlockers: 1 } },
  "planning>awaiting_approval": { plan: "live" },
  "awaiting_approval>approved": { plan: "live" },          // ev.planHash 는 아래에서 계획 지문으로 채움
  "awaiting_approval>stale": { plan: "expired", ev: { staleReason: "expired" } },
  "approved>provisioning": { plan: "live", locks: "reserved" },
  "approved>stale": { plan: "expired", locks: "reserved", ev: { staleReason: "expired" } },
  "provisioning>deploying": { locks: "worker", ev: { applyOk: true } },
  "deploying>syncing": { locks: "worker", ev: { argoHealthy: true, securityParity: true } },
  "syncing>shifting": { locks: "worker", ev: { snapshotDone: true, markerRoundTripMs: 1 } },
  "shifting>cutover": { locks: "worker", ev: { weightPct: 100, observedSec: 3600, targetLogsSeen: true } },
  "cutover>rollback_window": { locks: "worker", ev: { cutoverStepsOk: true } },
  "cutover>shifting": { locks: "worker", ev: { revertOk: true } },
  "rollback_window>cleanup": { locks: "worker", windowOver: true, ev: { cleanupApproved: true } },
  "rollback_window>rolling_back": { locks: "worker", windowOver: false },
  "cleanup>completed": { locks: "worker", ev: { tempResources: 0, operateRoleRevoked: true } },
  "rolling_back>rolled_back": { locks: "worker", ev: { sourceWeight100: true, sourceHealthy: true } },
  // Jeong 11/4 01:53Z: failed = 재시도 질문 대기. 재시도 = 실패 지점으로 (증거 failureDecision retry)
  "failed>importing": { failedAt: "importing", ev: { failureDecision: "retry" } },
  "failed>prechecking": { failedAt: "prechecking", ev: { failureDecision: "retry" } },
  "failed>planning": { failedAt: "planning", ev: { failureDecision: "retry" } },
  "failed>provisioning": { failedAt: "provisioning", locks: "reserved", ev: { failureDecision: "retry" } },
  "failed>cutover": { failedAt: "cutover", locks: "reserved", ev: { failureDecision: "retry" } },
  "failed>rolling_back": { failedAt: "cutover", locks: "reserved" },
  "failed>cancelled": { failedAt: "cutover", locks: "reserved", ev: { manualCleanupConfirmed: true } },
  "paused>deploying": { pausedFrom: "deploying", locks: "reserved", ev: { ruleCleared: true } },
  "paused>syncing": { pausedFrom: "syncing", locks: "reserved", ev: { ruleCleared: true } },
  "paused>shifting": { pausedFrom: "shifting", locks: "reserved", ev: { ruleCleared: true } },
  "paused>cleanup": { pausedFrom: "cleanup", locks: "reserved", ev: { ruleCleared: true } },
  "paused>rolling_back": { pausedFrom: "shifting", locks: "reserved" },
};
const prepOf = (e: Edge): Prep => {
  const [from, to] = e.split(">") as [MigrationStatus, MigrationStatus];
  const p: Prep = { ...(OK[e] ?? {}) };
  if (to === "failed" || to === "paused") p.failureCode = "TEST_FAILURE";
  if (to === "paused" && !p.ev) p.ev = { guardrailRule: "TEST" };
  // 잠금 단계에서 떠나는 길은 잠금이 있어야 "풀림·남음"을 볼 수 있다
  if (!p.locks && (core.LOCKED_STAGES as readonly string[]).includes(from)) p.locks = "worker";
  if (from === "failed" && !p.failedAt) p.failedAt = "provisioning";
  if (from === "cleanup" && p.windowOver === undefined) p.windowOver = true;   // 정리 중 = 창은 이미 끝남 (PW-1: paused 로 가도 창 끝 시각 유지)
  return p;
};

async function seed(from: MigrationStatus, p: Prep) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s',$4), ($2,$3,'gcp','g',$4)`, [src, dst, T, p.conn ?? "connected"]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, failed_at_status, paused_from,
      rollback_window_ends_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::boolean IS NULL THEN NULL WHEN $8 THEN now() - interval '1 second' ELSE now() + interval '1 hour' END)`,
    [id, T, src, dst, from, p.failedAt ?? null, p.pausedFrom ?? null, p.windowOver ?? null]);
  if (p.spec) await owner.query(
    `INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}'::jsonb,'{}'::jsonb,$3)`,
    [T, id, { spec: {}, fieldMeta: {}, unmapped: [] }]);
  let planHash: string | undefined;
  if (p.plan) {
    const planId = randomUUID(); planHash = `hash-${planId}`;
    await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
      VALUES ($1,$2,$3,'{}'::jsonb,$4, now() + CASE WHEN $5 THEN interval '-1 second' ELSE interval '1 hour' END)`,
      [planId, T, id, planHash, p.plan === "expired"]);
  }
  if (p.locks && p.locks !== "none")
    await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
      VALUES ($1,$3,$4,$5, now() + interval '10 minutes'), ($2,$3,$4,$5, now() + interval '10 minutes')`,
      [src, dst, T, id, p.locks === "reserved" ? "reserved" : "worker:test"]);
  return { id, planHash };
}
const row = async (id: string) => (await owner.query(
  `SELECT status, version, failed_at_status, paused_from, failure_code, rollback_window_ends_at IS NOT NULL AS has_window
     FROM migrations WHERE id=$1`, [id])).rows[0];
const locks = async (id: string) => (await owner.query(
  `SELECT holder FROM env_locks WHERE migration_id=$1 ORDER BY env_id`, [id])).rows.map((r) => r.holder as string);
const move = (id: string, from: MigrationStatus, to: MigrationStatus, ev?: TransitionEvidence, failureCode?: string) =>
  core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, from, to, {
    evidence: ev, ...(failureCode ? { failureCode } : {}),
    audit: { actor: "test", action: `t.${from}>${to}`, target: id, result: "ok" } }));

// 잠금 규칙 (advance.ts RELEASES_LOCK + 승인 예약 + 롤백 되찾기)
function expectLocks(from: MigrationStatus, to: MigrationStatus, before: string[]): string[] {
  if ((TERMINAL as readonly string[]).includes(to) || (to === "stale" && from === "approved")
      || (to === "failed" && (core.REPLANNABLE_FAILURES as readonly string[]).includes(from))) return [];
  if (to === "approved") return ["reserved", "reserved"];
  if (to === "rolling_back") return before.map(() => "reserved");
  return before;
}

test("① 표의 모든 길(58개)을 조건을 채워 한 번씩 지나간다: 상태·version·상태별 칸·환경 잠금", { skip }, async () => {
  assert.equal(EDGES.length, 58);
  for (const e of EDGES) {
    const [from, to] = e.split(">") as [MigrationStatus, MigrationStatus];
    const p = prepOf(e);
    const s = await seed(from, p);
    const ev = { ...(p.ev ?? {}), ...(e === "awaiting_approval>approved" ? { planHash: s.planHash } : {}) };
    const before = await locks(s.id);
    const ok = await move(s.id, from, to, ev, p.failureCode).catch((x) => { throw new Error(`${e}: ${x.code ?? ""} ${x.message}`); });
    assert.equal(ok, true, e);
    const r = await row(s.id);
    assert.equal(r.status, to, e);
    assert.equal(r.version, 1, `${e}: version +1`);
    assert.equal(r.failed_at_status, to === "failed" ? from : null, `${e}: failed_at_status`);
    assert.equal(r.paused_from, to === "paused" ? from : null, `${e}: paused_from`);
    if (to === "failed" || to === "paused") assert.equal(r.failure_code, "TEST_FAILURE", `${e}: failure_code`);
    // 창 끝 시각: rollback_window 로 갈 때 생기고, cleanup·paused 로 갈 때는 있던 값을 그대로 둔다 (PW-1)
    assert.equal(r.has_window, to === "rollback_window" || ((to === "cleanup" || to === "paused") && p.windowOver !== undefined),
      `${e}: rollback_window_ends_at`);
    assert.deepEqual(await locks(s.id), expectLocks(from, to, before), `${e}: env locks`);
  }
});

test("② 조건이 있는 길은 조건을 비우면 409 GUARD_FAILED, 상태·version 그대로", { skip }, async () => {
  const guarded = new Set<string>(core.GUARDED_TRANSITIONS);
  let n = 0;
  for (const e of EDGES) {
    const [from, to] = e.split(">") as [MigrationStatus, MigrationStatus];
    // 조건 표의 길 + paused 로 가는 길(T30) + paused 에서 나오는 길(T31·T32)
    if (!guarded.has(e) && to !== "paused" && from !== "paused") continue;
    // 사실(DB)·증거를 다 비운다. 단 failed 에서 나가는 길은 실패 지점이 조건이라 "틀린 지점"으로
    const p: Prep = from === "failed" ? { failedAt: e === "failed>rolling_back" ? "planning" : "provisioning" }
      : from === "paused" ? { pausedFrom: e === "paused>rolling_back" ? "cleanup" : "deploying" === to ? "syncing" : "deploying" }
      : e === "rollback_window>rolling_back" ? { windowOver: true }
      : e === "approved>stale" ? { locks: "reserved", plan: "live" } : {};   // 잠금이 살아 있고 만료 전 = 낡음 아님
    p.conn = "failed";   // 연결 조건(T01·T09·T15)도 비운다
    const s = await seed(from, p);
    await assert.rejects(move(s.id, from, to, {}), (x: { code?: string }) => x.code === "GUARD_FAILED", e);
    const r = await row(s.id);
    assert.equal(r.status, from, e); assert.equal(r.version, 0, e);
    n++;
  }
  assert.ok(n >= 30, `조건 있는 길 ${n}개`);
});

test("③ 표에 없는 길(22×22 중 나머지)은 전부 409 INVALID_TRANSITION, 상태 그대로", { skip }, async () => {
  let n = 0;
  for (const from of MIGRATION_STATUSES) {
    const s = await seed(from, {});
    for (const to of MIGRATION_STATUSES) {
      if (VALID[from].includes(to)) continue;
      await assert.rejects(move(s.id, from, to, {}), (x: { code?: string }) => x.code === "INVALID_TRANSITION", `${from}>${to}`);
      n++;
    }
    assert.equal((await row(s.id)).status, from);
  }
  assert.equal(n, 22 * 22 - 58);
});

// ④ 길마다 그 길을 부르는 코드. 파일 안에 두 상태 이름이 실제로 나오는지 본다 (이름이 바뀌거나 지워지면 여기서 깨진다)
//   워커 단계 처리기는 expect(출발)와 to(도착)를, 리퍼·죽은 작업 처리는 failureEdge 규칙을 쓴다
const CALLERS: Partial<Record<Edge, string[]>> = {
  "draft>importing": ["apps/api/src/routes/migrations.ts"],
  "draft>cancelled": ["apps/api/src/routes/control.ts"],
  "importing>spec_review": ["apps/worker/src/jobs/import.ts"],
  "importing>failed": ["apps/worker/src/jobs/import.ts"],
  "importing>cancelled": ["apps/api/src/routes/control.ts"],
  "spec_review>prechecking": ["apps/api/src/routes/plans.ts"],
  "spec_review>cancelled": ["apps/api/src/routes/control.ts"],
  "prechecking>planning": ["apps/worker/src/jobs/precheck.ts"],
  "prechecking>spec_review": ["apps/worker/src/jobs/precheck.ts"],
  "prechecking>failed": ["apps/worker/src/jobs/_step.ts"],
  "prechecking>cancelled": ["apps/api/src/routes/control.ts"],
  "planning>awaiting_approval": ["apps/worker/src/jobs/plan.ts"],
  "planning>failed": ["apps/worker/src/jobs/plan.ts"],
  "planning>cancelled": ["apps/api/src/routes/control.ts"],
  "awaiting_approval>approved": ["apps/api/src/routes/plans.ts"],
  "awaiting_approval>rejected": ["apps/api/src/routes/plans.ts"],
  "awaiting_approval>stale": ["apps/worker/src/jobs/plan-expiry.ts", "apps/api/src/routes/plans.ts", "packages/core/src/plans.ts"],
  "awaiting_approval>cancelled": ["apps/api/src/routes/control.ts"],
  "rejected>spec_review": ["apps/api/src/routes/plans.ts"],
  "rejected>prechecking": ["apps/api/src/routes/plans.ts"],
  "rejected>cancelled": ["apps/api/src/routes/control.ts"],
  "stale>prechecking": ["apps/api/src/routes/plans.ts"],
  "stale>cancelled": ["apps/api/src/routes/control.ts"],
  "approved>provisioning": ["apps/api/src/routes/plans.ts"],
  "approved>stale": ["apps/worker/src/lease/reaper.ts", "packages/core/src/plans.ts"],
  "approved>cancelled": ["apps/api/src/routes/control.ts"],
  "provisioning>deploying": ["apps/worker/src/jobs/apply.ts"],
  "provisioning>failed": ["apps/worker/src/jobs/apply.ts"],
  "deploying>syncing": ["apps/worker/src/jobs/deploy.ts"],
  "deploying>paused": ["apps/worker/src/jobs/deploy.ts"],
  "deploying>rolling_back": ["apps/api/src/routes/control.ts"],
  "syncing>shifting": ["apps/worker/src/jobs/sync.ts"],
  "syncing>paused": ["apps/worker/src/jobs/sync.ts"],
  "syncing>rolling_back": ["apps/worker/src/jobs/sync.ts"],
  "shifting>cutover": ["apps/worker/src/jobs/shift.ts"],
  "shifting>paused": ["apps/worker/src/jobs/shift.ts"],
  "shifting>rolling_back": ["packages/traffic/src/state.ts"],   // shift 처리기가 컨트롤러 결과(t.to)를 그대로 advance 에 넘김
  "cutover>rollback_window": ["apps/worker/src/jobs/cutover.ts"],
  "cutover>shifting": ["apps/worker/src/jobs/cutover.ts"],
  "cutover>failed": ["apps/worker/src/jobs/cutover.ts"],
  "rollback_window>cleanup": ["apps/worker/src/jobs/cleanup.ts"],
  "rollback_window>rolling_back": ["apps/api/src/routes/control.ts"],
  "cleanup>completed": ["apps/worker/src/jobs/cleanup.ts"],
  "cleanup>paused": ["apps/worker/src/lease/reaper.ts"],   // 청소 작업 WORKER_LOST 등 (failureEdge)
  "paused>deploying": ["apps/api/src/routes/control.ts"],
  "paused>syncing": ["apps/api/src/routes/control.ts"],
  "paused>shifting": ["apps/api/src/routes/control.ts"],
  "paused>cleanup": ["apps/api/src/routes/control.ts"],
  "paused>rolling_back": ["apps/api/src/routes/control.ts"],
  "rolling_back>rolled_back": ["apps/worker/src/jobs/rollback.ts"],
  "rolling_back>failed": ["apps/worker/src/jobs/rollback.ts"],
  "failed>importing": ["apps/api/src/routes/control.ts"],     // 01:53Z failure-decision retry (RETRY_QUEUE)
  "failed>prechecking": ["apps/api/src/routes/control.ts"],
  "failed>planning": ["apps/api/src/routes/control.ts"],
  "failed>provisioning": ["apps/api/src/routes/control.ts"],
  "failed>cutover": ["apps/api/src/routes/control.ts"],
  "failed>rolling_back": ["apps/api/src/routes/control.ts"],
  "failed>cancelled": ["apps/api/src/routes/control.ts"],
};
test("④ 모든 길에 부르는 코드가 있다 (막다른 길 없음): 길 목록 = 표, 파일마다 두 상태 이름이 나온다", () => {
  assert.deepEqual(Object.keys(CALLERS).sort(), [...EDGES].sort(), "CALLERS 표가 VALID 와 다르다 (길이 늘거나 줄었으면 부르는 곳을 적을 것)");
  for (const [e, files] of Object.entries(CALLERS) as [string, string[]][]) {
    const [from, to] = e.split(">");
    for (const f of files) {
      const src = readFileSync(resolve(ROOT, f), "utf8");
      // _step.ts·reaper.ts·control.ts 는 상태를 변수로 받는다(failureEdge·m.status). 도착 상태 이름만 본다
      const generic = /_step\.ts$|reaper\.ts$|control\.ts$|state\.ts$/.test(f);
      if (!generic) assert.ok(src.includes(`"${from}"`) || src.includes(`'${from}'`), `${e}: ${f} 에 "${from}" 없음`);
      assert.ok(src.includes(`"${to}"`) || src.includes(`'${to}'`) || (to === "failed" || to === "paused") && /failureEdge|onError/.test(src)
        || from === "paused" && /control\.ts$/.test(f) && /pausedFrom|paused_from/.test(src),   // 재개 = 멈추기 전 상태로
        `${e}: ${f} 에 "${to}" 없음`);
    }
  }
});
