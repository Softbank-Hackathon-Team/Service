// 검증 묶음 VL2: L2 추가 시험(멱등·동시성·남의 회사 404·비밀 노출·상태 순서). app.inject()로 부른다 (포트 안 엶).
// DATABASE_URL(app_user)·OWNER_DATABASE_URL(표 주인)이 없으면 건너뛴다
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
const TEMPLATE = "https://bucket.s3.ap-northeast-2.amazonaws.com/onboarding/aws-connect.json";
const ARN = "arn:aws:iam::111122223333:role/svc-worker";

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  process.env.CONNECT_TEMPLATE_URL = TEMPLATE;
  process.env.PLATFORM_PRINCIPAL_ARN = ARN;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { environmentRoutes } = await import("../src/routes/environments.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vl2'), ($2,'test-vl2-other')", [T, OTHER]);
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

const post = (url: string, payload?: unknown, headers: Record<string, string> = H) =>
  app.inject({ method: "POST", url: P + url, headers, payload: payload ?? {} });
const postK = (url: string, key: string, payload?: unknown, headers: Record<string, string> = H) =>
  app.inject({ method: "POST", url: P + url, headers: { ...headers, "idempotency-key": key }, payload: payload ?? {} });
async function create(name: string, extra: Record<string, unknown> = { clusterName: "shop-eks" }, provider = "aws") {
  const r = await post("/environments", { provider, name, ...extra });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { id: string; connectionStatus: string };
}
const dbRow = async (id: string) => (await owner.query(
  "SELECT connection_status, external_id, account_id, failure_reason FROM environments WHERE id=$1", [id])).rows[0];
const jobs = async (id: string) => Number((await owner.query(
  "SELECT count(*) FROM pgboss.job WHERE name='verify-connection' AND data->>'envId'=$1", [id])).rows[0].count);


test("남의 회사: verify·DELETE·status 모두 404 이고 상태·작업이 안 바뀐다", { skip }, async () => {
  const env = await create("v-other");
  await post(`/environments/${env.id}/connection-link`);
  const v = await post(`/environments/${env.id}/verify`, { accountId: "123456789012" }, HO);
  assert.equal(v.statusCode, 404);
  const d = await app.inject({ method: "DELETE", url: `${P}/environments/${env.id}`, headers: HO });
  assert.equal(d.statusCode, 404);
  assert.equal((await dbRow(env.id)).connection_status, "awaiting_customer");
  assert.equal(await jobs(env.id), 0);
  const list = await app.inject({ url: P + "/environments", headers: HO });
  assert.ok(!list.json().items.some((x: { id: string }) => x.id === env.id), "다른 회사 목록에 안 보임");
});

test("멱등: 같은 키로 환경 만들기 두 번 → 같은 응답, 환경 1개", { skip }, async () => {
  const key = randomUUID();
  const a = await postK("/environments", key, { provider: "aws", name: "idem-create", clusterName: "c" });
  const b = await postK("/environments", key, { provider: "aws", name: "idem-create", clusterName: "c" });
  assert.equal(a.statusCode, 201); assert.equal(b.statusCode, 201);
  assert.equal(a.json().id, b.json().id);
  const n = await owner.query("SELECT count(*) FROM environments WHERE tenant_id=$1 AND name='idem-create'", [T]);
  assert.equal(Number(n.rows[0].count), 1);
});

test("멱등: 같은 키로 verify 두 번 → 같은 응답, 작업 1개 / 다른 키 더블 클릭 → 작업 여전히 1개", { skip }, async () => {
  const env = await create("idem-verify");
  await post(`/environments/${env.id}/connection-link`);
  const key = randomUUID();
  const a = await postK(`/environments/${env.id}/verify`, key, { accountId: "123456789012" });
  const b = await postK(`/environments/${env.id}/verify`, key, { accountId: "123456789012" });
  assert.equal(a.statusCode, 202); assert.equal(b.statusCode, 202);
  assert.deepEqual(a.json(), b.json());
  assert.equal(await jobs(env.id), 1);
  const c = await postK(`/environments/${env.id}/verify`, randomUUID(), { accountId: "123456789012" });
  assert.ok(c.statusCode === 409 || c.statusCode === 202, `더블 클릭 ${c.statusCode} ${c.body}`);
  assert.equal(await jobs(env.id), 1, "다른 키로 눌러도 큐에 2개 안 쌓임");
});

test("멱등: 같은 키로 링크 두 번 → 같은 확인 문구", { skip }, async () => {
  const env = await create("idem-link");
  const key = randomUUID();
  const a = await postK(`/environments/${env.id}/connection-link`, key);
  const b = await postK(`/environments/${env.id}/connection-link`, key);
  assert.equal(a.json().externalId, b.json().externalId);
});

test("동시성: 같은 이름 동시 생성 → 201 한 번 409 한 번", { skip }, async () => {
  const body = { provider: "aws", name: "race-name", clusterName: "c" };
  const rs = await Promise.all([post("/environments", body), post("/environments", body), post("/environments", body)]);
  const codes = rs.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [201, 409, 409], JSON.stringify(rs.map((r) => r.body)));
});

