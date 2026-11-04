// L6 DB 시험: 온프레 연결 확인 = Agent 하트비트 (DB 만, 클러스터 호출 없음). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let job: typeof import("../src/jobs/verify-connection.js");
let owner: pg.Client;
const T = randomUUID(), T2 = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  job = await import("../src/jobs/verify-connection.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'onprem-verify'), ($2,'onprem-verify-other')", [T, T2]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

async function env(status: string, failures = 0) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, verify_failures) VALUES ($1,$2,'onprem',$3,$4,$5)`,
    [id, T, `o-${id.slice(0, 6)}`, status, failures]);
  return id;
}
async function key(envId: string, revoked = false) {
  const k = `ak_${randomBytes(12).toString("hex")}`;
  await owner.query(`INSERT INTO agent_keys (id, tenant_id, env_id, revoked_at) VALUES ($1,$2,$3,$4)`, [k, T, envId, revoked ? new Date() : null]);
  return k;
}
async function beat(envId: string, k: string, agoSec: number) {
  await owner.query(`INSERT INTO agent_reports (tenant_id, env_id, key_id, kind, signature, sent_at, received_at, body)
    VALUES ($1,$2,$3,'heartbeat',$4, now() - make_interval(secs => $5), now() - make_interval(secs => $5), '{}')`, [T, envId, k, randomBytes(16).toString("hex"), agoSec]);
}
const row = async (id: string) => (await owner.query("SELECT connection_status, failure_reason, verify_failures FROM environments WHERE id=$1", [id])).rows[0];
const periodic = (envId: string, tenantId = T) => job.handleVerifyConnection({ tenantId, envId, requestId: randomUUID(), reason: "periodic" });

test("정상: 살아 있는 키 + 120초 안 하트비트 → connected 유지, 실패 횟수 0 (unstable 이면 connected 로 돌아옴)", { skip }, async () => {
  const a = await env("connected", 2); await beat(a, await key(a), 10);
  assert.deepEqual(await periodic(a), { status: "connected" });
  assert.equal((await row(a)).verify_failures, 0);
  const b = await env("unstable", 3); await beat(b, await key(b), 5);
  assert.equal((await periodic(b)).status, "connected");
});

test("거부: 하트비트가 오래됨 → 실패 횟수를 세다 unstable, 사유 AGENT_HEARTBEAT_STALE", { skip }, async () => {
  const a = await env("connected", 2); await beat(a, await key(a), 600);
  const r = await periodic(a);
  assert.equal(r.reason, job.AGENT_HEARTBEAT_STALE);
  assert.equal((await row(a)).failure_reason, job.AGENT_HEARTBEAT_STALE);
  assert.equal((await row(a)).verify_failures, 3);
});

test("거부: 키가 다 폐기됨 → disconnected (폐기된 키의 새 하트비트는 안 셈), 사유 AGENT_KEY_MISSING", { skip }, async () => {
  const a = await env("connected"); await beat(a, await key(a, true), 1);
  const r = await periodic(a);
  assert.deepEqual(r, { status: "disconnected", reason: job.AGENT_KEY_MISSING });
  assert.equal((await row(a)).connection_status, "disconnected");
});

test("연결 전(draft)·남의 회사는 안 건드림", { skip }, async () => {
  const a = await env("draft");
  assert.equal((await periodic(a)).skipped, "not_connected");
  assert.equal((await row(a)).connection_status, "draft");
  const b = await env("connected"); await beat(b, await key(b), 1);
  assert.equal((await periodic(b, T2)).skipped, "env_not_found");
  assert.equal((await row(b)).connection_status, "connected");
});
