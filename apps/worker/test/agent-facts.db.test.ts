// W5 DB 시험: 보안 판정이 쓰는 온프레 Agent facts 보고 고르기 (가장 최근 · 최대 나이 안 · 같은 회사 · 모양이 맞는 것). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let pre: typeof import("../src/jobs/precheck.js");
let owner: pg.Client;
const T = randomUUID(), T2 = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  pre = await import("../src/jobs/precheck.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'agent-facts'), ($2,'agent-facts-other')", [T, T2]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

async function env(tenant = T) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name) VALUES ($1,$2,'onprem',$3)`, [id, tenant, `o-${id.slice(0, 6)}`]);
  const k = `ak_${randomBytes(12).toString("hex")}`;
  await owner.query(`INSERT INTO agent_keys (id, tenant_id, env_id) VALUES ($1,$2,$3)`, [k, tenant, id]);
  return { id, k, tenant };
}
const body = (tls: boolean, extra: Record<string, unknown> = {}) => ({
  kind: "facts", agentVersion: "t", sentAt: "2026-11-04T00:00:00Z", grants: { level: "L0" },
  dbs: [{ namespace: "app-x", cluster: "x-db", majorVersion: 16, tlsEnforced: tls, authMethods: ["scram-sha-256"], exposed: false }], ...extra,
});
async function report(e: { id: string; k: string; tenant: string }, b: unknown, agoSec: number, kind = "facts") {
  await owner.query(`INSERT INTO agent_reports (tenant_id, env_id, key_id, kind, signature, sent_at, received_at, body)
    VALUES ($1,$2,$3,$4,$5, now() - make_interval(secs => $6), now() - make_interval(secs => $6), $7)`,
    [e.tenant, e.id, e.k, kind, randomBytes(16).toString("hex"), agoSec, JSON.stringify(b)]);
}
const latest = (tenant: string, envId: string, env: NodeJS.ProcessEnv = {}) =>
  core.withTenant(tenant, (tx) => pre.latestAgentFacts(tx, envId, env));

test("가장 최근 facts 를 고른다 (heartbeat 는 안 본다)", { skip }, async () => {
  const e = await env();
  await report(e, body(false), 300);
  await report(e, body(true), 60);
  await report(e, { kind: "heartbeat" }, 5, "heartbeat");
  const f = await latest(T, e.id);
  assert.equal(f?.dbs[0]?.tlsEnforced, true);
});

test("최대 나이(기본 900초)보다 오래된 보고는 안 쓴다 → undefined (모름 그대로)", { skip }, async () => {
  const e = await env();
  await report(e, body(true), 1000);
  assert.equal(await latest(T, e.id), undefined);
  assert.equal((await latest(T, e.id, { AGENT_FACTS_MAX_AGE_SEC: "2000" }))?.dbs[0]?.tlsEnforced, true);
});

test("모양이 틀린 본문·다른 회사 환경은 안 쓴다", { skip }, async () => {
  const e = await env();
  await report(e, body(true, { grants: { level: "L9" } }), 10);
  assert.equal(await latest(T, e.id), undefined);
  const other = await env(T2);
  await report(other, body(true), 10);
  // 다른 회사 이름으로는 RLS 가 줄을 숨긴다
  assert.equal(await latest(T, other.id), undefined);
  assert.equal((await latest(T2, other.id))?.dbs[0]?.tlsEnforced, true);
});

test("W4: dbAgentDeployLookup 는 같은 app + 커밋의 가장 최근 deploy 보고만 본다 (다른 커밋·다른 회사는 null)", { skip }, async () => {
  const { dbAgentDeployLookup } = await import("../src/gitops/agent-watch.js");
  const e = await env();
  const dep = (commit: string, status: string) => ({ kind: "deploy", agentVersion: "t", sentAt: "2026-11-04T00:00:00Z", app: "t-0a1b2c3d-shop-onprem-k3s", bundleHash: commit, status, resources: [] });
  await report(e, dep("a".repeat(40), "failed"), 120, "deploy");
  await report(e, dep("a".repeat(40), "applied"), 10, "deploy");
  await report(e, dep("b".repeat(40), "failed"), 5, "deploy");
  const look = dbAgentDeployLookup(T, e.id);
  assert.equal((await look("t-0a1b2c3d-shop-onprem-k3s", "a".repeat(40)))?.status, "applied");
  assert.equal(await look("t-0a1b2c3d-shop-onprem-k3s", "c".repeat(40)), null);
  assert.equal(await look("t-0a1b2c3d-blog-onprem-k3s", "a".repeat(40)), null);
  assert.equal(await dbAgentDeployLookup(T2, e.id)("t-0a1b2c3d-shop-onprem-k3s", "a".repeat(40)), null);
});

test("#373 D2: progressing 은 끝이 아니다 (짝짓기 lookup 은 null), 진행 보고·하트비트 나이는 따로 읽는다 (폐기 키·다른 회사 제외)", { skip }, async () => {
  const { dbAgentDeployLookup, dbAgentProgressLookup, dbAgentHeartbeatLookup } = await import("../src/gitops/agent-watch.js");
  const e = await env();
  const app = "t-0a1b2c3d-shop-onprem-k3s", rev = "d".repeat(40);
  const prog = (msg: string) => ({ kind: "deploy", agentVersion: "t", sentAt: "2026-11-07T03:00:00Z", app, bundleHash: rev, status: "progressing", resources: [],
    progress: { sync: "Synced", health: "Progressing", waitingOn: { resource: "Cluster/app-shop/shop-db", health: "Progressing", message: msg } } });
  await report(e, prog("Setting up primary"), 60, "deploy");
  await report(e, prog("Creating replica"), 20, "deploy");
  assert.equal(await dbAgentDeployLookup(T, e.id)(app, rev), null, "progressing 만 있으면 아직 안 끝남");
  const p = await dbAgentProgressLookup(T, e.id)(app, rev);
  assert.equal(p?.waitingOn?.message, "Creating replica");
  assert.equal(p?.health, "Progressing");
  assert.equal(await dbAgentProgressLookup(T, e.id)(app, "e".repeat(40)), null);
  assert.equal(await dbAgentProgressLookup(T2, e.id)(app, rev), null, "다른 회사");
  // 하트비트: 한 번도 없으면 null, 있으면 가장 최근 나이(초). 폐기된 키로 온 것은 세지 않는다
  assert.equal(await dbAgentHeartbeatLookup(T, e.id)(), null);
  await report(e, { kind: "heartbeat" }, 300, "heartbeat");
  const age = await dbAgentHeartbeatLookup(T, e.id)();
  assert.ok(age !== null && age >= 299 && age <= 302, `age=${age}`);
  const revoked = `ak_${randomBytes(12).toString("hex")}`;
  await owner.query(`INSERT INTO agent_keys (id, tenant_id, env_id, revoked_at) VALUES ($1,$2,$3, now())`, [revoked, T, e.id]);
  await report({ ...e, k: revoked }, { kind: "heartbeat" }, 1, "heartbeat");
  const age2 = await dbAgentHeartbeatLookup(T, e.id)();
  assert.ok(age2 !== null && age2 >= 299, `폐기 키 하트비트를 셌다: age=${age2}`);
  assert.equal(await dbAgentHeartbeatLookup(T2, e.id)(), null, "다른 회사");
});
