// VL1: advanceConnection 보강 — 사유 규칙, 곁 칸, 멱등, 동시성, 롤백, 감사. DB 없으면 건너뜀
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
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'conn-edge')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false });
  await core.pool.end();
  await owner.end();
});

async function newEnv(status: string, provider = "aws") {
  const id = randomUUID();
  await owner.query("INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$2,$3,'c',$4)", [id, T, provider, status]);
  return id;
}
const row = async (id: string) => (await owner.query(
  "SELECT connection_status, verify_failures, failure_reason, last_verified_at, link_issued_at FROM environments WHERE id=$1", [id])).rows[0];
const audits = async (id: string) => (await owner.query("SELECT action, detail FROM audit_events WHERE target=$1 ORDER BY seq", [id])).rows;
const audit = { actor: "test", action: "environment.edge" };
const go = (id: string, to: string, o: object = {}) => core.withTenant(T, (tx) => core.advanceConnection(tx, T, id, to as never, { audit, ...o }));

test("failure_reason: 안 주면 그대로, 주면 적고, connected 로 가면 지운다(설계: connected면 지움)", { skip }, async () => {
  const id = await newEnv("verifying");
  await go(id, "failed", { failureReason: "PERMISSION_MISSING:sqs:SendMessage" });
  assert.equal((await row(id)).failure_reason, "PERMISSION_MISSING:sqs:SendMessage");
  await go(id, "disconnected", {});
  assert.equal((await row(id)).failure_reason, "PERMISSION_MISSING:sqs:SendMessage", "안 주면 유지");
  const c = await newEnv("connected");
  await go(c, "unstable", { failures: 3, failureReason: "ROLE_ASSUME_DENIED" });
  let r = await row(c);
  assert.equal(r.failure_reason, "ROLE_ASSUME_DENIED");
  assert.equal(r.verify_failures, 3);
  await go(c, "unstable", {});
  assert.equal((await row(c)).verify_failures, 3, "failures 안 주면 유지");
  await go(c, "connected", { failureReason: "IGNORED", failures: 0, touchVerified: true });
  r = await row(c);
  assert.equal(r.failure_reason, null, "connected 는 사유를 지움(같이 줘도)");
  assert.equal(r.verify_failures, 0);
  assert.ok(r.last_verified_at);
  await go(c, "unstable", { failureReason: null });
  assert.equal((await row(c)).failure_reason, null, "null 을 명시하면 지움");
});

test("설계 어긋남 기록: connected → connected 에 failureReason 을 줘도 지워진다 (주기 재확인 1·2번째 실패 사유를 못 남김)", { skip }, async () => {
  const id = await newEnv("connected");
  await go(id, "connected", { failures: 1, failureReason: "PERMISSION_MISSING:x" });
  assert.equal((await row(id)).failure_reason, null);
  assert.equal((await row(id)).verify_failures, 1);
});

test("linkIssued: 링크 재발급(awaiting_customer → awaiting_customer)은 허용, link_issued_at 만 갱신", { skip }, async () => {
  const id = await newEnv("awaiting_customer");
  assert.equal((await row(id)).link_issued_at, null);
  const r = await go(id, "awaiting_customer", { linkIssued: true });
  assert.deepEqual(r, { from: "awaiting_customer", to: "awaiting_customer", jobQueued: null });
  const x = await row(id);
  assert.ok(x.link_issued_at);
  assert.equal(x.last_verified_at, null, "touchVerified 안 줬으면 그대로");
});

test("멱등: connected → connected 두 번 모두 성공, 감사는 두 줄", { skip }, async () => {
  const id = await newEnv("connected");
  await go(id, "connected", { touchVerified: true });
  await go(id, "connected", { touchVerified: true });
  assert.equal((await audits(id)).length, 2);
});

test("거부: disconnected 는 종점 — 어디로도 409, 감사·큐 흔적 없음", { skip }, async () => {
  const id = await newEnv("disconnected", "onprem");
  for (const to of ["connected", "awaiting_customer", "verifying"])
    await assert.rejects(go(id, to, { verifyJob: { tenantId: T, requestId: "x", reason: "user" } }), { status: 409, code: "INVALID_TRANSITION" });
  assert.equal((await audits(id)).length, 0);
  const q = await owner.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name='verify-connection' AND data->>'envId'=$1", [id]);
  assert.equal(q.rows[0].n, 0);
});

test("롤백: 확인 작업 내용이 잘못되면 던지고 상태도 바뀌지 않는다", { skip }, async () => {
  const id = await newEnv("awaiting_customer");
  await assert.rejects(go(id, "verifying", { verifyJob: { tenantId: "not-uuid", requestId: "x", reason: "user" } }));
  assert.equal((await row(id)).connection_status, "awaiting_customer");
  assert.equal((await audits(id)).length, 0);
});

test("롤백: 바깥 트랜잭션이 실패하면 상태·큐·감사 전부 되돌아간다", { skip }, async () => {
  const id = await newEnv("awaiting_customer");
  await assert.rejects(core.withTenant(T, async (tx) => {
    await core.advanceConnection(tx, T, id, "verifying", { audit, verifyJob: { tenantId: T, requestId: "rb", reason: "user" } });
    throw new Error("boom");
  }), /boom/);
  assert.equal((await row(id)).connection_status, "awaiting_customer");
  assert.equal((await audits(id)).length, 0);
  const q = await owner.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name='verify-connection' AND data->>'envId'=$1", [id]);
  assert.equal(q.rows[0].n, 0, "큐도 같은 트랜잭션이라 안 남음");
});

test("동시성: 같은 환경에 verifying 을 동시에 두 번 → 하나만 성공, 하나는 409", { skip }, async () => {
  const id = await newEnv("awaiting_customer");
  const attempt = (n: number) => go(id, "verifying", { from: ["awaiting_customer", "failed"], verifyJob: { tenantId: T, requestId: `c${n}`, reason: "user" } });
  const res = await Promise.allSettled([attempt(1), attempt(2)]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  const bad = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal((bad.reason as { code: string }).code, "INVALID_TRANSITION");
  assert.equal((await audits(id)).length, 1);
  const q = await owner.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name='verify-connection' AND data->>'envId'=$1", [id]);
  assert.equal(q.rows[0].n, 1);
});

test("감사 detail 에 from·to·jobQueued 가 자동으로 들어가고, 부르는 쪽 detail 은 보존된다", { skip }, async () => {
  const id = await newEnv("failed");
  await go(id, "verifying", { audit: { actor: "u", action: "environment.verify", detail: { reason: "user" } },
    verifyJob: { tenantId: T, requestId: "d", reason: "user" } });
  const [a] = await audits(id);
  assert.deepEqual(a.detail, { reason: "user", from: "failed", to: "verifying", jobQueued: true });
});

test("제약: failure_reason·verify_detail 은 jsonb/text 로 저장, verify_failures 음수 거부(advance 경유도)", { skip }, async () => {
  const id = await newEnv("connected");
  await assert.rejects(go(id, "connected", { failures: -1 }), { code: "23514" });
  assert.equal((await row(id)).verify_failures, 0);
});
