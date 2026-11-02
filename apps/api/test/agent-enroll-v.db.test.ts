// 검증 묶음 VL6: 온프레 등록 토큰 — 동시 소비, 회사 경계, 로그·감사에 토큰 없음, 본문 거부, 상태별 heartbeat, 재발급
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AgentReport } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();
const H = { "x-dev-tenant": T }, HO = { "x-dev-tenant": OTHER };
const MASTER = "vl6-db-test-master-not-a-real-secret-0000";
const logs: string[] = [];

let core: typeof import("@svc/core");
let agent: typeof import("@svc/agent");
let owner: pg.Client;
let app: FastifyInstance;
let base = "";

before(async () => {
  if (skip) return;
  process.env.AGENT_REPORT_MASTER_KEY = MASTER;
  core = await import("@svc/core"); agent = await import("@svc/agent");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { agentReportRoutes } = await import("../src/routes/agent-reports.js");
  const { agentEnrollRoutes } = await import("../src/routes/agent-enroll.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vl6'), ($2,'test-vl6-other')", [T, OTHER]);
  const sink = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
  app = Fastify({ logger: { level: "info", stream: sink } });
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

async function onprem(tenant = T, status = "draft") {
  const id = randomUUID();
  await owner.query("INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$2,'onprem',$3,$4)", [id, tenant, `o-${id.slice(0, 6)}`, status]);
  return id;
}
const issue = (env: string, headers: Record<string, string> = H) => app.inject({ method: "POST", url: `${P}/environments/${env}/agent-token`, headers, payload: {} });
const register = (body: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: `${P}/agent/register`, headers, payload: body as object });
const tokenOf = async (env: string, h = H) => (await issue(env, h)).json().token as string;
const st = async (id: string) => (await owner.query("SELECT connection_status FROM environments WHERE id=$1", [id])).rows[0].connection_status as string;
const hb = (): AgentReport => ({ kind: "heartbeat", agentVersion: "t", sentAt: new Date().toISOString(), k3sVersion: "v1.33.5+k3s1",
  cnpg: { cluster: "app-db", ready: true, replicationLagBytes: null } });

test("동시에 같은 토큰으로 등록 10번: 정확히 1번만 201, 나머지 401, Agent 키는 1개", { skip }, async () => {
  const env = await onprem(); const tok = await tokenOf(env);
  const res = await Promise.all(Array.from({ length: 10 }, () => register({ enrollToken: tok })));
  const codes = res.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [201, ...Array(9).fill(401)]);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM agent_keys WHERE env_id=$1", [env])).rows[0].n, 1);
});

test("회사 경계: 요청 헤더로 다른 회사를 우긴 등록도 키는 토큰이 정한 회사·환경 것이다", { skip }, async () => {
  const env = await onprem(T); const tok = await tokenOf(env);
  const r = await register({ enrollToken: tok }, HO);          // 다른 회사 헤더를 붙여도
  assert.equal(r.statusCode, 201, r.body);
  const k = (await owner.query("SELECT tenant_id, env_id FROM agent_keys WHERE id=$1", [r.json().keyId])).rows[0];
  assert.deepEqual([k.tenant_id, k.env_id], [T, env]);
  assert.equal(r.json().envId, env);
});

test("회사 벽: 다른 회사 사람은 이 회사 환경에 토큰 발급 404(토큰 행 0), 다른 회사 앱 연결로는 토큰 표가 안 보인다", { skip }, async () => {
  const env = await onprem(T);
  assert.equal((await issue(env, HO)).statusCode, 404);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM agent_enroll_tokens WHERE env_id=$1", [env])).rows[0].n, 0);
  await tokenOf(env);
  const seen = await core.withTenant(OTHER, async (tx) => (await tx.query("SELECT count(*)::int AS n FROM agent_enroll_tokens")).rows[0].n);
  assert.equal(seen, 0);
});

test("본문 거부: 없음·숫자·배열·모르는 칸·공백/대문자 섞인 토큰 → 400/401, 토큰은 소비되지 않는다", { skip }, async () => {
  const env = await onprem(); const tok = await tokenOf(env);
  for (const body of [{}, { enrollToken: 123 }, { enrollToken: [tok] }, { enrollToken: tok, extra: 1 }]) {
    const r = await register(body);
    assert.ok([400, 401].includes(r.statusCode), JSON.stringify(body) + r.statusCode);
  }
  for (const bad of [` ${tok}`, `${tok} `, tok.toUpperCase(), tok.slice(0, -1), `${tok}x`]) assert.equal((await register({ enrollToken: bad })).statusCode, 401, bad);
  assert.equal((await register({ enrollToken: tok })).statusCode, 201, "진짜 토큰은 아직 살아 있다");
});

test("토큰 원문은 로그·감사·DB(해시 외)·오류 응답 어디에도 남지 않는다", { skip }, async () => {
  logs.length = 0;
  const env = await onprem(); const tok = await tokenOf(env);
  const reg = await register({ enrollToken: tok });
  const bad = await register({ enrollToken: tok });             // 두 번째(401) 응답·로그
  assert.equal(bad.statusCode, 401);
  assert.ok(!bad.body.includes(tok));
  const secret = reg.json().secret as string;
  const dump = JSON.stringify([
    (await owner.query("SELECT detail FROM audit_events WHERE target=$1", [env])).rows,
    (await owner.query("SELECT * FROM agent_enroll_tokens WHERE env_id=$1", [env])).rows,
  ]);
  assert.ok(!dump.includes(tok), "DB 에 토큰 원문");
  assert.ok(!dump.includes(secret), "DB 에 Agent 비밀");
  const text = logs.join("");
  assert.ok(text.includes("agent registered"), "로그 가로채기가 안 먹으면 이 시험은 아무것도 못 본다");
  assert.ok(!text.includes(tok), "로그에 토큰");
  assert.ok(!text.includes(secret), "로그에 Agent 비밀");
});

