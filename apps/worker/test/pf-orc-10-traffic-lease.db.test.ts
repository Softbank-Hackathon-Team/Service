// PF FM-ORC-10: 트래픽 LB 가 워커 전역 하나여도 다른 이전(다른 회사)의 롤백·shift 가 지금 이전의 가중치를 덮지 않는다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
let core: typeof import("@svc/core");
let rollback: typeof import("../src/jobs/rollback.js");
let platform: typeof import("../src/platform.js");
let owner: pg.Client;
const T1 = randomUUID(), T2 = randomUUID();
const LB = `lb-pf-${randomUUID().slice(0, 8)}`;
const audit = { actor: "test", action: "t", target: "t", result: "ok" as const };

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "0";
  process.env.TRAFFIC_LB_ID = LB;
  core = await import("@svc/core");
  rollback = await import("../src/jobs/rollback.js");
  platform = await import("../src/platform.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf10-a'), ($2, 'pf10-b')", [T1, T2]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  delete process.env.TRAFFIC_LB_ID;
  await owner.query("DELETE FROM env_locks WHERE tenant_id = ANY($1::uuid[])", [[T1, T2]]);
  await owner.query("DELETE FROM traffic_leases WHERE lb_id = $1", [LB]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function setup(t: string, s: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, t]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`, [id, t, src, dst, s]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [src, dst, t, id]);
  return id;
}
const take = (t: string, id: string) => core.withTenant(t, (tx) => core.takeTrafficLease(tx, LB, id));

test("PF FM-ORC-10 정상: A 가 LB 주인(shift 50%)이면 B 의 롤백은 LB 를 안 건드리고 rolled_back, A 의 50% 그대로", { skip }, async () => {
  const a = await setup(T1, "shifting");
  const b = await setup(T2, "deploying");
  assert.equal(await take(T1, a), "mine");
  const sw = platform.trafficSwitcher();
  await sw.set(LB, { source: 0.5, target: 0.5 });
  await core.withTenant(T2, (tx) => core.advance(tx, { id: b, tenantId: T2 }, "deploying", "rolling_back",
    { audit, evidence: { reason: "B 배포 실패" }, failureCode: "ARGO_DEGRADED" }));
  assert.equal(await rollback.handleRollback({ tenantId: T2, requestId: "r", migrationId: b }), "advanced");
  assert.deepEqual(await sw.get(LB), { source: 0.5, target: 0.5 });
  assert.equal(await take(T2, b), "other", "B 는 A 가 쥔 동안 주인이 못 된다");
});

test("PF FM-ORC-10 거부: 남의 회사 이전 번호로 take → denied / 주인이 끝나면(advance 끝 상태) 놓여서 다음 이전이 가져감", { skip }, async () => {
  const a = await setup(T1, "shifting");
  assert.equal(await core.withTenant(T2, (tx) => core.takeTrafficLease(tx, LB, a)), "denied");
  const c = await setup(T2, "shifting");
  // 앞 시험의 A 가 아직 주인일 수 있다 → 그 주인을 끝내 본다
  const holder = (await owner.query("SELECT migration_id, tenant_id FROM traffic_leases WHERE lb_id=$1", [LB])).rows[0];
  if (holder) await owner.query("UPDATE migrations SET status='completed' WHERE id=$1", [holder.migration_id]);
  assert.equal(await take(T1, a), "mine", "끝난 주인의 줄은 다음 사람이 가져간다");
  assert.equal(await take(T2, c), "other");
  await core.withTenant(T1, (tx) => core.advance(tx, { id: a, tenantId: T1 }, "shifting", "rolling_back", { audit, evidence: { reason: "x" } }));
  assert.equal(await take(T2, c), "other", "롤백 중엔 아직 주인 (출발로 되돌리는 중)");
  await core.withTenant(T1, (tx) => core.advance(tx, { id: a, tenantId: T1 }, "rolling_back", "rolled_back",
    { audit, evidence: { sourceWeight100: true, sourceHealthy: true } }));
  assert.equal((await owner.query("SELECT count(*)::int n FROM traffic_leases WHERE migration_id=$1", [a])).rows[0].n, 0, "끝 상태에서 advance 가 놓음");
  assert.equal(await take(T2, c), "mine");
});
