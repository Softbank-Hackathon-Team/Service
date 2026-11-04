// pf-d (Jeong 결정 01:53Z): 실패 진입 때 트래픽을 출발 100% 로 — 멱등, 되돌리기 직전 단계 기록(재시도는 그 단계부터), 실패는 분명한 오류
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DB 없음" : false;
let core: typeof import("@svc/core");
let platform: typeof import("../src/platform.js");
let tr: typeof import("../src/traffic-restore.js");
let owner: pg.Client;
const T = randomUUID(), M = randomUUID(), N = randomUUID();
const fast = { sleep: async () => {} };

before(async () => {
  if (skip) return;
  delete process.env.TRAFFIC_PROVIDER; delete process.env.TRAFFIC_LB_ID;
  core = await import("@svc/core"); platform = await import("../src/platform.js"); tr = await import("../src/traffic-restore.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  const s = randomUUID(), d = randomUUID();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-d-restore')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, d, T]);
  for (const m of [M, N]) await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'shifting')`, [m, T, s, d]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("되돌리기 정상: 50% → 출발 100%, 감사 traffic.restored(fromPct 50), 두 번 불러도 같음(멱등, 기록 안 덮음)", { skip }, async () => {
  // 이전별 LB 자리(DB) 등록 → trafficFor 가 그 줄을 쓴다
  await core.withTenant(T, (tx) => core.upsertTrafficTarget(tx, T, M, { provider: "mock", lbId: `lb-${M}` }, "test"));
  const { switcher, lbId, from } = await platform.trafficFor(T, M);
  assert.equal(from, "db");
  await switcher.set(lbId, { source: 0.5, target: 0.5 });
  const a = await tr.restoreTrafficToSource(T, M, { ...fast, reason: "apply failed" });
  assert.deepEqual([a.ok, a.lbId, a.lbFrom, a.fromPct, a.alreadyRestored], [true, `lb-${M}`, "db", 50, false]);
  assert.deepEqual(await switcher.get(lbId), { source: 1, target: 0 });
  const b = await tr.restoreTrafficToSource(T, M, fast);
  assert.equal(b.alreadyRestored, true);
  assert.equal(await tr.restoredFromPct(T, M), 50, "재시도는 50% 단계부터");
  const rows = (await owner.query(`SELECT detail FROM audit_events WHERE target = $1 AND action = 'traffic.restored'`, [M])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail.reason, "apply failed");
});

test("되돌리기 거부: LB 가 계속 실패하면 3번 다시 한 뒤 TrafficRestoreFailed(TRAFFIC_RESTORE_FAILED, 이유·고칠 곳), 기록 없음", { skip }, async () => {
  await core.withTenant(T, (tx) => core.upsertTrafficTarget(tx, T, N, { provider: "mock", lbId: `lb-${N}` }, "test"));
  const { switcher, lbId } = await platform.trafficFor(T, N);
  await switcher.set(lbId, { source: 0.9, target: 0.1 });
  const orig = switcher.set; let n = 0;
  (switcher as { set: typeof orig }).set = async () => { n++; throw new Error("cloudflare 503"); };
  try {
    await assert.rejects(tr.restoreTrafficToSource(T, N, fast), (e: unknown) =>
      e instanceof tr.TrafficRestoreFailed && e.code === "TRAFFIC_RESTORE_FAILED" && e.attempts === 3 && /cloudflare 503/.test(e.message) && /대시보드/.test(e.message));
    assert.ok(n >= 3);
  } finally { (switcher as { set: typeof orig }).set = orig; }
  assert.equal(await tr.restoredFromPct(T, N), null);
});
