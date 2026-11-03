// VERIFYAPI DB 시험: 연결 확인이 남긴 "사람이 할 일"(verify_detail.missingPermissions·needsHuman, OBSROLE3)이 환경 목록 응답에 보인다.
//   정상(빠진 권한 있음) · 빈 목록/없음(칸 자체 없음) · 이상한 값(무시) · 남의 회사 안 보임(404·목록 밖) · 응답 스키마 통과
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
const MISSING = ["compute.forwardingRules.list", "redis.instances.list"];
const TODO = ["관찰 역할에 선택 권한 2개가 빠짐 — 연결 스크립트를 다시 실행"];

let core: typeof import("@svc/core");
let contracts: typeof import("@svc/contracts");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  contracts = await import("@svc/contracts");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { environmentRoutes } = await import("../src/routes/environments.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-verifyapi'), ($2,'test-verifyapi-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(environmentRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed(name: string, detail: unknown, tenant = T) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, verify_detail) VALUES ($1,$2,'gcp',$3,'connected',$4)`,
    [id, tenant, name, detail === undefined ? null : JSON.stringify(detail)]);
  return id;
}
const list = async (h = H) => {
  const r = await app.inject({ method: "GET", url: `${P}/environments`, headers: h });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json() as { items: Array<Record<string, unknown>> };
  for (const it of body.items) assert.equal(contracts.EnvironmentView.safeParse(it).success, true, JSON.stringify(it));
  return body.items;
};

test("정상: 빠진 선택 권한이 있으면 목록에 missingPermissions·needsHuman, clusters·checkedAt 은 안 나감", { skip }, async () => {
  const id = await seed("gcp-missing", { clusters: ["gke-1"], checkedAt: "2026-11-02T00:00:00.000Z", missingPermissions: MISSING, needsHuman: TODO });
  const e = (await list()).find((x) => x.id === id)!;
  assert.deepEqual(e.missingPermissions, MISSING);
  assert.deepEqual(e.needsHuman, TODO);
  assert.equal(e.connectionStatus, "connected");
  assert.equal("clusters" in e || "checkedAt" in e || "verifyDetail" in e, false);
});

test("빈 목록·없음: verify_detail 이 없거나 빠진 권한이 비면 칸 자체가 없다 (전 응답과 같은 키)", { skip }, async () => {
  const none = await seed("gcp-none", undefined);
  const empty = await seed("gcp-empty", { clusters: ["gke-1"], missingPermissions: [], needsHuman: [] });
  const ok = await seed("gcp-ok", { clusters: ["gke-1"], checkedAt: "2026-11-02T00:00:00.000Z" });
  const items = await list();
  for (const id of [none, empty, ok]) {
    const e = items.find((x) => x.id === id)!;
    assert.deepEqual(Object.keys(e).sort(), ["accountId", "connectionStatus", "failureReason", "id", "lastVerifiedAt", "name", "provider"], id);
  }
});

test("거부: 모양이 틀린 값(문자열 아닌 항목·목록 아님)은 내보내지 않는다 (응답 스키마 500 대신 칸 생략)", { skip }, async () => {
  const id = await seed("gcp-bad", { missingPermissions: [1, 2], needsHuman: "do it" });
  const e = (await list()).find((x) => x.id === id)!;
  assert.equal("missingPermissions" in e, false);
  assert.equal("needsHuman" in e, false);
});

test("남의 회사: 다른 회사 목록엔 안 보이고, 그 회사 환경 경로는 404 그대로", { skip }, async () => {
  const id = await seed("gcp-mine", { missingPermissions: MISSING, needsHuman: TODO });
  assert.equal((await list(HO)).some((x) => x.id === id), false);
  const r = await app.inject({ method: "GET", url: `${P}/environments/${id}/status`, headers: HO });
  assert.equal(r.statusCode, 404, r.body);
});

test("만들기(POST) 응답도 같은 모양: 새 환경엔 두 칸이 없다", { skip }, async () => {
  const r = await app.inject({ method: "POST", url: `${P}/environments`, headers: H, payload: { provider: "aws", name: "new-env", clusterName: "eks" } });
  assert.equal(r.statusCode, 201, r.body);
  const e = r.json();
  assert.equal("missingPermissions" in e || "needsHuman" in e || "verifyDetail" in e, false);
});
