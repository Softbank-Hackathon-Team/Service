// 온프레 pull 도착 사전 점검의 Agent 정보: 살아 있는 키 수, 마지막 하트비트 나이, 그 하트비트의 k3s 버전.
// 폐기된 키로 온 하트비트는 세지 않는다 (연결 확인 verify-connection 과 같은 기준). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let precheck: typeof import("../src/jobs/precheck.js");
let owner: pg.Client;
const T = randomUUID(), LIVE = randomUUID(), NONE = randomUUID();
const hex = () => randomUUID().replace(/-/g, "").slice(0, 20);
const K_LIVE = `ak_${hex()}`, K_OLD = `ak_${hex()}`;
const hb = (k3s: string) => JSON.stringify({ kind: "heartbeat", k3sVersion: k3s, cnpg: null });

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  precheck = await import("../src/jobs/precheck.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-onprem-precheck-agent')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','vm','connected'), ($2,$3,'onprem','no-agent','connected')`, [LIVE, NONE, T]);
  await owner.query(`INSERT INTO agent_keys (id, tenant_id, env_id, revoked_at) VALUES ($1,$3,$4,NULL), ($2,$3,$4,now())`, [K_LIVE, K_OLD, T, LIVE]);
  // 살아 있는 키: 30초 전 하트비트. 폐기된 키: 1초 전 하트비트 (세면 안 됨)
  await owner.query(`INSERT INTO agent_reports (tenant_id, env_id, key_id, kind, signature, sent_at, received_at, body) VALUES
    ($1,$2,$3,'heartbeat','s1', now(), now() - interval '30 seconds', $5),
    ($1,$2,$4,'heartbeat','s2', now(), now() - interval '1 second', $6)`, [T, LIVE, K_LIVE, K_OLD, hb("v1.33.5+k3s1"), hb("v9.9.9-revoked")]);
});
after(async () => {
  if (skip) return;
  await core.pool.end(); await owner.end();
});

test("정상: 살아 있는 키의 마지막 하트비트 나이·k3s 버전 (폐기된 키 보고는 무시)", { skip }, async () => {
  const a = await core.withTenant(T, (tx) => precheck.onpremAgentInfo(tx, LIVE, { AGENT_STALE_SEC: "90" }));
  assert.equal(a.keys, 1);
  assert.equal(a.k3sVersion, "v1.33.5+k3s1");
  assert.ok(a.lastHeartbeatAgeSec !== null && a.lastHeartbeatAgeSec >= 29 && a.lastHeartbeatAgeSec <= 40, String(a.lastHeartbeatAgeSec));
  assert.equal(a.staleSec, 90);
});

test("거부: 키·하트비트가 없는 환경은 keys 0, 나이 null", { skip }, async () => {
  const a = await core.withTenant(T, (tx) => precheck.onpremAgentInfo(tx, NONE, {}));
  assert.deepEqual(a, { keys: 0, lastHeartbeatAgeSec: null, staleSec: 120, k3sVersion: null });
});

test("거부: 남의 회사 환경은 RLS 로 안 보인다 (keys 0)", { skip }, async () => {
  const a = await core.withTenant(randomUUID(), (tx) => precheck.onpremAgentInfo(tx, LIVE, {}));
  assert.equal(a.keys, 0); assert.equal(a.lastHeartbeatAgeSec, null);
});
