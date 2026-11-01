// Z92: 온프레 Agent 보고 — 진짜 DB 왕복. 키(agent_keys) → 서명 POST → agent_reports 줄 + heartbeat 로 연결 상태 갱신
// 회사 벽(RLS), 재전송 색인, 폐기 키, 남의 회사 이전 번호(23503→404)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AgentReport } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID(), E = randomUUID(), S = randomUUID(), M = randomUUID(), OM = randomUUID(), OE = randomUUID(), OS = randomUUID();
const KEY = "ak_" + randomUUID().replaceAll("-", "").slice(0, 24), REVOKED = "ak_" + randomUUID().replaceAll("-", "").slice(0, 24);
const MASTER = "z92-db-test-master-not-a-real-secret-0000";

let core: typeof import("@svc/core");
let agent: typeof import("@svc/agent");
let owner: pg.Client;
let app: FastifyInstance;
let base = "";

before(async () => {
  if (skip) return;
  process.env.AGENT_REPORT_MASTER_KEY = MASTER;
  core = await import("@svc/core");
  agent = await import("@svc/agent");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { agentReportRoutes } = await import("../src/routes/agent-reports.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z92'), ($2,'test-z92-other')", [T, OTHER]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','z92-onprem','draft'), ($2,$3,'aws','z92-aws','connected'),
    ($4,$6,'onprem','z92-o-onprem','draft'), ($5,$6,'aws','z92-o-aws','connected')`, [E, S, T, OE, OS, OTHER]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES
    ($1,$2,$3,$4,'deploying'), ($5,$6,$7,$8,'deploying')`, [M, T, S, E, OM, OTHER, OS, OE]);
  await owner.query(`INSERT INTO agent_keys (id, tenant_id, env_id) VALUES ($1,$3,$4), ($2,$3,$4)`, [KEY, REVOKED, T, E]);
  await owner.query(`UPDATE agent_keys SET revoked_at = now() WHERE id = $1`, [REVOKED]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin); await app.register(authPlugin);
  await app.register(agentReportRoutes, { prefix: P });
  base = await app.listen({ port: 0, host: "127.0.0.1" });
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
  delete process.env.AGENT_REPORT_MASTER_KEY;
});

const send = (r: AgentReport, o: { key?: string; now?: Date } = {}) => {
  const keyId = o.key ?? KEY;
  return agent.sendAgentReport(r, { baseUrl: base, keyId, secret: agent.deriveAgentSecret(MASTER, keyId), ...(o.now ? { now: () => o.now! } : {}) });
};
const hb = (): AgentReport => ({ kind: "heartbeat", agentVersion: "t", sentAt: new Date().toISOString(), k3sVersion: "v1.33.5+k3s1",
  cnpg: { cluster: "app-db", ready: true, replicationLagBytes: null } });

test("heartbeat 왕복: 201 → agent_reports 한 줄 + 환경 connected·last_verified_at", { skip }, async () => {
  const r = await send(hb());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = (await owner.query(`SELECT tenant_id, env_id, kind FROM agent_reports WHERE key_id = $1`, [KEY])).rows;
  assert.equal(row.length, 1);
  assert.equal(row[0].tenant_id, T); assert.equal(row[0].env_id, E);
  const env = (await owner.query(`SELECT connection_status, last_verified_at FROM environments WHERE id = $1`, [E])).rows[0];
  assert.equal(env.connection_status, "connected");
  assert.ok(env.last_verified_at);
});

test("재전송: 같은 서명 두 번 → 409, 줄은 하나", { skip }, async () => {
  const now = new Date(); const rep = hb();
  assert.equal((await send(rep, { now })).status, 201);
  const b = await send(rep, { now });
  assert.equal(b.status, 409);
  assert.equal((b.body as { code: string }).code, "AGENT_REPLAY");
});

test("deploy: 제 회사 이전 번호는 들어가고, 남의 회사 이전 번호는 404", { skip }, async () => {
  const d = (mid: string): AgentReport => ({ kind: "deploy", agentVersion: "t", sentAt: new Date().toISOString(), migrationId: mid,
    bundleHash: "h1", status: "applied", resources: ["Deployment/app/web"] });
  assert.equal((await send(d(M))).status, 201);
  const x = await send(d(OM));
  assert.equal(x.status, 404);
});

test("폐기된 키 → 401, 모르는 키 → 401", { skip }, async () => {
  assert.equal((await send(hb(), { key: REVOKED })).status, 401);
  assert.equal((await send(hb(), { key: "ak_unknown0000000000000000" })).status, 401);
});

test("보기: 제 회사는 목록·lastHeartbeatAt, 남의 회사 헤더는 404", { skip }, async () => {
  const r = await fetch(`${base}${P}/environments/${E}/agent-reports`, { headers: { "x-dev-tenant": T } });
  assert.equal(r.status, 200);
  const j = await r.json() as { items: Array<{ kind: string }>; lastHeartbeatAt: string | null; stale: boolean };
  assert.ok(j.items.length >= 3);
  assert.ok(j.lastHeartbeatAt);
  assert.equal(j.stale, false);
  const o = await fetch(`${base}${P}/environments/${E}/agent-reports`, { headers: { "x-dev-tenant": OTHER } });
  assert.equal(o.status, 404);
});

test("회사 벽: app_user 로 회사 표시 없이 agent_keys·agent_reports 직접 읽기 = 0줄, 키 찾기 함수는 됨", { skip }, async () => {
  const c = await core.pool.connect();
  try {
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM agent_reports`)).rows[0].n, 0);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM agent_keys`)).rows[0].n, 0);
    assert.equal((await c.query(`SELECT * FROM agent_key_lookup($1)`, [KEY])).rows[0].tenant_id, T);
  } finally { c.release(); }
});
