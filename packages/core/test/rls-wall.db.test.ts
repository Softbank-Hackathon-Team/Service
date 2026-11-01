// DB 시험(작업 P): 회사 벽(RLS). 앱 계정(app_user)으로 회사 A의 트랜잭션 안에서 회사 B의 줄을
// 읽기·고치기·지우기·만들기·상태 옮기기·잠금 인수가 모두 막히는지 본다. 회사 표시가 없으면 아무것도 안 보여야 한다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("../src/index.js");
let owner: pg.Client;
const A = randomUUID(), B = randomUUID();
const B_S = randomUUID(), B_G = randomUUID(), A_S = randomUUID(), A_G = randomUUID();
const B_M = randomUUID(), B_PLAN = randomUUID();
const audit = { actor: "test", action: "rls", target: "t", result: "ok" as const };
// 회사 벽이 걸린 표 전부 (0001·0003·0004)
const WALLED = ["environments", "migrations", "spec_versions", "env_locks", "audit_events",
  "idempotency_keys", "plans", "plan_approvals"];

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-p-rls-a'), ($2,'test-p-rls-b')", [A, B]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$5,'aws','as','connected'), ($2,$5,'gcp','ag','connected'),
    ($3,$6,'aws','bs','connected'), ($4,$6,'gcp','bg','connected')`, [A_S, A_G, B_S, B_G, A, B]);
  // 회사 B의 줄을 표마다 하나씩 (B의 회사 트랜잭션으로 만든다)
  await core.withTenant(B, async (tx) => {
    await tx.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
      VALUES ($1,$2,$3,$4,'awaiting_approval')`, [B_M, B, B_S, B_G]);
    await tx.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta)
      VALUES ($1,$2,1,'{}','{}')`, [B, B_M]);
    await tx.query(`INSERT INTO plans (id, tenant_id, migration_id, plan_doc, plan_hash, expires_at)
      VALUES ($1,$2,$3,'{}','hb', now() + interval '2 hours')`, [B_PLAN, B, B_M]);
    await tx.query(`INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash)
      VALUES ($1,$2,$3,'reject','user:b','hb')`, [B, B_PLAN, B_M]);
    await tx.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
      VALUES ($1,$2,$3,'worker:b', now() + interval '90 seconds')`, [B_G, B, B_M]);
    await tx.query(`INSERT INTO idempotency_keys (tenant_id, key, req_hash, status_code, response)
      VALUES ($1,'shared-key-123','hash-b',202,'{"who":"b"}')`, [B]);
    await core.writeAudit(tx, B, { ...audit, target: B_M });
  });
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id = ANY($1)", [[A, B]]);
  await core.pool.end(); await owner.end();
});

const asA = <T>(fn: (tx: import("../src/index.js").Tx) => Promise<T>) => core.withTenant(A, fn);

