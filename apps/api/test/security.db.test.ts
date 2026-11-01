// DB 시험: 보안 표를 진짜 DB(app_user, RLS)에서 읽는다. app.inject() 로 부른다 (포트 안 엶, 큐 안 씀)
//  - 장부(temp_credentials)·감사 체인·T27 증거가 표에 그대로 나오는가
//  - 앱 계정 권한(감사 UPDATE·DELETE 불가)을 실제로 묻는가
//  - 남의 회사 이전은 404
//  - 감사 한 줄을 표 주인이 몰래 고치면 체인 칸이 fail
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID(), TAMPER = randomUUID();

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;
type Row = { id: string; state: string; value: string };
const get = async (tenant: string, id: string) =>
  app.inject({ url: `${P}/migrations/${id}/security`, headers: { "x-dev-tenant": tenant } });
const row = (body: { rows: Row[] }, id: string) => { const r = body.rows.find((x) => x.id === id); assert.ok(r, id); return r; };

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { securityRoutes } = await import("../src/routes/security.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z18'), ($2,'test-z18-other'), ($3,'test-z18-tamper')", [T, OTHER, TAMPER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(securityRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
});

// 이전 하나 (출발 onprem, 도착 aws) + 감사 줄 (writeAudit 그대로, 앱 계정·회사 벽 안에서)
async function seed(tenant: string, status: string, audits: { action: string; detail?: Record<string, unknown> }[]) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','k3s','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, tenant]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, tenant, src, dst, status]);
  await core.withTenant(tenant, async (tx) => {
    for (const a of audits) await core.writeAudit(tx, tenant, { actor: "worker", target: id, result: "ok", ...a });
  });
  return { id, dst };
}

test("정상 끝난 이전: 장부·T27·체인·권한이 진짜 값으로 나온다", { skip }, async () => {
  const { id, dst } = await seed(T, "completed", [
    { action: "migration.importing", detail: { from: "draft", to: "importing" } },
    { action: "temp_role.issued", detail: { credentialRef: "cred/aws/svc-operate-z18-1", provider: "aws", purpose: "operate" } },
    { action: "temp_role.revoked", detail: { credentialRef: "cred/aws/svc-operate-z18-1", reason: "cleanup" } },
    { action: "cleanup.completed", detail: { from: "cleanup", to: "completed", evidence: { tempResources: 0, operateRoleRevoked: true } } },
  ]);
  await owner.query(`INSERT INTO temp_credentials (credential_ref, tenant_id, migration_id, env_id, provider, purpose, stage,
      role_ref, owner, issued_at, expires_at, status, revoke_reason, revoked_at)
    VALUES ($1,$2,$3,$4,'aws','operate','apply','arn:aws:iam::000000000000:role/svc-operate','test:1:z18',
      now() - interval '10 min', now() + interval '5 min', 'revoked', 'cleanup', now())`,
    [`cred/aws/svc-operate-${id.slice(0, 8)}`, T, id, dst]);

  const res = await get(T, id);
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(row(b, "TC-LEDGER").state, "ok");
  assert.match(row(b, "TC-LEDGER").value, /^1건 · 활성 0 · 회수 요청 0 · 회수 1/);
  assert.equal(row(b, "TC-TTL").value, "최대 900초 (기준 900초)");
  assert.equal(row(b, "TC-REVOKED").state, "ok");
  assert.equal(row(b, "TC-AUDIT").state, "ok");
  assert.equal(row(b, "AU-CHAIN").state, "ok");
  assert.equal(b.auditChain.checked, 4);
  assert.equal(row(b, "AU-APPEND").value, "UPDATE 불가 · DELETE 불가");
  assert.equal(row(b, "SE-LEDGER").state, "ok");
  assert.equal(row(b, "SE-LEDGER-DEL").state, "ok");
  assert.equal(row(b, "SE-PLAINTEXT").state, "ok");
  assert.equal(row(b, "LP-EXTID-target").state, "warn");      // 시드에 external_id 없음
  assert.equal(row(b, "RT-K3D").state, "warn");               // 출발이 onprem
  assert.ok(!JSON.stringify(b).includes("000000000000"), "역할 ARN(계정 번호)은 응답에 없다");
});

test("남의 회사 이전은 404 (RLS)", { skip }, async () => {
  const { id } = await seed(T, "awaiting_approval", []);
  const res = await get(OTHER, id);
  assert.equal(res.statusCode, 404);
});

test("평문 비밀값이 감사 detail 에 들어가면 SE-PLAINTEXT fail, 값은 응답에 없다", { skip }, async () => {
  const { id } = await seed(T, "syncing", [{ action: "sync.debug", detail: { peer: "postgres://repl:Z18leak@src:5432/shop" } }]);
  const b = (await get(T, id)).json();
  assert.equal(row(b, "SE-PLAINTEXT").state, "fail");
  assert.ok(!JSON.stringify(b).includes("Z18leak"));
});

test("표 주인이 감사 줄을 몰래 고치면 체인 fail (seq 표시)", { skip }, async () => {
  const { id } = await seed(TAMPER, "completed", [
    { action: "migration.importing", detail: { from: "draft", to: "importing" } },
    { action: "plan.awaiting_approval", detail: { from: "planning", to: "awaiting_approval" } },
  ]);
  const before = (await get(TAMPER, id)).json();
  assert.equal(row(before, "AU-CHAIN").state, "ok");
  const q = await owner.query(`UPDATE audit_events SET detail = '{"from":"planning","to":"completed"}'
    WHERE tenant_id = $1 AND action = 'plan.awaiting_approval' RETURNING seq`, [TAMPER]);
  const after = (await get(TAMPER, id)).json();
  assert.equal(row(after, "AU-CHAIN").state, "fail");
  assert.equal(after.auditChain.brokenAtSeq, Number(q.rows[0].seq));
});
