// DB 시험 (작업 Z43 후속, z43-fixes.patch): F4 트래픽 실패 사유가 상태 칸까지 가는지, F3 plan 작업 키가 하나인지.
// 고치기 전 코드에서는 F4 첫 시험(failure_code가 null)과 F3 시험(jobKey가 plan:<도착 환경>)이 실패한다. DATABASE_URL·OWNER_DATABASE_URL이 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let lease: typeof import("../src/lease/index.js");
let shift: typeof import("../src/jobs/shift.js");
let precheck: typeof import("../src/jobs/precheck.js");
let owner: pg.Client;
const T = randomUUID();   // 감사 체인을 다른 시험과 섞지 않게 회사를 새로 만든다

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "0";
  process.env.TRAFFIC_TICK_MS = "1";
  // Z76: "0" 은 core 가 "값 없음"으로 보고 30초로 바꾼다(Z38 R3-9) → 이 시험이 30초 걸렸다. 아주 짧은 양수로 준다
  process.env.TRAFFIC_OBSERVE_SEC = "0.05";   // core를 읽기 전에 (OBSERVE_MIN_SEC는 읽을 때 정해진다). 100%에서 시계 관찰 사실상 생략
  core = await import("@svc/core");
  lease = await import("../src/lease/index.js");
  shift = await import("../src/jobs/shift.js");
  precheck = await import("../src/jobs/precheck.js");
  await core.startBoss();
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z43')", [T]);
});
after(async () => {
  if (skip) return;
  delete process.env.TRAFFIC_STUB_SCENARIO;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false });
  await lease.closeHeartbeatPool(); await core.pool.end(); await owner.end();
});

async function setup(status: string, locked: boolean) {
  const id = randomUUID(), s = randomUUID(), g = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, g, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,$5)`, [id, T, s, g, status]);
  if (locked) await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [s, g, T, id]);
  return { id, s, g };
}
const row = async (id: string) => (await owner.query(
  "SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];

test("F4: 지표 나쁨(5xx)으로 자동 롤백되면 failure_code = TRAFFIC_ERROR_RATE (감사 detail만이 아니라 상태 칸에도)", { skip }, async () => {
  process.env.TRAFFIC_STUB_SCENARIO = "err";
  try {
    const m = await setup("shifting", true);
    assert.equal(await shift.handleShift({ tenantId: T, requestId: "z43", migrationId: m.id }), "advanced");
    assert.deepEqual(await row(m.id), { status: "rolling_back", failure_code: "TRAFFIC_ERROR_RATE" });
    const a = (await owner.query(
      `SELECT detail FROM audit_events WHERE target=$1 AND action='shift.rolling_back'`, [m.id])).rows[0].detail;
    assert.equal(a.failureCode, "TRAFFIC_ERROR_RATE", "감사 detail에도 그대로 남는다");
  } finally { delete process.env.TRAFFIC_STUB_SCENARIO; }
});

test("F4: 정상 전환(100% 도달 → cutover)은 failure_code가 비어 있다 (예전과 같음)", { skip }, async () => {
  process.env.TRAFFIC_STUB_SCENARIO = "clean";
  try {
    const m = await setup("shifting", true);
    assert.equal(await shift.handleShift({ tenantId: T, requestId: "z43", migrationId: m.id }), "advanced");
    assert.deepEqual(await row(m.id), { status: "cutover", failure_code: null });
  } finally { delete process.env.TRAFFIC_STUB_SCENARIO; }
});

test("F3: plan 작업 키는 한 규칙 = plan:<이전 번호> (core jobKey와 precheck가 같은 값)", { skip }, async () => {
  const m = await setup("prechecking", false);
  assert.equal(core.jobKey("plan", { migrationId: m.id, targetEnvId: m.g }), `plan:${m.id}`);
  assert.equal(await precheck.handlePrecheck({ tenantId: T, requestId: "z43", migrationId: m.id }), "advanced");
  const j = await owner.query(
    `SELECT singleton_key FROM pgboss.job WHERE name='plan' AND data->>'migrationId' = $1`, [m.id]);
  assert.deepEqual(j.rows.map((x) => x.singleton_key), [`plan:${m.id}`]);
});
