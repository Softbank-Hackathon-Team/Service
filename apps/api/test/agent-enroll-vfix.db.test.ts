// VL6fix: L6fix 보강 — 같은 환경에 새 등록 토큰을 발급하면 쓰지 않은 옛 토큰은 같은 트랜잭션에서 끝난다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();
const H = { "x-dev-tenant": T }, HO = { "x-dev-tenant": OTHER };
let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  process.env.AGENT_REPORT_MASTER_KEY = "l6fix-db-test-master-not-a-real-secret-00";
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { agentEnrollRoutes } = await import("../src/routes/agent-enroll.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vl6fix'), ($2,'test-vl6fix-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin); await app.register(authPlugin);
  await app.register(agentEnrollRoutes, { prefix: P });
  await app.ready();
});
after(async () => { if (skip) return; await app.close(); await core.pool.end(); await owner.end(); delete process.env.AGENT_REPORT_MASTER_KEY; });

async function onprem(tenant = T, status = "draft") {
  const id = randomUUID();
  await owner.query("INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$2,'onprem',$3,$4)", [id, tenant, `o-${id.slice(0, 6)}`, status]);
  return id;
}
const issue = (env: string, h: Record<string, string> = H) => app.inject({ method: "POST", url: `${P}/environments/${env}/agent-token`, headers: h, payload: {} });
const tokenOf = async (env: string, h = H) => (await issue(env, h)).json().token as string;
const register = (t: string) => app.inject({ method: "POST", url: `${P}/agent/register`, payload: { enrollToken: t } });
const live = async (env: string) => (await owner.query("SELECT count(*)::int AS n FROM agent_enroll_tokens WHERE env_id=$1 AND used_at IS NULL AND expires_at > now()", [env])).rows[0].n as number;


const body = (r: { json(): any }) => r.json() as { status?: number; code?: string; message?: string; requestId?: string };

test("만료 토큰(시간이 지남)·재발급으로 끝난 토큰·모양 틀린 토큰 → 모두 같은 401 ApiError 모양(status·code·message·requestId)", { skip }, async () => {
  const env = await onprem();
  const old = await tokenOf(env);
  await tokenOf(env);                                                    // old 는 재발급으로 끝남
  const timed = await tokenOf(env);
  await owner.query("UPDATE agent_enroll_tokens SET expires_at = now() - interval '1 minute' WHERE env_id=$1 AND used_at IS NULL", [env]);
  for (const t of [old, timed, "et_" + "x".repeat(43), "garbage"]) {
    const r = await register(t);
    assert.equal(r.statusCode, 401, t.slice(0, 6));
    const j = body(r);
    assert.equal(j.code, "ENROLL_TOKEN_INVALID");
    assert.equal(j.status, 401);
    assert.equal(typeof j.message, "string"); assert.ok(j.requestId);
    assert.ok(!JSON.stringify(j).includes(t.slice(3, 20)) || t.length < 10, "응답에 토큰이 되돌아옴");
  }
  assert.equal(await live(env), 0);
  // 만료된 뒤에도 새로 받을 수 있고 그건 성공
  assert.equal((await register(await tokenOf(env))).statusCode, 201);
});

test("이미 쓴 토큰을 다시 쓰면 401 (재발급 여부와 무관), 재발급이 쓴 토큰을 되살리지 않는다", { skip }, async () => {
  const env = await onprem();
  const t = await tokenOf(env);
  assert.equal((await register(t)).statusCode, 201);
  assert.equal((await register(t)).statusCode, 401);
  await tokenOf(env);
  assert.equal((await register(t)).statusCode, 401);
  const used = (await owner.query("SELECT count(*)::int n FROM agent_enroll_tokens WHERE env_id=$1 AND used_at IS NOT NULL", [env])).rows[0].n;
  assert.equal(used, 1);
});

test("동시성: 재발급과 옛 토큰 등록이 겹쳐도 500 없음, 끝나면 살아 있는 토큰 ≤1, 키는 많아야 1개", { skip }, async () => {
  const env = await onprem();
  const old = await tokenOf(env);
  const [a, b] = await Promise.all([register(old), issue(env)]);
  assert.ok([201, 401].includes(a.statusCode), `register ${a.statusCode}`);
  assert.equal(b.statusCode, 201);
  assert.ok(await live(env) <= 1);
  const keys = (await owner.query("SELECT count(*)::int n FROM agent_keys WHERE env_id=$1", [env])).rows[0].n;
  assert.ok(keys <= 1);
});

test("권한 경계: 앱 계정은 expires_at 만 UPDATE 가능 — token_hash·used_at·key_id·tenant_id 고치기는 거부, 남의 회사 줄은 0줄", { skip }, async () => {
  const env = await onprem(); await tokenOf(env);
  const denied = async (sql: string) => core.withTenant(T, (tx) => tx.query(sql, [env])).then(() => "ok", (e: { code?: string }) => e.code);
  assert.equal(await denied("UPDATE agent_enroll_tokens SET used_at = NULL WHERE env_id = $1"), "42501");
  assert.equal(await denied("UPDATE agent_enroll_tokens SET token_hash = 'x' WHERE env_id = $1"), "42501");
  assert.equal(await denied("UPDATE agent_enroll_tokens SET tenant_id = tenant_id WHERE env_id = $1"), "42501");
  assert.equal(await denied("UPDATE agent_enroll_tokens SET expires_at = now() WHERE env_id = $1"), "ok");
  const other = await onprem(OTHER); await tokenOf(other, HO);
  const n = await core.withTenant(T, async (tx) => (await tx.query("UPDATE agent_enroll_tokens SET expires_at = now() WHERE env_id = $1", [other])).rowCount);
  assert.equal(n, 0);
  assert.equal(await live(other), 1);
});

test("재발급은 감사에 한 줄씩(env.agent_token_issued)이고 응답 expiresAt 은 약 10분 뒤", { skip }, async () => {
  const env = await onprem();
  const r = await issue(env);
  const mins = (Date.parse(r.json().expiresAt) - Date.now()) / 60000;
  assert.ok(mins > 9 && mins <= 10.1, `expiresAt ${mins}분 뒤`);
  await issue(env);
  const n = (await owner.query("SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='env.agent_token_issued'", [env])).rows[0].n;
  assert.equal(n, 2);
});
