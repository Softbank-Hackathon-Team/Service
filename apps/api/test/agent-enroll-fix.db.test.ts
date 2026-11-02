// L6fix: 같은 환경에 새 등록 토큰을 발급하면 쓰지 않은 옛 토큰은 같은 트랜잭션에서 끝난다
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-l6fix'), ($2,'test-l6fix-other')", [T, OTHER]);
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

test("재발급 3번: 살아 있는 토큰은 늘 1개, 앞 둘은 401, 마지막만 성공", { skip }, async () => {
  const env = await onprem();
  const [a, b, c] = [await tokenOf(env), await tokenOf(env), await tokenOf(env)];
  assert.equal(await live(env), 1);
  assert.equal((await register(a)).statusCode, 401);
  assert.equal((await register(b)).statusCode, 401);
  assert.equal((await register(c)).statusCode, 201);
});

test("이미 쓴 토큰의 기록(key_id)은 재발급이 건드리지 않는다, 다른 환경·다른 회사 토큰도 그대로", { skip }, async () => {
  const env = await onprem(); const other = await onprem(); const foreign = await onprem(OTHER);
  const used = await tokenOf(env); const keyId = (await register(used)).json().keyId as string;
  const otherTok = await tokenOf(other); const foreignTok = await tokenOf(foreign, HO);
  await tokenOf(env);                                              // env 재발급
  const r = (await owner.query("SELECT key_id, used_at IS NOT NULL AS used FROM agent_enroll_tokens WHERE env_id=$1 AND key_id IS NOT NULL", [env])).rows;
  assert.deepEqual(r, [{ key_id: keyId, used: true }]);
  assert.equal(await live(other), 1); assert.equal(await live(foreign), 1);
  assert.equal((await register(otherTok)).statusCode, 201); assert.equal((await register(foreignTok)).statusCode, 201);
});

test("동시에 5번 재발급: 끝나면 살아 있는 토큰은 정확히 1개", { skip }, async () => {
  const env = await onprem();
  const res = await Promise.all(Array.from({ length: 5 }, () => issue(env)));
  assert.ok(res.every((r) => r.statusCode === 201));
  assert.equal(await live(env), 1);
});

test("거부: 남의 회사 환경 재발급 요청은 404이고 그 환경의 살아 있는 토큰을 끝내지 못한다", { skip }, async () => {
  const env = await onprem(); const tok = await tokenOf(env);
  assert.equal((await issue(env, HO)).statusCode, 404);
  assert.equal(await live(env), 1);
  assert.equal((await register(tok)).statusCode, 201);
});

test("거부: 해제된 환경 재발급은 409이고 살아 있던 토큰은 그대로 (롤백)", { skip }, async () => {
  const env = await onprem(); await tokenOf(env);
  await owner.query("UPDATE environments SET connection_status='disconnected' WHERE id=$1", [env]);
  assert.equal((await issue(env)).statusCode, 409);
  assert.equal(await live(env), 1);
});
