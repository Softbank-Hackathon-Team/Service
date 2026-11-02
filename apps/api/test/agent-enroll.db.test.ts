// 입력층 L6 DB 시험: 사람이 등록 토큰 발급 → Agent 가 토큰으로 키 받기 → 그 키로 heartbeat → connected
// 거부: 토큰 두 번·10분 지남 401, 남의 회사 환경 404, aws 환경 400, 해제된 환경 heartbeat 는 상태 유지
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
const T = randomUUID(), OTHER = randomUUID(), E = randomUUID(), A = randomUUID(), D = randomUUID(), OE = randomUUID();
const H = { "x-dev-tenant": T }, HO = { "x-dev-tenant": OTHER };
const MASTER = "l6-db-test-master-not-a-real-secret-00000";

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
  const { agentEnrollRoutes } = await import("../src/routes/agent-enroll.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-l6'), ($2,'test-l6-other')", [T, OTHER]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$5,'onprem','l6-onprem','draft'), ($2,$5,'aws','l6-aws','draft'), ($3,$5,'onprem','l6-gone','draft'),
    ($4,$6,'onprem','l6-other','draft')`, [E, A, D, OE, T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin); await app.register(authPlugin);
  await app.register(agentReportRoutes, { prefix: P });
  await app.register(agentEnrollRoutes, { prefix: P });
  base = await app.listen({ port: 0, host: "127.0.0.1" });
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
  delete process.env.AGENT_REPORT_MASTER_KEY;
});

const issue = (env: string, headers: Record<string, string> = H) =>
  app.inject({ method: "POST", url: `${P}/environments/${env}/agent-token`, headers, payload: {} });
const register = (enrollToken: string) =>
  app.inject({ method: "POST", url: `${P}/agent/register`, payload: { enrollToken } });
const status = async (id: string) =>
  (await owner.query("SELECT connection_status, last_verified_at FROM environments WHERE id=$1", [id])).rows[0];
const hb = (): AgentReport => ({ kind: "heartbeat", agentVersion: "t", sentAt: new Date().toISOString(), k3sVersion: "v1.33.5+k3s1",
  cnpg: { cluster: "app-db", ready: true, replicationLagBytes: null } });
const send = (keyId: string, secret: string) => agent.sendAgentReport(hb(), { baseUrl: base, keyId, secret });

test("정상: 발급 → 등록 → heartbeat → connected, 토큰은 해시만 저장", { skip }, async () => {
  const t = await issue(E);
  assert.equal(t.statusCode, 201, t.body);
  const tok = t.json() as { token: string; expiresAt: string; command: string };
  assert.match(tok.token, /^et_[A-Za-z0-9_-]{43}$/);
  assert.ok(tok.command.startsWith(`SVC_ENROLL_TOKEN=${tok.token} `) && tok.command.includes("--enroll"));
  const left = Date.parse(tok.expiresAt) - Date.now();
  assert.ok(left > 9 * 60_000 && left <= 10 * 60_000 + 5_000, String(left));
  assert.equal((await status(E)).connection_status, "awaiting_customer");
  const stored = (await owner.query("SELECT token_hash FROM agent_enroll_tokens WHERE env_id=$1", [E])).rows;
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, tok.token);
  assert.match(stored[0].token_hash, /^[0-9a-f]{64}$/);

  const r = await register(tok.token);
  assert.equal(r.statusCode, 201, r.body);
  const k = r.json() as { envId: string; keyId: string; secret: string };
  assert.equal(k.envId, E);
  assert.equal(k.secret, agent.deriveAgentSecret(MASTER, k.keyId));
  const key = (await owner.query("SELECT tenant_id, env_id FROM agent_keys WHERE id=$1", [k.keyId])).rows[0];
  assert.deepEqual([key.tenant_id, key.env_id], [T, E]);

  const s = await send(k.keyId, k.secret);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const st = await status(E);
  assert.equal(st.connection_status, "connected");
  assert.ok(st.last_verified_at);
  const au = await owner.query("SELECT action FROM audit_events WHERE target=$1 ORDER BY seq", [E]);
  assert.deepEqual(au.rows.map((x) => x.action), ["env.agent_token_issued", "env.agent_registered", "env.agent_heartbeat"]);
  // 이미 connected 면 두 번째 heartbeat 는 감사 줄을 더 쌓지 않는다
  assert.equal((await send(k.keyId, k.secret)).status, 201);
  assert.equal((await owner.query("SELECT count(*) FROM audit_events WHERE target=$1", [E])).rows[0].count, "3");
});

test("거부: 같은 토큰 두 번 401, 10분 지난 토큰 401, 모양 틀린 토큰 401", { skip }, async () => {
  const tok = (await issue(E)).json().token as string;
  assert.equal((await register(tok)).statusCode, 201);
  const again = await register(tok);
  assert.equal(again.statusCode, 401); assert.equal(again.json().code, "ENROLL_TOKEN_INVALID");
  const old = (await issue(E)).json().token as string;
  await owner.query("UPDATE agent_enroll_tokens SET expires_at = now() - interval '1 second' WHERE used_at IS NULL AND env_id=$1", [E]);
  assert.equal((await register(old)).statusCode, 401);
  assert.equal((await register("et_short")).statusCode, 401);
});

test("거부: 남의 회사 환경 404, aws 환경 400, 마스터 키 없으면 503", { skip }, async () => {
  const o = await issue(OE);
  assert.equal(o.statusCode, 404);
  const mine = await issue(OE, HO);
  assert.equal(mine.statusCode, 201, "제 회사 사람은 받는다");
  const a = await issue(A);
  assert.equal(a.statusCode, 400); assert.equal(a.json().code, "NOT_ONPREM");
  delete process.env.AGENT_REPORT_MASTER_KEY;
  try { assert.equal((await issue(E)).statusCode, 503); }
  finally { process.env.AGENT_REPORT_MASTER_KEY = MASTER; }
});

test("거부: 해제된 환경은 heartbeat 가 와도 disconnected 그대로 (보고는 저장)", { skip }, async () => {
  const tok = (await issue(D)).json().token as string;
  const k = (await register(tok)).json() as { keyId: string; secret: string };
  await owner.query("UPDATE environments SET connection_status='disconnected' WHERE id=$1", [D]);
  const s = await send(k.keyId, k.secret);
  assert.equal(s.status, 201);
  assert.equal((await status(D)).connection_status, "disconnected");
  assert.equal((await issue(D)).statusCode, 409, "해제된 환경엔 토큰도 안 준다");
  const n = await owner.query("SELECT count(*) FROM agent_reports WHERE env_id=$1", [D]);
  assert.equal(Number(n.rows[0].count), 1);
});
