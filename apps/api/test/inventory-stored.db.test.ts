// #242 DB 시험: 환경 실자원 GET 은 저장된 결과만 읽고, 없거나 오래됐을 때 inventory-refresh 작업을 하나만 넣는다. api 는 CLI 를 안 부른다. DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER || process.env.TEST_DB_ISOLATE !== "1" ? "DATABASE_URL / OWNER_DATABASE_URL / TEST_DB_ISOLATE 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();
const bin = mkdtempSync(join(tmpdir(), "inv-api-bin-"));
const cliCalled = join(bin, "called");
const savedPath = process.env.PATH;

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

const STORED = { provider: "aws", status: "ok", reason: null, source: "aws-cli", scope: "계정 ****3333", region: "ap-northeast-2",
  checkedAt: "2026-11-05T00:00:00.000Z", elapsedMs: 12,
  groups: [{ category: "cluster", service: "EKS", items: [{ name: "customer-eks", status: null, detail: null }], error: null }] };

before(async () => {
  if (skip) return;
  // 부르면 흔적이 남는 가짜 CLI: api 가 부르면 시험이 잡는다
  for (const c of ["aws", "gcloud", "kubectl"]) {
    writeFileSync(join(bin, c), `#!/bin/sh\ntouch ${cliCalled}\nexit 1\n`);
    chmodSync(join(bin, c), 0o755);
  }
  process.env.PATH = `${bin}:${savedPath}`;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { envInventoryRoutes } = await import("../src/routes/env-inventory.js");
  const { environmentRoutes } = await import("../src/routes/environments.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-inv-api'), ($2,'test-inv-api-other')", [T, OTHER]);
  await core.startBoss();
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(envInventoryRoutes, { prefix: P });
  await app.register(environmentRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  process.env.PATH = savedPath;
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed(provider = "aws") {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$2,$3,'e','connected')`, [id, T, provider]);
  return id;
}
const get = (envId: string, h = T, tail = "inventory") => app.inject({ method: "GET", url: `${P}/environments/${envId}/${tail}`, headers: { "x-dev-tenant": h } });
const jobs = async (envId: string) => Number((await owner.query(
  "SELECT count(*) FROM pgboss.job WHERE name='inventory-refresh' AND data->>'envId'=$1", [envId])).rows[0].count);
const line = async (envId: string) => (await owner.query("SELECT requested_at, checked_at FROM environment_inventory WHERE environment_id=$1", [envId])).rows[0];
const saveResult = (envId: string, ago: string, result: object = STORED) => owner.query(
  `INSERT INTO environment_inventory (environment_id, tenant_id, result, requested_at, checked_at) VALUES ($1,$2,$3, now() - $4::interval - interval '1 second', now() - $4::interval)`,
  [envId, T, JSON.stringify(result), ago]);

test("워커가 같은 줄에 둔 AWS 도착 사실(targetFacts)은 실자원으로 읽히고 화면 응답에는 안 나간다", { skip }, async () => {
  const id = await seed();
  await saveResult(id, "10 seconds", { ...STORED, targetFacts: { ok: true, cluster: "customer-eks", region: "ap-northeast-2", facts: { vpcId: "vpc-0aaa1111bbbb2222c" } } });
  const r = await get(id);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().cloud.groups[0].items[0].name, "customer-eks");
  assert.ok(!r.body.includes("targetFacts") && !r.body.includes("vpc-0aaa1111bbbb2222c"));
});

test("결과 없음: 첫 GET 은 바로 unavailable + refreshing, 작업 1개. 같은 화면을 또 불러도 작업은 그대로 1개", { skip }, async () => {
  const id = await seed();
  const r = await get(id);
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.cloud.status, "unavailable");
  assert.match(b.cloud.reason, /첫 조회가 진행 중/);
  assert.deepEqual(b.cloud.groups, []);
  assert.deepEqual(b.cloudRefresh, { refreshing: true, checkedAt: null });
  assert.equal(await jobs(id), 1);
  await Promise.all([get(id), get(id), get(id)]);
  assert.equal(await jobs(id), 1);
});

test("동시 첫 요청: 여러 개가 같이 와도 작업은 1개", { skip }, async () => {
  const id = await seed();
  const rs = await Promise.all(Array.from({ length: 5 }, () => get(id)));
  assert.ok(rs.every((r) => r.statusCode === 200));
  assert.equal(await jobs(id), 1);
});

test("신선한 결과: 저장된 값과 조회 시각을 돌려주고 작업 안 넣음", { skip }, async () => {
  const id = await seed();
  await saveResult(id, "10 seconds");
  const b = (await get(id)).json();
  assert.equal(b.cloud.groups[0].items[0].name, "customer-eks");
  assert.equal(b.cloudRefresh.refreshing, false);
  assert.ok(b.cloudRefresh.checkedAt);
  assert.equal(await jobs(id), 0);
});

test("60초 지난 결과: 있는 값을 돌려주면서 다시 조회 요청", { skip }, async () => {
  const id = await seed();
  await saveResult(id, "2 minutes");
  const before = await line(id);
  const b = (await get(id)).json();
  assert.equal(b.cloud.groups[0].items[0].name, "customer-eks");
  assert.equal(b.cloudRefresh.refreshing, true);
  assert.ok((await line(id)).requested_at > before.requested_at);
  assert.equal(await jobs(id), 1);
});

test("워커가 죽어 결과가 안 오면(요청 2분 넘음) 다시 요청한다", { skip }, async () => {
  const id = await seed();
  await owner.query(`INSERT INTO environment_inventory (environment_id, tenant_id, requested_at) VALUES ($1,$2, now() - interval '5 minutes')`, [id, T]);
  assert.equal((await get(id)).json().cloudRefresh.refreshing, true);
  const l = await line(id);
  assert.ok(Date.now() - new Date(l.requested_at).getTime() < 60_000);
  assert.equal(await jobs(id), 1);
});

test("거부: 남의 회사 환경은 404, 줄도 작업도 안 생김", { skip }, async () => {
  const id = await seed();
  assert.equal((await get(id, OTHER)).statusCode, 404);
  assert.equal((await get(id, OTHER, "status")).statusCode, 404);
  assert.equal(await line(id), undefined);
  assert.equal(await jobs(id), 0);
});

test("다른 회사 줄은 RLS 로 안 보인다", { skip }, async () => {
  const id = await seed();
  await saveResult(id, "10 seconds");
  const n = await core.withTenant(OTHER, async (tx) => (await tx.query("SELECT 1 FROM environment_inventory WHERE environment_id=$1", [id])).rowCount);
  assert.equal(n, 0);
});

test("온프레 pull: Agent 보고를 바로 읽고 작업을 안 넣는다", { skip }, async () => {
  const id = await seed("onprem");
  const b = (await get(id)).json();
  assert.equal(b.cloud.source, "agent");
  assert.equal(b.cloudRefresh.refreshing, false);
  assert.equal(await jobs(id), 0);
});

test("/status: 결과가 없으면 unknown + 빈 목록(작업은 넣음), 있으면 저장된 값으로", { skip }, async () => {
  const none = await seed();
  const a = (await get(none, T, "status")).json();
  assert.equal(a.health, "unknown"); assert.deepEqual(a.resources, []);
  assert.equal(await jobs(none), 1);
  const id = await seed();
  await saveResult(id, "10 seconds");
  const b = (await get(id, T, "status")).json();
  assert.equal(b.health, "healthy");
  assert.equal(b.resources[0].name, "customer-eks");
});

test("api 는 클라우드 CLI 를 한 번도 안 불렀다", { skip }, () => {
  assert.equal(existsSync(cliCalled), false);
});
