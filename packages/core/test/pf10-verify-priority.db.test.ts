// PF10 (9회차 대량): 주기 재확인 작업이 잔뜩 쌓여 있어도 사람이 누른 연결 확인(user)이 먼저 집힌다.
//   DATABASE_URL·OWNER_DATABASE_URL 없으면 건너뜀
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
let core: typeof import("../src/index.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf10')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function newEnv(status: string) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$2,'aws','p',$3)`, [id, T, status]);
  return id;
}
const audit = { actor: "test", action: "environment.verify" };

test("user 확인은 priority 10, periodic 은 0 → 꺼내는 순서에서 user 가 먼저", { skip }, async () => {
  const periodic: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = await newEnv("connected");
    periodic.push(id);
    await core.withTenant(T, (tx) => core.advanceConnection(tx, T, id, "connected", {
      from: ["connected"], verifyJob: { tenantId: T, requestId: `p${i}`, reason: "periodic" }, audit }));
  }
  const user = await newEnv("awaiting_customer");
  const r = await core.withTenant(T, (tx) => core.advanceConnection(tx, T, user, "verifying", {
    from: ["awaiting_customer"], verifyJob: { tenantId: T, requestId: "u", reason: "user" }, audit }));
  assert.equal(r.jobQueued, true);
  const rows = (await owner.query(
    `SELECT data->>'envId' AS env, priority FROM pgboss.job WHERE name='verify-connection' AND data->>'tenantId'=$1 AND state='created'
      ORDER BY priority DESC, created_on`, [T])).rows as Array<{ env: string; priority: number }>;
  assert.equal(rows.length, 6);
  assert.equal(rows[0]!.env, user, "사람이 누른 확인이 맨 앞");
  assert.equal(rows[0]!.priority, core.VERIFY_USER_PRIORITY);
  assert.ok(rows.slice(1).every((x) => x.priority === 0 && periodic.includes(x.env)), "주기 재확인은 0");
});
