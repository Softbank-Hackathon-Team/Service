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
const T = randomUUID(), O = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'conn-t'), ($2, 'conn-o')", [T, O]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false });
  await core.pool.end();
  await owner.end();
});

async function newEnv(status: string, provider = "aws", tenant = T) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status)
    VALUES ($1,$2,$3,'c',$4)`, [id, tenant, provider, status]);
  return id;
}
async function row(id: string) {
  return (await owner.query(
    "SELECT connection_status, verify_failures, failure_reason, last_verified_at FROM environments WHERE id=$1", [id])).rows[0];
}
async function auditCount(id: string) {
  return Number((await owner.query("SELECT count(*) FROM audit_events WHERE target=$1", [id])).rows[0].count);
}
const audit = { actor: "test", action: "environment.verify" };

test("정상: awaiting_customer → verifying + 확인 작업 큐, 감사 1줄", { skip }, async () => {
  const id = await newEnv("awaiting_customer");
  const r = await core.withTenant(T, (tx) => core.advanceConnection(tx, T, id, "verifying", {
    from: ["awaiting_customer", "failed"],
    verifyJob: { tenantId: T, requestId: "r1", reason: "user" }, audit }));
  assert.deepEqual(r, { from: "awaiting_customer", to: "verifying", jobQueued: true });
  assert.equal((await row(id)).connection_status, "verifying");
  assert.equal(await auditCount(id), 1);
});

test("큐 중복: 같은 키 작업이 대기 중이면 상태는 바뀌고 jobQueued=false (오류 아님)", { skip }, async () => {
  const id = await newEnv("failed");
  const key = core.jobKey("verify-connection", { envId: id });
  const first = await core.boss.send("verify-connection",
    { tenantId: T, requestId: "r0", envId: id, reason: "periodic" }, { singletonKey: key });
  assert.ok(first);
  const r = await core.withTenant(T, (tx) => core.advanceConnection(tx, T, id, "verifying", {
    verifyJob: { tenantId: T, requestId: "r2", reason: "user" }, audit }));
  assert.equal(r.jobQueued, false);
  assert.equal((await row(id)).connection_status, "verifying");
});

test("connected로 가면 실패 사유를 지우고 확인 시각·실패 수를 적는다", { skip }, async () => {
  const id = await newEnv("verifying");
  await owner.query("UPDATE environments SET failure_reason='ROLE_ASSUME_DENIED' WHERE id=$1", [id]);
  const r = await core.withTenant(T, (tx) => core.advanceConnection(tx, T, id, "connected",
    { touchVerified: true, failures: 0, audit }));
  assert.equal(r.jobQueued, null);
  const x = await row(id);
  assert.equal(x.failure_reason, null);
  assert.equal(x.verify_failures, 0);
  assert.ok(x.last_verified_at);
});

test("거부: 다른 회사 환경은 404, 상태 그대로", { skip }, async () => {
  const id = await newEnv("awaiting_customer", "aws", O);
  await assert.rejects(core.withTenant(T, (tx) => core.advanceConnection(tx, T, id, "verifying", { audit })),
    { status: 404, code: "NOT_FOUND" });
  assert.equal((await row(id)).connection_status, "awaiting_customer");
});

test("거부: verifying → awaiting_customer 는 409, aws draft → connected 도 409", { skip }, async () => {
  const v = await newEnv("verifying");
  await assert.rejects(core.withTenant(T, (tx) => core.advanceConnection(tx, T, v, "awaiting_customer", { audit })),
    (e: unknown) => e instanceof core.ConnectionTransitionError && (e as { status: number }).status === 409
      && (e as { code: string }).code === "INVALID_TRANSITION");
  const d = await newEnv("draft", "aws");
  await assert.rejects(core.withTenant(T, (tx) => core.advanceConnection(tx, T, d, "connected", { audit })),
    { status: 409, code: "INVALID_TRANSITION" });
  assert.equal((await row(d)).connection_status, "draft");
  assert.equal(await auditCount(d), 0);
  const p = await newEnv("draft", "onprem");
  await core.withTenant(T, (tx) => core.advanceConnection(tx, T, p, "connected", { audit }));
  assert.equal((await row(p)).connection_status, "connected");
});

test("거부: from 조건이 안 맞으면 409", { skip }, async () => {
  const id = await newEnv("connected");
  await assert.rejects(core.withTenant(T, (tx) => core.advanceConnection(tx, T, id, "unstable",
    { from: ["awaiting_customer"], audit })), { code: "INVALID_TRANSITION" });
});

test("마이그레이션 0024: verify_failures 기본 0, 같은 external_id 두 줄은 유일 위반", { skip }, async () => {
  const id = await newEnv("draft");
  assert.equal((await row(id)).verify_failures, 0);
  const ext = "ext-" + randomUUID();
  await owner.query("UPDATE environments SET external_id=$2 WHERE id=$1", [id, ext]);
  const other = await newEnv("draft", "aws", O);
  await assert.rejects(owner.query("UPDATE environments SET external_id=$2 WHERE id=$1", [other, ext]),
    { code: "23505" });
  await assert.rejects(owner.query("UPDATE environments SET verify_failures=-1 WHERE id=$1", [id]),
    { code: "23514" });
});
