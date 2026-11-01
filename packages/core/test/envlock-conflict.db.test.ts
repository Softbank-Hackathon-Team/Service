// DB 시험(작업 P): 같은 환경을 고치려는 두 이전이 동시에 승인될 때 (env lock 충돌).
// 기대: 정확히 하나만 approved, 나머지는 409 ENV_BUSY + awaiting_approval 그대로, 진 쪽 흔적(잠금 줄·감사) 0.
// 방향이 엇갈린 두 이전(S→G, G→S)도 교착(40P01) 없이 끝나야 한다 (잠금 순서를 환경 번호로 정렬).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("../src/index.js");
let owner: pg.Client;
const T = randomUUID();
const audit = { actor: "test", action: "envlock", target: "t", result: "ok" as const };
const ROUNDS = 5;

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-p-envlock')", [T]);
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.pool.end(); await owner.end();
});

async function envs(n: number) {
  const ids = Array.from({ length: n }, () => randomUUID());
  for (const id of ids)
    await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status)
      VALUES ($1,$2,'aws','e','connected')`, [id, T]);
  return ids;
}
// 승인 직전 상태의 이전 (계획 h-<id> 붙임)
async function awaiting(src: string, dst: string) {
  const id = randomUUID();
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'awaiting_approval')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO plans (tenant_id, migration_id, plan_doc, plan_hash, expires_at)
    VALUES ($1,$2,'{}',$3, now() + interval '2 hours')`, [T, id, `h-${id}`]);
  return id;
}
const approve = (id: string) => core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T },
  "awaiting_approval", "approved", { evidence: { planHash: `h-${id}` }, audit: { ...audit, target: id } }));
const settle = async (id: string) => {
  try { await approve(id); return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); }
};
const st = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status;
const locksOf = async (id: string) => (await owner.query(
  "SELECT count(*)::int n FROM env_locks WHERE migration_id=$1", [id])).rows[0].n as number;
const auditOf = async (id: string) => (await owner.query(
  "SELECT count(*)::int n FROM audit_events WHERE target=$1", [id])).rows[0].n as number;
const release = (id: string) => owner.query("DELETE FROM env_locks WHERE migration_id=$1", [id]);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

test(`같은 두 환경, 동시 승인 ×${ROUNDS}: 매번 정확히 하나만 approved, 진 쪽 흔적 0`, { skip }, async () => {
  const ms: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const [S, G] = await envs(2);
    const a = await awaiting(S!, G!), b = await awaiting(S!, G!);
    const t0 = performance.now();
    const r = await Promise.all([settle(a), settle(b)]);
    ms.push(performance.now() - t0);
    assert.deepEqual([...r].sort(), ["ENV_BUSY", "ok"], `round ${i}: ${r}`);
    const loser = r[0] === "ok" ? b : a, winner = r[0] === "ok" ? a : b;
    assert.equal(await st(winner), "approved");
    assert.equal(await st(loser), "awaiting_approval");
    assert.equal(await locksOf(winner), 2);
    assert.equal(await locksOf(loser), 0, "진 쪽은 먼저 넣은 잠금 줄까지 같이 취소");
    assert.equal(await auditOf(loser), 0, "진 쪽 감사 기록 없음");
    await release(winner);
  }
  console.log(`concurrent approve x2: median ${median(ms).toFixed(1)} ms over ${ROUNDS} rounds`);
});

test(`엇갈린 방향(S→G, G→S) 동시 승인 ×${ROUNDS}: 교착 없이 하나만`, { skip }, async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const [S, G] = await envs(2);
    const a = await awaiting(S!, G!), b = await awaiting(G!, S!);
    const r = await Promise.all([settle(a), settle(b)]);
    assert.ok(!r.includes("40P01"), `deadlock in round ${i}`);
    assert.deepEqual([...r].sort(), ["ENV_BUSY", "ok"], `round ${i}: ${r}`);
    await release(a); await release(b);
  }
});

test("한쪽만 겹침: S→G가 쥐면 G→X는 ENV_BUSY, 안 겹치는 X→Y는 통과", { skip }, async () => {
  const [S, G, X, Y] = await envs(4);
  const a = await awaiting(S!, G!), b = await awaiting(G!, X!), c = await awaiting(X!, Y!);
  await approve(a);
  assert.equal(await settle(b), "ENV_BUSY");
  assert.equal(await settle(c), "ok");
  await release(a); await release(c);
});

test("세 이전이 같은 도착 환경 하나를 두고 동시에: 정확히 하나만", { skip }, async () => {
  const [S1, S2, S3, G] = await envs(4);
  const ids = [await awaiting(S1!, G!), await awaiting(S2!, G!), await awaiting(S3!, G!)];
  const r = await Promise.all(ids.map(settle));
  assert.equal(r.filter((x) => x === "ok").length, 1, String(r));
  assert.equal(r.filter((x) => x === "ENV_BUSY").length, 2, String(r));
  for (const id of ids) await release(id);
});

test("예약 기한이 지나도 다른 이전이 바로 못 뺏는다 (청소가 낡음 처리한 뒤에만)", { skip }, async () => {
  const [S, G] = await envs(2);
  const a = await awaiting(S!, G!), b = await awaiting(S!, G!);
  await approve(a);
  // a의 예약 기한이 지났고 아직 청소 작업이 안 돈 순간. 전부 한 트랜잭션 안에서 해서
  // "기한 지난 줄"이 확정되지 않게 한다 (다른 시험 파일의 청소 작업이 건드리지 못하게)
  const r = await core.withTenant(T, async (tx) => {
    await tx.query("UPDATE env_locks SET lease_expires_at = now() - interval '1 second' WHERE migration_id=$1", [a]);
    await tx.query("SAVEPOINT s");
    let first: string;
    try {
      await core.advance(tx, { id: b, tenantId: T }, "awaiting_approval", "approved",
        { evidence: { planHash: `h-${b}` }, audit });
      first = "ok";
    } catch (e) { await tx.query("ROLLBACK TO SAVEPOINT s"); first = (e as { code?: string }).code ?? "?"; }
    // 청소 작업이 하는 일: a를 낡음으로 (잠금 해제) → 그 뒤 b 승인
    await core.advance(tx, { id: a, tenantId: T }, "approved", "stale", { mode: "ifStill", audit });
    await core.advance(tx, { id: b, tenantId: T }, "awaiting_approval", "approved",
      { evidence: { planHash: `h-${b}` }, audit });
    return first;
  });
  assert.equal(r, "ENV_BUSY", "DRAFT(ai) 규칙: 기한 지남 ≠ 환경 빔");
  assert.equal(await st(a), "stale"); assert.equal(await locksOf(a), 0);
  assert.equal(await st(b), "approved"); assert.equal(await locksOf(b), 2);
  await release(b);
});

test("같은 이전을 두 번 동시에 승인(더블 클릭, 멱등 키 없음): 하나는 approved, 하나는 INVALID_TRANSITION", { skip }, async () => {
  const [S, G] = await envs(2);
  const a = await awaiting(S!, G!);
  const r = await Promise.all([settle(a), settle(a)]);
  assert.deepEqual([...r].sort(), ["INVALID_TRANSITION", "ok"]);
  assert.equal(await locksOf(a), 2);
  await release(a);
});
