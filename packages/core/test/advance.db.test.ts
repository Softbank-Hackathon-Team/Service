// DB가 있어야 도는 시험. DATABASE_URL(app_user)과 OWNER_DATABASE_URL(표 주인)이 없으면 건너뛴다.
//   예) DATABASE_URL=postgres://app_user:app_pw@localhost:5432/platform \
//       OWNER_DATABASE_URL=postgres://platform_owner:owner_pw@localhost:5432/platform npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL;
const OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

type Core = typeof import("../src/index.js");
let core: Core;
let owner: pg.Client;
const T = randomUUID(), S = randomUUID(), G = randomUUID(), X = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-c')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$4,'aws','s','connected'), ($2,$4,'gcp','g','connected'), ($3,$4,'onprem','x','unstable')`, [S, G, X, T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false });
  await core.pool.end();
  await owner.end();
});

const audit = { actor: "test", action: "t", target: "t", result: "ok" as const };
async function newMigration(src = S, dst = G) {
  return core.withTenant(T, async (tx) => (await tx.query(
    "INSERT INTO migrations (tenant_id, source_env_id, target_env_id) VALUES ($1,$2,$3) RETURNING id",
    [T, src, dst])).rows[0].id as string);
}
async function status(id: string) {
  return core.withTenant(T, async (tx) =>
    (await tx.query("SELECT status, paused_from, failed_at_status, failure_code FROM migrations WHERE id=$1", [id])).rows[0]);
}
// 시험용으로 상태를 바로 놓는다 (표 주인 계정. 앱 코드는 이렇게 하면 안 된다)
async function force(id: string, s: string) {
  await owner.query("UPDATE migrations SET status=$2 WHERE id=$1", [id, s]);
}
async function addPlan(id: string, hash: string, expiresSql = "now() + interval '2 hours'") {
  await core.withTenant(T, async (tx) => tx.query(
    `INSERT INTO plans (tenant_id, migration_id, plan_doc, plan_hash, expires_at)
     VALUES ($1,$2,'{}',$3, ${expiresSql})`, [T, id, hash]));
}
const job = (id: string) => ({ queue: "import" as const, data: { tenantId: T, requestId: "r", migrationId: id } });

test("조건 실패: 연결 안 된 환경이면 GUARD_FAILED, 상태·큐 그대로", { skip }, async () => {
  const id = await newMigration(S, X);
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "draft", "importing",
    { next: job(id), audit })), { code: "GUARD_FAILED" });
  assert.equal((await status(id)).status, "draft");
});

test("큐 멱등성: 같은 작업 키가 대기 중이면 두 번째 advance는 통째로 취소", { skip }, async () => {
  const id = await newMigration();
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "draft", "importing", { next: job(id), audit }));
  await force(id, "draft");     // 같은 이전을 다시 시작하려는 상황을 흉내
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "draft", "importing",
    { next: job(id), audit })), { code: "JOB_NOT_CREATED" });
  assert.equal((await status(id)).status, "draft", "작업이 안 들어가면 상태도 안 바뀐다");
});

test("받는 쪽 멱등성: 기대 상태가 아니면 null + job.rejected 감사", { skip }, async () => {
  const id = await newMigration();
  const j = core.parseJob("import", { tenantId: T, requestId: "r2", migrationId: id });
  const r = await core.withTenant(T, (tx) => core.recheckMigration(tx, j, "import", "importing"));
  assert.equal(r, null);
  const a = await core.withTenant(T, async (tx) => (await tx.query(
    "SELECT detail FROM audit_events WHERE action='job.rejected' AND target=$1", [id])).rows);
  assert.equal(a.length, 1);
  assert.equal(a[0].detail.actual, "draft");
});

