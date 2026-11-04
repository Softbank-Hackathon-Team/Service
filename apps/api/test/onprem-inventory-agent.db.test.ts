// 온프레 pull 모드 실자원 화면: api 가 Agent 마지막 보고(하트비트·facts)를 DB 에서 읽는다. 폐기된 키의 보고는 세지 않는다. DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let reports: typeof import("../src/routes/agent-reports.js");
let owner: pg.Client;
const T = randomUUID(), LIVE = randomUUID(), NONE = randomUUID();
const hex = () => randomUUID().replace(/-/g, "").slice(0, 20);
const K_LIVE = `ak_${hex()}`, K_OLD = `ak_${hex()}`;
const hb = (k3s: string, cluster: string) => JSON.stringify({ kind: "heartbeat", k3sVersion: k3s, cnpg: { cluster, ready: true, replicationLagBytes: null } });
const facts = (cluster: string) => JSON.stringify({ kind: "facts", grants: { level: "L0" }, dbs: [{ namespace: "app-shop", cluster, majorVersion: 16, tlsEnforced: true, authMethods: null, exposed: false }] });

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  reports = await import("../src/routes/agent-reports.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-onprem-inventory-agent')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','vm','connected'), ($2,$3,'onprem','no-agent','connected')`, [LIVE, NONE, T]);
  await owner.query(`INSERT INTO agent_keys (id, tenant_id, env_id, revoked_at) VALUES ($1,$3,$4,NULL), ($2,$3,$4,now())`, [K_LIVE, K_OLD, T, LIVE]);
  // 살아 있는 키: 40초 전 하트비트·facts. 폐기된 키: 1초 전 (세면 안 됨)
  await owner.query(`INSERT INTO agent_reports (tenant_id, env_id, key_id, kind, signature, sent_at, received_at, body) VALUES
    ($1,$2,$3,'heartbeat','s1', now(), now() - interval '40 seconds', $5),
    ($1,$2,$3,'facts','s2', now(), now() - interval '40 seconds', $6),
    ($1,$2,$4,'heartbeat','s3', now(), now() - interval '1 second', $7),
    ($1,$2,$4,'facts','s4', now(), now() - interval '1 second', $8)`,
    [T, LIVE, K_LIVE, K_OLD, hb("v1.36.5+k3s1", "shop-db"), facts("shop-db"), hb("v9.9.9-revoked", "x"), facts("revoked-db")]);
});
after(async () => {
  if (skip) return;
  await core.pool.end(); await owner.end();
});

test("정상: 살아 있는 키의 마지막 하트비트·facts (폐기된 키 보고는 무시)", { skip }, async () => {
  const a = await reports.agentInventoryFor(T, LIVE, { AGENT_STALE_SEC: "90" });
  assert.equal(a.keys, 1); assert.equal(a.staleSec, 90); assert.equal(a.k3sVersion, "v1.36.5+k3s1");
  assert.ok(a.heartbeatAgeSec !== null && a.heartbeatAgeSec >= 39 && a.heartbeatAgeSec <= 50, String(a.heartbeatAgeSec));
  assert.deepEqual(a.cnpg, { cluster: "shop-db", ready: true });
  assert.deepEqual(a.dbs?.map((d) => d.cluster), ["shop-db"]);
});

test("거부: 키·보고가 없는 환경은 keys 0, 나이·버전·DB null", { skip }, async () => {
  assert.deepEqual(await reports.agentInventoryFor(T, NONE, {}), { keys: 0, heartbeatAgeSec: null, staleSec: 120, k3sVersion: null, cnpg: null, dbs: null });
});

test("거부: 남의 회사 환경은 RLS 로 안 보인다", { skip }, async () => {
  const a = await reports.agentInventoryFor(randomUUID(), LIVE, {});
  assert.equal(a.keys, 0); assert.equal(a.heartbeatAgeSec, null);
});

test("onpremInventoryDeps: pull(기본)·온프레만 Agent 읽기, push 시연(ONPREM_FLOOR_VIA_GIT=0)·클라우드는 없음", { skip }, () => {
  assert.equal(typeof reports.onpremInventoryDeps(T, LIVE, "onprem", {}).agent, "function");
  assert.deepEqual(reports.onpremInventoryDeps(T, LIVE, "onprem", { ONPREM_FLOOR_VIA_GIT: "0" }), {});
  assert.deepEqual(reports.onpremInventoryDeps(T, LIVE, "aws", {}), {});
});
