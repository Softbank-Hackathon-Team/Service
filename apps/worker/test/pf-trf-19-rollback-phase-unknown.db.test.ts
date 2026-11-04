// PF TRF-19: 컷오버를 지난 이전의 롤백에서 DB 방향(phase)을 못 읽으면 트래픽을 출발로 보내지 않고 멈춘다 (DB 먼저 원칙)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DB 없음" : false;
let core: typeof import("@svc/core");
let rollback: typeof import("../src/jobs/rollback.js");
let owner: pg.Client;
const T = randomUUID();
const DEAD = "postgres://nobody:x@127.0.0.1:1/none?connect_timeout=1";
const KEYS = ["REPL_SOURCE_URL", "REPL_SOURCE_PEER_URL", "REPL_TARGET_URL", "REPL_TARGET_PEER_URL", "REPL_TABLES", "ROLLBACK_MAX_ATTEMPTS"];
const saved: Record<string, string | undefined> = {};

before(async () => {
  if (skip) return;
  for (const k of KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { REPL_SOURCE_URL: DEAD, REPL_SOURCE_PEER_URL: DEAD, REPL_TARGET_URL: DEAD, REPL_TARGET_PEER_URL: DEAD, REPL_TABLES: "orders" });
  core = await import("@svc/core");
  rollback = await import("../src/jobs/rollback.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-trf-19')", [T]);
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  await core.pool.end(); await owner.end();
});

async function mig(passedCutover: boolean): Promise<string> {
  const M = randomUUID();
  // 환경 하나에 이전 하나라 시험마다 환경을 새로 만든다 (잠금)
  const s = randomUUID(), d = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, d, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'rolling_back')`, [M, T, s, d]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$3,$4,'reserved', now() + interval '10 minutes'), ($2,$3,$4,'reserved', now() + interval '10 minutes')`, [s, d, T, M]);
  if (passedCutover)
    await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "cutover.rollback_window", target: M, result: "ok",
      detail: { from: "cutover", to: "rollback_window" } }));
  return M;
}
async function lastError(M: string): Promise<string> {
  const r = await owner.query(`SELECT detail->>'error' AS e FROM audit_events WHERE target=$1 AND detail ? 'error' ORDER BY seq DESC LIMIT 1`, [M]);
  return r.rows[0]?.e ?? "";
}

test("PF TRF-19 거부: 컷오버 뒤 + DB 방향 못 읽음 → 트래픽 안 건드리고 실패 기록, 상태 rolling_back 그대로", { skip }, async () => {
  const M = await mig(true);
  await rollback.handleRollback({ tenantId: T, requestId: "r-trf19", migrationId: M }).catch(() => {});
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [M])).rows[0].status, "rolling_back");
  assert.match(await lastError(M), /db phase unknown after cutover/);
  // 던지는 곳이 트래픽 되돌리기(restoreSource) 앞이라 LB 는 안 건드린다 (rollback.ts 순서)
});

test("PF TRF-19 정상: 컷오버 전이면 DB 방향을 못 읽어도 예전 순서(트래픽 먼저)로 간다", { skip }, async () => {
  const M = await mig(false);
  await rollback.handleRollback({ tenantId: T, requestId: "r-trf19b", migrationId: M }).catch(() => {});
  const e = await lastError(M);
  assert.ok(e.length > 0, "다른 이유(연결 실패 등)로는 실패가 남는다");
  assert.doesNotMatch(e, /db phase unknown after cutover/);
});
