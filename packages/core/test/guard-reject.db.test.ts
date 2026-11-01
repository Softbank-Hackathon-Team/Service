// DB 시험(작업 P): 전이 조건(guardOk) 실패 = 아무 흔적 없이 거부.
// 조건이 막으면 상태·version·감사 기록·큐 작업 중 어느 것도 바뀌면 안 된다 (트랜잭션 통째 취소).
// 순수 함수 시험(guards.test.ts)이 "판단"을 보고, 이 파일은 "거부된 뒤 DB가 깨끗한가"를 본다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { OBSERVE_MIN_SEC, type TransitionEvidence } from "../src/guards.js";
// 관찰 시간은 TRAFFIC_OBSERVE_SEC(.env 0.5 등)에 따라 바뀐다 → 기준값에서 바로 아래/정확히 기준으로 시험
const OBS = OBSERVE_MIN_SEC;

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("../src/index.js");
let owner: pg.Client;
const T = randomUUID();
const audit = { actor: "test", action: "guard-reject", target: "t", result: "ok" as const };

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-p-guard')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function setup(s: string, opts: { conn?: string; windowSql?: string; plan?: "fresh" | "expired" } = {}) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g',$4)`, [src, dst, T, opts.conn ?? "connected"]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, rollback_window_ends_at)
    VALUES ($1,$2,$3,$4,$5, ${opts.windowSql ?? "NULL"})`, [id, T, src, dst, s]);
  if (opts.plan)
    await owner.query(`INSERT INTO plans (tenant_id, migration_id, plan_doc, plan_hash, expires_at)
      VALUES ($1,$2,'{}','h1', now() + interval ${opts.plan === "fresh" ? "'2 hours'" : "'-1 second'"})`, [T, id]);
  return id;
}
// 흔적: 상태·version·감사 줄 수·이 이전 번호가 실린 큐 작업 수
async function trace(id: string) {
  const m = (await owner.query("SELECT status, version, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
  const a = (await owner.query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1", [T])).rows[0].n;
  const j = (await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE data->>'migrationId' = $1", [id])).rows[0].n;
  return { ...m, audit: a, jobs: j };
}
const next = (id: string) => ({ queue: "deploy" as const, data: { tenantId: T, requestId: "r", migrationId: id } });

// 이동마다 "막혀야 하는 증거"와 "통과하는 증거"를 같이 둔다. 통과 쪽으로 조건 표가 너무 세지 않은지도 본다
interface Case { from: string; to: string; bad: TransitionEvidence; good?: TransitionEvidence; setup?: Parameters<typeof setup>[1]; why: RegExp }
const CASES: Case[] = [
  { from: "draft", to: "importing", bad: {}, setup: { conn: "unstable" }, why: /not connected/ },
  { from: "importing", to: "spec_review", bad: {}, why: /no spec/ },
  { from: "prechecking", to: "planning", bad: { precheckBlockers: 1 }, good: { precheckBlockers: 0 }, why: /precheckBlockers/ },
  { from: "planning", to: "awaiting_approval", bad: {}, setup: { plan: "expired" }, why: /expired/ },
  { from: "awaiting_approval", to: "approved", bad: { planHash: "h1" }, setup: { plan: "expired" }, why: /expired/ },
  { from: "approved", to: "provisioning", bad: {}, why: /env lock not held/ },
  { from: "provisioning", to: "deploying", bad: { applyOk: false }, good: { applyOk: true }, why: /applyOk/ },
  { from: "deploying", to: "syncing", bad: { argoHealthy: true, securityParity: false },
    good: { argoHealthy: true, securityParity: true }, why: /securityParity/ },
  { from: "syncing", to: "shifting", bad: { snapshotDone: true, markerRoundTripMs: 900 },
    good: { snapshotDone: true, markerRoundTripMs: 120 }, why: /marker/ },
  { from: "shifting", to: "cutover", bad: { weightPct: 100, observedSec: OBS * 0.9, targetLogsSeen: true },
    good: { weightPct: 100, observedSec: OBS, targetLogsSeen: true }, why: /observe >=/ },
  { from: "cutover", to: "rollback_window", bad: {}, good: { cutoverStepsOk: true }, why: /cutover steps/ },
  { from: "rollback_window", to: "cleanup", bad: { cleanupApproved: true }, setup: { windowSql: "now() + interval '1 hour'" },
    why: /window still open/ },
  { from: "cleanup", to: "completed", bad: { tempResources: 1, operateRoleRevoked: true },
    good: { tempResources: 0, operateRoleRevoked: true }, why: /temporary resources/ },
  { from: "rolling_back", to: "rolled_back", bad: { sourceWeight100: true }, good: { sourceWeight100: true, sourceHealthy: true },
    why: /source not healthy/ },
];

for (const c of CASES) {
  test(`조건 거부 ${c.from} → ${c.to}: GUARD_FAILED, 흔적 0`, { skip }, async () => {
    const id = await setup(c.from, c.setup);
    const before = await trace(id);
    await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T },
      c.from as never, c.to as never, { evidence: c.bad, next: next(id), audit })),
      (e: { code?: string; message?: string }) => e.code === "GUARD_FAILED" && c.why.test(e.message ?? ""));
    assert.deepEqual(await trace(id), before, "상태·version·감사·큐 모두 그대로");
    if (c.good) {
      await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T },
        c.from as never, c.to as never, { evidence: c.good, audit }));
      const after = await trace(id);
      assert.equal(after.status, c.to); assert.equal(after.version, before.version + 1);
    }
  });
}

test("일시정지 재개: 규칙이 안 풀렸으면 거부, 멈추기 전 상태로만", { skip }, async () => {
  const id = await setup("shifting");
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "shifting", "paused",
    { evidence: { guardrailRule: "MG-3-02" }, audit }));
  const b = await trace(id);
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "paused", "shifting",
    { evidence: { ruleCleared: false }, audit })), { code: "GUARD_FAILED" });
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "paused", "syncing",
    { evidence: { ruleCleared: true }, audit })), { code: "GUARD_FAILED" });
  assert.deepEqual(await trace(id), b);
  // 일시정지에서 롤백은 규칙이 안 풀려도 된다 (T32)
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "paused", "rolling_back", { audit }));
});

test("일시정지 진입: 가드레일 규칙도 실패 사유도 없으면 거부", { skip }, async () => {
  const id = await setup("syncing");
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "syncing", "paused", { audit })),
    { code: "GUARD_FAILED" });
});

// 【현재 동작】 워커 처리기가 조건에 걸리면 예외가 나고, pg-boss 재시도 뒤 작업만 실패로 끝난다.
// 이전은 같은 상태에 그대로 남고, failed/paused로 가는 전이도 감사 기록도 없다 → 화면에서는 "멈춘 채 진행 중"으로 보인다.
// 어디로 보낼지(paused? failed?)는 사람이 정할 일이라(deploy.ts의 TODO(human)과 같은 질문) 지금 동작만 고정해 둔다
test("【현재 동작】 처리기 조건 실패는 예외로 끝나고 이전은 같은 상태에 남는다 (흔적 없음)", { skip }, async () => {
  const id = await setup("syncing");
  const b = await trace(id);
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "syncing", "shifting",
    { mode: "ifStill", evidence: { replicationLagBytes: 4096, rowCountMatch: true }, next: next(id), audit })),
    { code: "GUARD_FAILED" }, "ifStill이어도 조건 실패는 false가 아니라 예외");
  assert.deepEqual(await trace(id), b);
});