test("순서: draft 에서 바로 verify → 409(링크 먼저), verifying 중 링크 다시 → 409, 상태 그대로", { skip }, async () => {
  const env = await create("order");
  const v0 = await post(`/environments/${env.id}/verify`, { accountId: "123456789012" });
  assert.equal(v0.statusCode, 409, v0.body);
  assert.equal((await dbRow(env.id)).connection_status, "draft");
  assert.equal((await dbRow(env.id)).account_id, null, "거절된 요청이 계정 번호를 남기면 안 됨");
  await post(`/environments/${env.id}/connection-link`);
  await post(`/environments/${env.id}/verify`, { accountId: "123456789012" });
  const l = await post(`/environments/${env.id}/connection-link`);
  assert.equal(l.statusCode, 409, l.body);
  assert.equal((await dbRow(env.id)).connection_status, "verifying");
});

test("실패 뒤 다시: failed → 링크 다시 받기는 failure_reason 을 지우고 같은 확인 문구 (PF01: 이미 만든 스택이 그대로 열리게)", { skip }, async () => {
  const env = await create("retry-failed");
  const first = (await post(`/environments/${env.id}/connection-link`)).json().externalId;
  await owner.query("UPDATE environments SET connection_status='failed', failure_reason='ROLE_ASSUME_DENIED' WHERE id=$1", [env.id]);
  const list = await app.inject({ url: P + "/environments", headers: H });
  assert.equal(list.json().items.find((x: { id: string }) => x.id === env.id).failureReason, "ROLE_ASSUME_DENIED");
  const again = await post(`/environments/${env.id}/connection-link`);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().externalId, first);
  const row = await dbRow(env.id);
  assert.equal(row.connection_status, "awaiting_customer");
  assert.equal(row.failure_reason, null);
});

test("비밀 노출: 목록 응답에 externalId 없음, 감사에는 앞 4자 힌트만(전체 문구 없음)", { skip }, async () => {
  const env = await create("no-leak");
  const ext = (await post(`/environments/${env.id}/connection-link`)).json().externalId as string;
  const list = await app.inject({ url: P + "/environments", headers: H });
  assert.ok(!list.body.includes(ext), "목록에 확인 문구가 있으면 안 됨");
  const a = await owner.query("SELECT detail::text AS d FROM audit_events WHERE target=$1", [env.id]);
  assert.ok(a.rows.length >= 2);
  for (const r of a.rows) assert.ok(!(r.d as string).includes(ext), "감사에 확인 문구 전체가 있으면 안 됨");
  assert.ok(a.rows.some((r) => (r.d as string).includes(ext.slice(0, 4))));
});

test("링크 모양: 스택 이름·ARN 인코딩·리전 (클러스터 이름은 PF02 부터 EKS 모양만)", { skip }, async () => {
  const env = await create("url-shape", { clusterName: "shop-eks_1", region: "us-east-1" });
  const url = new URL((await post(`/environments/${env.id}/connection-link`)).json().url);
  assert.equal(url.hostname, "us-east-1.console.aws.amazon.com");
  const q = new URLSearchParams(url.hash.split("?")[1]);
  assert.equal(q.get("param_PlatformPrincipalArn"), ARN);
  assert.equal(q.get("param_EksClusterName"), "shop-eks_1");
  assert.equal(q.get("templateURL"), TEMPLATE);
  assert.match(q.get("stackName")!, /^svc-connect-[A-Za-z0-9]{8}$/);
  assert.ok((q.get("param_ExternalId") ?? "").length >= 32);
});

test("입력 검사(400: 모르는 제공자·빈 이름) + 해제 후 disconnected", { skip }, async () => {
  const bad1 = await post("/environments", { provider: "nope", name: "x" });
  assert.equal(bad1.statusCode, 400);
  const bad2 = await post("/environments", { provider: "aws", name: "" });
  assert.equal(bad2.statusCode, 400);
  const env = await create("rev-creds", {}, "onprem");
  const d = await app.inject({ method: "DELETE", url: `${P}/environments/${env.id}`, headers: H });
  assert.equal(d.statusCode, 204, d.body);
  const row = await dbRow(env.id);
  assert.equal(row.connection_status, "disconnected");
});

test("PF01 FM-CLD-03: AWS 리전 오타는 400 BAD_REGION, 앞뒤 빈칸은 지워서 저장", { skip }, async () => {
  const bad = await post("/environments", { provider: "aws", name: "pf01-bad-region", region: "seoul", clusterName: "shop-eks" });
  assert.equal(bad.statusCode, 400); assert.equal(bad.json().code, "BAD_REGION");
  const ok = await post("/environments", { provider: "aws", name: "pf01-ok-region", region: " ap-northeast-2 ", clusterName: " shop-eks " });
  assert.equal(ok.statusCode, 201, ok.body);
  const r = (await owner.query("SELECT region, cluster_name FROM environments WHERE id=$1", [ok.json().id])).rows[0];
  assert.deepEqual(r, { region: "ap-northeast-2", cluster_name: "shop-eks" });
});

test("PF02 거부: AWS 클러스터 이름이 EKS 모양이 아니면 400 BAD_CLUSTER_NAME (CLI 인자·템플릿 파라미터로 들어감)", { skip }, async () => {
  for (const clusterName of ["--endpoint-url=http://x", "a b"]) {
    const r = await post("/environments", { provider: "aws", name: `pf02-${clusterName.length}`, clusterName });
    assert.equal(r.statusCode, 400); assert.equal(r.json().code, "BAD_CLUSTER_NAME");
  }
});