test("읽기: 회사 A 트랜잭션에서 회사 B의 줄은 표 8개 모두 0줄", { skip }, async () => {
  for (const t of WALLED) {
    const n = await asA(async (tx) => (await tx.query(
      `SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [B])).rows[0].n);
    assert.equal(n, 0, `${t}: B 줄이 보인다`);
    const own = (await owner.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [B])).rows[0].n;
    assert.ok(own >= 1, `${t}: 시험 준비 줄이 없다`);
  }
});

test("고치기·지우기: B의 이전·잠금·멱등 키를 A에서 UPDATE/DELETE → 0줄, 실제 값 그대로", { skip }, async () => {
  const r = await asA(async (tx) => ({
    upd: (await tx.query("UPDATE migrations SET status='cancelled' WHERE id=$1", [B_M])).rowCount,
    del: (await tx.query("DELETE FROM env_locks WHERE env_id=$1", [B_G])).rowCount,
    key: (await tx.query("UPDATE idempotency_keys SET response='{}' WHERE key='shared-key-123'")).rowCount,
    plan: (await tx.query("UPDATE plans SET status='approved' WHERE id=$1", [B_PLAN])).rowCount,
  }));
  assert.deepEqual(r, { upd: 0, del: 0, key: 0, plan: 0 });
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [B_M])).rows[0].status, "awaiting_approval");
  assert.equal((await owner.query("SELECT count(*)::int n FROM env_locks WHERE env_id=$1", [B_G])).rows[0].n, 1);
});

test("만들기: A 트랜잭션에서 tenant_id=B 줄 INSERT → RLS 위반(42501)", { skip }, async () => {
  await assert.rejects(asA((tx) => tx.query(`INSERT INTO migrations (tenant_id, source_env_id, target_env_id)
    VALUES ($1,$2,$3)`, [B, B_S, B_G])), { code: "42501" });
  await assert.rejects(asA((tx) => tx.query(`INSERT INTO audit_events (tenant_id, actor, action, target, result, prev_hash, hash)
    VALUES ($1,'x','forged','x','ok','0','0')`, [B])), { code: "42501" });
});

test("만들기(외래 키): A가 자기 tenant_id로 B의 환경·이전을 가리키는 줄 → 23503", { skip }, async () => {
  await assert.rejects(asA((tx) => tx.query(`INSERT INTO migrations (tenant_id, source_env_id, target_env_id)
    VALUES ($1,$2,$3)`, [A, A_S, B_G])), { code: "23503" });
  // A의 이전이 B의 환경 잠금을 쥐려는 시도
  const aM = await asA(async (tx) => (await tx.query(`INSERT INTO migrations (tenant_id, source_env_id, target_env_id)
    VALUES ($1,$2,$3) RETURNING id`, [A, A_S, A_G])).rows[0].id as string);
  await assert.rejects(asA((tx) => tx.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$2,$3,'reserved', now() + interval '1 hour')`, [B_S, A, aM])), { code: "23503" });
});

test("상태 옮기기·잠금: A에서 B의 이전 advance → NOT_FOUND, B 잠금 인수·연장 → 실패", { skip }, async () => {
  await assert.rejects(asA((tx) => core.advance(tx, { id: B_M, tenantId: A }, "awaiting_approval", "approved",
    { evidence: { planHash: "hb" }, audit })), { code: "NOT_FOUND" });
  // tenantId를 B로 속여 넘겨도 트랜잭션의 회사 표시는 A라 못 본다
  await assert.rejects(asA((tx) => core.advance(tx, { id: B_M, tenantId: B }, "awaiting_approval", "cancelled",
    { audit })), { code: "NOT_FOUND" });
  assert.equal(await asA((tx) => core.acquireEnvLock(tx, { migrationId: B_M, envId: B_G, holder: "worker:a" })), false);
  assert.deepEqual(await asA((tx) => core.renewEnvLocks(tx, { migrationId: B_M, envIds: [B_G], holder: "worker:b" })), []);
  assert.equal(await asA((tx) => core.releaseEnvLocks(tx, B_M)), 0);
  assert.equal((await owner.query("SELECT holder FROM env_locks WHERE env_id=$1", [B_G])).rows[0].holder, "worker:b");
});

test("멱등 키: 같은 키 문자열이라도 회사가 다르면 남의 응답을 재생하지 않는다", { skip }, async () => {
  const r = await core.withIdempotency(A, { key: "shared-key-123", reqHash: "hash-a" },
    async () => ({ status: 202, body: { who: "a" } }));
  assert.deepEqual(r, { status: 202, body: { who: "a" }, replayed: false });
});

test("회사 표시 없음: withTenant 밖(pool 직접)이나 빈 값이면 모든 표 0줄", { skip }, async () => {
  for (const t of WALLED) {
    const n = (await core.pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
    assert.equal(n, 0, `${t}: 회사 표시 없이 보인다`);
  }
  const c = await core.pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT set_config('app.tenant_id', '', true)");
    assert.equal((await c.query("SELECT count(*)::int n FROM migrations")).rows[0].n, 0);
    await c.query("ROLLBACK");
  } finally { c.release(); }
});

test("트랜잭션이 끝나면 회사 표시도 사라진다 (연결 재사용 때 새지 않음)", { skip }, async () => {
  await asA(async (tx) => tx.query("SELECT 1"));
  // pool max 10: 연결을 여러 번 빌려도 앞 트랜잭션의 A 표시가 남아 있지 않아야 한다
  for (let i = 0; i < 12; i++) {
    const v = (await core.pool.query("SELECT current_setting('app.tenant_id', true) AS v")).rows[0].v;
    assert.ok(v === null || v === "", `연결에 회사 표시가 남음: ${v}`);
  }
});

test("청소 함수(SECURITY DEFINER)는 번호·상태만 준다: 앱 계정이 그 함수로 남의 표 내용을 읽지 못함", { skip }, async () => {
  const cols = (await core.pool.query("SELECT * FROM maint_expired_env_locks(1)")).fields.map((f) => f.name);
  assert.deepEqual(cols.sort(), ["env_id", "holder", "job_id", "job_queue", "migration_id", "status", "tenant_id"].sort());
  // 앱 계정이 청소 역할로 바꿔 타지 못한다
  await assert.rejects(core.pool.query("SET ROLE svc_maintenance"), { code: "42501" });
});