// L6fix 로 바뀐 동작: 새 토큰을 받으면 옛 쓰지 않은 토큰은 바로 끝난다 (예전엔 10분간 살아 있었음)
test("재발급: 새 토큰을 받으면 옛 토큰은 401, 새 토큰은 성공, 키는 1개", { skip }, async () => {
  const env = await onprem(); const a = await tokenOf(env); const b = await tokenOf(env);
  assert.notEqual(a, b);
  assert.equal((await register({ enrollToken: a })).statusCode, 401);
  assert.equal((await register({ enrollToken: b })).statusCode, 201);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM agent_keys WHERE env_id=$1", [env])).rows[0].n, 1);
});

test("토큰은 쓰였는데 환경이 그 사이 해제되면 409, 키는 안 생기고 그 토큰은 이미 소비됨", { skip }, async () => {
  const env = await onprem(); const tok = await tokenOf(env);
  await owner.query("UPDATE environments SET connection_status='disconnected' WHERE id=$1", [env]);
  const r = await register({ enrollToken: tok });
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, "ENV_DISCONNECTED");
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM agent_keys WHERE env_id=$1", [env])).rows[0].n, 0);
  assert.equal((await register({ enrollToken: tok })).statusCode, 401);
});

test("이미 connected 인 환경에 토큰 발급: 상태 그대로 + 감사 1줄 / 해제 환경은 409", { skip }, async () => {
  const env = await onprem(T, "connected");
  assert.equal((await issue(env)).statusCode, 201);
  assert.equal(await st(env), "connected");
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE target=$1 AND action='env.agent_token_issued'", [env])).rows[0].n, 1);
  const gone = await onprem(T, "disconnected");
  const r = await issue(gone); assert.equal(r.statusCode, 409); assert.equal(r.json().code, "ENV_DISCONNECTED");
});

test("heartbeat 상태 표: 시작 상태별로 connected 가 되는지/그대로인지", { skip }, async () => {
  const want: Record<string, string> = { draft: "connected", awaiting_customer: "connected", unstable: "connected", connected: "connected",
    disconnected: "disconnected", expired: "expired", failed: "failed" };
  for (const [from, to] of Object.entries(want)) {
    const env = await onprem(T, from === "draft" ? "awaiting_customer" : from);
    await owner.query("UPDATE environments SET connection_status=$2 WHERE id=$1", [env, from]);
    const tok = await tokenOf(env).catch(() => null);
    // 해제 환경은 토큰을 못 받으므로 만료 환경 등은 직접 키를 만든다
    let keyId: string, secret: string;
    if (tok) { const k = (await register({ enrollToken: tok })).json(); keyId = k.keyId; secret = k.secret; }
    else { keyId = "ak_" + randomUUID().replace(/-/g, "").slice(0, 24); await owner.query("INSERT INTO agent_keys (id, tenant_id, env_id) VALUES ($1,$2,$3)", [keyId, T, env]); secret = agent.deriveAgentSecret(MASTER, keyId); }
    await owner.query("UPDATE environments SET connection_status=$2 WHERE id=$1", [env, from]);
    const s = await agent.sendAgentReport(hb(), { baseUrl: base, keyId, secret });
    assert.equal(s.status, 201, `${from}: ${JSON.stringify(s.body)}`);
    assert.equal(await st(env), to, `heartbeat 전 ${from}`);
  }
});

test("tools/onprem-agent.ts --enroll: 이미 있던 느슨한 권한(644) 파일도 600 으로, 화면(stdout/stderr)에 토큰·비밀이 안 나온다", { skip, timeout: 60_000 }, async () => {
  const { execFile } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, statSync, readFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const env = await onprem(); const tok = await tokenOf(env);
  const out = join(mkdtempSync(join(tmpdir(), "vl6-")), "key.env");
  writeFileSync(out, "old\n"); chmodSync(out, 0o644);
  const res = await new Promise<{ stdout: string; stderr: string }>((resolve) => execFile(process.execPath,
    ["--import", "tsx", "tools/onprem-agent.ts", "--enroll", "--out", out],
    { cwd: process.cwd(), timeout: 45_000, env: { ...process.env, SVC_ENROLL_TOKEN: tok, AGENT_REPORT_URL: base, PATH: process.env.PATH } },
    (_e, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr) })));
  const file = readFileSync(out, "utf8");
  assert.match(file, /^AGENT_KEY_ID=ak_[0-9a-f]+\nAGENT_KEY_SECRET=\S+\n$/);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const secret = /AGENT_KEY_SECRET=(\S+)/.exec(file)![1]!;
  assert.ok(!(res.stdout + res.stderr).includes(secret), "화면에 비밀");
  assert.ok(!(res.stdout + res.stderr).includes(tok), "화면에 토큰");
  assert.match(res.stdout, /"kind":"enroll".*"ok":true/);
});
