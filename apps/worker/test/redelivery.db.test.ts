// DB 시험(작업 Z12) 시나리오 1-B: 같은 단계 작업이 두 워커에 동시에·두 번 배달될 때 상태가 한 번만 움직이는가.
// 실제로 생기는 경우:
//  - 워커가 ③(advance) COMMIT 뒤, pg-boss에 "끝났다"를 알리기 전에 죽음 → 작업 만료 뒤 다른 워커가 같은 작업을 다시 받음
//  - 죽은 줄 알았던 워커가 깨어나 같은 작업을 계속함 (늦은 워커)
// 방법: 큐를 거치지 않고 처리 함수를 직접 부른다. 단계마다 같은 작업 내용을 "워커 A·B"가 동시에 부르고(Promise.all),
//       끝난 뒤 한 번 더 부른다(늦은 재배달). 다른 시험 파일(plans.it·report.it)의 워커가 advance가 넣은 큐 작업을 집어
//       "세 번째 워커"가 될 수 있다 → 누가 이겼는지는 보지 않고, 끝난 뒤 불변식만 본다.
// 불변식: 단계별 전이 감사 줄 = 정확히 1, version = 전이 수, 최종 completed, 남은 환경 잠금 0.
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
const T = randomUUID();

let core: typeof import("@svc/core");
let H: typeof import("../src/jobs/index.js")["HANDLERS"];
let owner: pg.Client;

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "60";          // 두 워커가 ② 일을 하는 동안 겹치게 (0이면 겹침이 거의 안 생김)
  process.env.ROLLBACK_WINDOW_SEC = "0";     // 창 0초 → cleanup 바로 가능
  process.env.TRAFFIC_TICK_MS = "1";
  core = await import("@svc/core");
  H = (await import("../src/jobs/index.js")).HANDLERS;
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z12-redelivery')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

const EXPIRES = () => new Date(Date.now() + 2 * 3600_000).toISOString();
const planDoc = (planId: string, migrationId: string, expiresAt: string) => ({
  planId, migrationId, adapterVersion: "test", steps: [], precheck: [],
  rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
  tfPlanHash: "tf", helmValuesHash: "hv", planHash: "hp", expiresAt });

// provisioning 상태 이전 + 계획·승인·예약 잠금 (start 직후 모습)
async function seedProvisioning() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID(), planId = randomUUID(), exp = EXPIRES();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'provisioning')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
    VALUES ($1,$2,$3,$4,'hp',$5)`, [planId, T, id, JSON.stringify(planDoc(planId, id, exp)), exp]);
  await owner.query(`INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash)
    VALUES ($1,$2,$3,'approve','user:dev','hp')`, [T, planId, id]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved',$5), ($2,$3,$4,'reserved',$5)`, [src, dst, T, id, exp]);
  return { id, planId };
}

// 상태 → (큐, 작업 내용). 처리 함수는 HANDLERS 그대로
function jobFor(status: string, m: { id: string; planId: string }) {
  const base = { tenantId: T, requestId: `z12-${randomUUID().slice(0, 8)}`, migrationId: m.id };
  const q: Record<string, string> = { provisioning: "apply", deploying: "deploy", syncing: "sync",
    shifting: "shift", cutover: "cutover", rollback_window: "cleanup", cleanup: "cleanup" };
  if (!q[status]) return null;
  return { queue: q[status]!, data: status === "provisioning" ? { ...base, planId: m.planId, planHash: "hp" } : base };
}
const st = async (id: string) => (await owner.query("SELECT status, version FROM migrations WHERE id=$1", [id])).rows[0];

// 한 이전을 끝까지: 단계마다 A·B 동시 + 늦은 재배달 1번
async function driveWithDuplicates(m: { id: string; planId: string }) {
  const results: Record<string, string[]> = {};
  for (let i = 0; i < 30; i++) {
    const s = (await st(m.id)).status as string;
    if (s === "completed") break;
    const j = jobFor(s, m);
    assert.ok(j, `예상 못 한 상태: ${s}`);
    const h = H[j.queue as keyof typeof H]!;
    const settle = (p: Promise<unknown>) => p.then((r) => String(r), (e: Error & { code?: string }) => `err:${e.code ?? e.message}`);
    const [a, b] = await Promise.all([settle(h(j.data)), settle(h(j.data))]);   // 워커 A·B 동시에
    const late = await settle(h(j.data));                                         // 늦게 깨어난 워커
    (results[`${s}`] ??= []).push(a, b, late);
  }
  return results;
}

const STEP_ACTIONS = ["apply.deploying", "deploy.syncing", "sync.shifting", "shift.cutover",
  "cutover.rollback_window", "cleanup.cleanup", "cleanup.completed"];

test("동시 2배달 + 늦은 재배달: 단계마다 전이 1번, 최종 completed, version = 7, 잠금 0", { skip, timeout: 60_000 }, async () => {
  const m = await seedProvisioning();
  const v0 = (await st(m.id)).version as number;
  const t0 = performance.now();
  const res = await driveWithDuplicates(m);
  const ms = performance.now() - t0;
  const fin = await st(m.id);
  assert.equal(fin.status, "completed", JSON.stringify(res));
  assert.equal(fin.version - v0, STEP_ACTIONS.length, "전이 수만큼만 version이 올라야 한다");
  const a = await owner.query(
    `SELECT action, count(*)::int n FROM audit_events WHERE target=$1 AND action = ANY($2) GROUP BY action`,
    [m.id, STEP_ACTIONS]);
  const counts = Object.fromEntries(a.rows.map((r) => [r.action, r.n]));
  for (const act of STEP_ACTIONS) assert.equal(counts[act], 1, `${act} 감사 줄 수: ${counts[act]}`);
  const locks = await owner.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [m.id]);
  assert.equal(locks.rows[0].n, 0);
  // 처리 결과 분포: 각 단계에서 "advanced"는 최대 1번 (다른 파일 워커가 이겼으면 0번)
  for (const [s, r] of Object.entries(res)) {
    const adv = r.filter((x) => x === "advanced").length;
    assert.ok(adv <= 1, `${s}: advanced ${adv}번 ${r.join(",")}`);
  }
  console.log(`[z12] redelivery x3 per step: ${ms.toFixed(0)} ms, results ${JSON.stringify(res)}`);
});

test("늦은 워커의 ② 일은 다시 실행된다 (STUB이라 무해) — 진짜 어댑터면 멱등이어야 함을 기록", { skip }, async () => {
  // 현재 동작 고정: ① 재확인은 둘 다 통과할 수 있어 ② 일이 두 번 돈다. 막는 것은 ③의 FOR UPDATE + ifStill 뿐
  const m = await seedProvisioning();
  let works = 0;
  const { runStep } = await import("../src/jobs/_step.js");
  const def = { name: "z12probe", expect: "provisioning" as const,
    work: async () => { works++; await new Promise((r) => setTimeout(r, 80));
      return { to: "failed" as const, failureCode: "Z12_PROBE" }; } };
  const job = { tenantId: T, requestId: "z12-probe", migrationId: m.id };
  const [a, b] = await Promise.all([runStep(job, def), runStep(job, def)]);
  assert.equal(works, 2, "② 일이 두 번 실행됨 (현재 동작)");
  assert.deepEqual([a, b].sort(), ["advanced", "skipped"]);
  const n = await owner.query("SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='z12probe.failed'", [m.id]);
  assert.equal(n.rows[0].n, 1);
});