test("승인: 지문 일치 → 두 환경 예약, 다른 이전은 ENV_BUSY", { skip }, async () => {
  const a = await newMigration(); await force(a, "awaiting_approval"); await addPlan(a, "hA");
  const b = await newMigration(); await force(b, "awaiting_approval"); await addPlan(b, "hB");
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id: a, tenantId: T },
    "awaiting_approval", "approved", { evidence: { planHash: "wrong" }, audit })), { code: "GUARD_FAILED" });
  await core.withTenant(T, (tx) => core.advance(tx, { id: a, tenantId: T },
    "awaiting_approval", "approved", { evidence: { planHash: "hA" }, audit }));
  const locks = await core.withTenant(T, async (tx) =>
    (await tx.query("SELECT holder FROM env_locks WHERE migration_id=$1", [a])).rows);
  assert.equal(locks.length, 2);
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id: b, tenantId: T },
    "awaiting_approval", "approved", { evidence: { planHash: "hB" }, audit })), { code: "ENV_BUSY" });
  // 자원 생성 시작은 잠금을 쥔 a만
  await core.withTenant(T, (tx) => core.advance(tx, { id: a, tenantId: T }, "approved", "provisioning", { audit }));
  // 취소하면 잠금이 풀린다 → b 승인 가능 (a를 정리: provisioning → failed → cancelled)
  await core.withTenant(T, (tx) => core.advance(tx, { id: a, tenantId: T }, "provisioning", "failed",
    { failureCode: "APPLY_FAILED", audit }));
  const fa = await status(a);
  assert.equal(fa.failed_at_status, "provisioning"); assert.equal(fa.failure_code, "APPLY_FAILED");
  // Z1 DRAFT(ai): provisioning 이하의 실패는 잠금을 푼다 (예전: 남김 → 같은 환경 다음 이전이 ENV_BUSY, W·X 재현)
  assert.equal((await core.withTenant(T, async (tx) =>
    (await tx.query("SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [a])).rows[0].n)), 0,
    "이른 실패(provisioning)는 잠금을 푼다");
  await core.withTenant(T, (tx) => core.advance(tx, { id: b, tenantId: T },
    "awaiting_approval", "approved", { evidence: { planHash: "hB" }, audit }));
  await core.withTenant(T, (tx) => core.advance(tx, { id: a, tenantId: T }, "failed", "cancelled",
    { evidence: { manualCleanupConfirmed: true }, audit }));
  await core.withTenant(T, (tx) => core.advance(tx, { id: b, tenantId: T }, "approved", "cancelled", { audit }));
});

test("일시정지: paused_from 저장, 다른 상태로 재개는 막힘", { skip }, async () => {
  const id = await newMigration(); await force(id, "syncing");
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "syncing", "paused",
    { evidence: { guardrailRule: "MG-2-07" }, audit }));
  assert.equal((await status(id)).paused_from, "syncing");
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "paused", "cutover",
    { evidence: { ruleCleared: true }, audit })), { code: "INVALID_TRANSITION" }, "VALID에 없는 길");
  await assert.rejects(core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "paused", "deploying",
    { evidence: { ruleCleared: true }, audit })), { code: "GUARD_FAILED" });
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "paused", "syncing",
    { evidence: { ruleCleared: true }, audit }));
  assert.equal((await status(id)).paused_from, null);
});

test("HTTP 멱등 키: 동시에 같은 키 둘 → 이전 1개, 다른 본문 → 409", { skip }, async () => {
  const key = { key: `k-${randomUUID()}`, reqHash: core.requestHash("POST", "/migrations", { a: 1 }) };
  const run = () => core.withIdempotency(T, key, async (tx) => {
    const id = (await tx.query(
      "INSERT INTO migrations (tenant_id, source_env_id, target_env_id) VALUES ($1,$2,$3) RETURNING id",
      [T, S, G])).rows[0].id;
    await new Promise((r) => setTimeout(r, 300));    // 두 번째 요청이 기다리게
    return { status: 202, body: { id } };
  });
  const [r1, r2] = await Promise.all([run(), run()]);
  assert.equal(r1.body.id, r2.body.id);
  assert.deepEqual([r1.replayed, r2.replayed].sort(), [false, true]);
  await assert.rejects(core.withIdempotency(T, { ...key, reqHash: "other" },
    async () => ({ status: 202, body: {} })), { code: "IDEMPOTENCY_KEY_REUSED" });
});

test("회사 벽: 다른 회사의 환경 번호로는 이전을 만들 수 없다 (0005 외래 키)", { skip }, async () => {
  const other = randomUUID(), otherEnv = randomUUID();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'other')", [other]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status)
    VALUES ($1,$2,'aws','o','connected')`, [otherEnv, other]);
  await assert.rejects(newMigration(S, otherEnv), { code: "23503" });
  await assert.rejects(newMigration(otherEnv, G), { code: "23503" });
});
