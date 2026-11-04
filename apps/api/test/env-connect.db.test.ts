// 입력층 L2 DB 시험: 환경 만들기 → 연결 링크 → 확인 요청 → 해제. app.inject()로 부른다 (포트 안 엶).
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-l2'), ($2,'test-l2-other')", [T, OTHER]);
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
async function create(name: string, extra: Record<string, unknown> = { clusterName: "shop-eks" }, provider = "aws") {
  const r = await post("/environments", { provider, name, ...extra });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { id: string; connectionStatus: string };
}
const dbRow = async (id: string) => (await owner.query(
  "SELECT connection_status, external_id, account_id, failure_reason FROM environments WHERE id=$1", [id])).rows[0];
const jobs = async (id: string) => Number((await owner.query(
  "SELECT count(*) FROM pgboss.job WHERE name='verify-connection' AND data->>'envId'=$1", [id])).rows[0].count);

test("정상: 만들기 → 링크 → 링크 다시(같은 문구) → 확인 요청 → verifying + 작업 1개", { skip }, async () => {
  const env = await create("src-aws");
  assert.equal(env.connectionStatus, "draft");
  const l1 = await post(`/environments/${env.id}/connection-link`);
  assert.equal(l1.statusCode, 200, l1.body);
  const link = l1.json() as { kind: string; url: string; externalId: string; expiresAt: string };
  assert.equal(link.kind, "aws_quick_create");
  assert.ok(link.url.includes("templateURL=") && link.url.includes(`param_ExternalId=${link.externalId}`));
  assert.ok(Date.parse(link.expiresAt) - Date.now() > 23 * 3600_000);
  assert.equal((await dbRow(env.id)).connection_status, "awaiting_customer");
  const l2 = await post(`/environments/${env.id}/connection-link`);
  assert.equal(l2.json().externalId, link.externalId, "고객 대기 중 재발급은 같은 확인 문구");
  const v = await post(`/environments/${env.id}/verify`, { accountId: "123456789012" });
  assert.equal(v.statusCode, 202, v.body);
  assert.deepEqual(v.json(), { envId: env.id, status: "verifying", queued: true });
  const row = await dbRow(env.id);
  assert.equal(row.connection_status, "verifying");
  assert.equal(row.account_id, "123456789012");
  assert.equal(await jobs(env.id), 1);
  const list = await app.inject({ url: P + "/environments", headers: H });
  assert.equal(list.json().items.find((x: { id: string }) => x.id === env.id).connectionStatus, "verifying");
});

test("거부: 같은 이름 409, 남의 회사 링크 404, 11자리 계정 400", { skip }, async () => {
  const env = await create("dup-name");
  const d = await post("/environments", { provider: "aws", name: "dup-name" });
  assert.equal(d.statusCode, 409); assert.equal(d.json().code, "ENV_NAME_TAKEN");
  const o = await post(`/environments/${env.id}/connection-link`, {}, HO);
  assert.equal(o.statusCode, 404);
  await post(`/environments/${env.id}/connection-link`);
  const b = await post(`/environments/${env.id}/verify`, { accountId: "12345678901" });
  assert.equal(b.statusCode, 400); assert.equal(b.json().code, "BAD_ACCOUNT_ID");
  assert.equal((await dbRow(env.id)).connection_status, "awaiting_customer");
});

test("거부: 24시간 지난 링크로 확인 요청 → 400 LINK_EXPIRED, DB 에는 expired 가 남는다", { skip }, async () => {
  const env = await create("old-link");
  const first = (await post(`/environments/${env.id}/connection-link`)).json().externalId;
  await owner.query("UPDATE environments SET link_issued_at = now() - interval '25 hours' WHERE id=$1", [env.id]);
  const list = await app.inject({ url: P + "/environments", headers: H });
  assert.equal(list.json().items.find((x: { id: string }) => x.id === env.id).connectionStatus, "expired");
  const v = await post(`/environments/${env.id}/verify`, { accountId: "123456789012" });
  assert.equal(v.statusCode, 400); assert.equal(v.json().code, "LINK_EXPIRED");
  const row = await dbRow(env.id);
  assert.equal(row.connection_status, "expired");
  assert.equal(row.failure_reason, "LINK_EXPIRED");
  assert.equal(await jobs(env.id), 0);
  const again = await post(`/environments/${env.id}/connection-link`);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().externalId, first, "PF04: 만료 뒤 새 링크도 같은 확인 문구 (하루 뒤 만든 스택이 열리게)");
});

test("거부: 진행 중 이전이 있으면 해제 409, 없으면 204 + Agent 키 끊김", { skip }, async () => {
  const a = await create("busy-a"), b = await create("busy-b");
  await owner.query(`INSERT INTO migrations (tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,'provisioning')`,
    [T, a.id, b.id]);
  const busy = await app.inject({ method: "DELETE", url: `${P}/environments/${a.id}`, headers: H });
  assert.equal(busy.statusCode, 409); assert.equal(busy.json().code, "ENV_IN_USE");
  assert.equal((await dbRow(a.id)).connection_status, "draft");

  const free = await create("free-env", {}, "onprem");
  await owner.query("INSERT INTO agent_keys (id, tenant_id, env_id) VALUES ($1,$2,$3)",
    ["ak_" + randomUUID().replace(/-/g, "").slice(0, 20), T, free.id]);
  const del = await app.inject({ method: "DELETE", url: `${P}/environments/${free.id}`, headers: H });
  assert.equal(del.statusCode, 204, del.body);
  assert.equal((await dbRow(free.id)).connection_status, "disconnected");
  const k = await owner.query("SELECT count(*) FROM agent_keys WHERE env_id=$1 AND revoked_at IS NULL", [free.id]);
  assert.equal(Number(k.rows[0].count), 0);
  const again = await app.inject({ method: "DELETE", url: `${P}/environments/${free.id}`, headers: H });
  assert.equal(again.statusCode, 409, "해제된 환경은 다시 해제 못 한다");
});

test("거부: 제공자별 링크 (onprem 400, gcp 설정 없음 503, aws 클러스터 없음 400, 설정 없음 503)", { skip }, async () => {
  const on = await create("onp", {}, "onprem");
  assert.equal((await post(`/environments/${on.id}/connection-link`)).json().code, "USE_AGENT_TOKEN");
  const g = await create("gcp-1", {}, "gcp");
  const was = process.env.GCP_PLATFORM_PROJECT; delete process.env.GCP_PLATFORM_PROJECT;
  try {
    const gr = await post(`/environments/${g.id}/connection-link`);
    assert.equal(gr.statusCode, 503); assert.equal(gr.json().code, "CONNECT_NOT_CONFIGURED");
    assert.equal((await dbRow(g.id)).connection_status, "draft");
  } finally { if (was === undefined) delete process.env.GCP_PLATFORM_PROJECT; else process.env.GCP_PLATFORM_PROJECT = was; }
  const nc = await create("no-cluster", {});
  const r = await post(`/environments/${nc.id}/connection-link`);
  assert.equal(r.statusCode, 400); assert.equal(r.json().code, "CLUSTER_NAME_REQUIRED");
  const ok = await create("no-config");
  delete process.env.CONNECT_TEMPLATE_URL;
  try {
    const s = await post(`/environments/${ok.id}/connection-link`);
    assert.equal(s.statusCode, 503); assert.equal(s.json().code, "CONNECT_NOT_CONFIGURED");
    assert.equal((await dbRow(ok.id)).connection_status, "draft");
  } finally { process.env.CONNECT_TEMPLATE_URL = TEMPLATE; }
});

// F17: 링크 쿼리 boundaryPolicyExists=true 면 템플릿에 경계 정책을 만들지 말라고 넘긴다. 빠지면 기본(만듦)
test("F17: boundaryPolicyExists=true → 링크에 CreateBoundaryPolicy=false, 없으면 안 붙음, 이상한 값은 400", { skip }, async () => {
  const env = await create("f17-aws");
  const a = await post(`/environments/${env.id}/connection-link`);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().createBoundaryPolicy, true);
  assert.ok(!a.json().url.includes("CreateBoundaryPolicy"));
  const b = await post(`/environments/${env.id}/connection-link?boundaryPolicyExists=true`);
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(b.json().createBoundaryPolicy, false);
  assert.ok(b.json().url.includes("param_CreateBoundaryPolicy=false"));
  const bad = await post(`/environments/${env.id}/connection-link?boundaryPolicyExists=yes`);
  assert.equal(bad.statusCode, 400);
});

test("L7 정상: gcp 링크 = Cloud Shell + 명령 한 줄, 플랫폼 SA 는 이 회사 DB 값(t-…@플랫폼 프로젝트), 상태 awaiting_customer", { skip }, async () => {
  const g = await create("gcp-ok", {}, "gcp");
  const was = process.env.GCP_PLATFORM_PROJECT; process.env.GCP_PLATFORM_PROJECT = "svc-platform";
  try {
    const r = await post(`/environments/${g.id}/connection-link`);
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.kind, "gcp_cloud_shell");
    assert.match(b.url, /^https:\/\/shell\.cloud\.google\.com\//);
    const sa = (await owner.query("SELECT gcp_platform_sa FROM tenants WHERE id = (SELECT tenant_id FROM environments WHERE id=$1)", [g.id])).rows[0].gcp_platform_sa;
    assert.match(b.command, new RegExp(`PLATFORM_SA='${sa}@svc-platform\\.iam\\.gserviceaccount\\.com'`));
    assert.equal(b.externalId, undefined);
    assert.equal((await dbRow(g.id)).connection_status, "awaiting_customer");
  } finally { if (was === undefined) delete process.env.GCP_PLATFORM_PROJECT; else process.env.GCP_PLATFORM_PROJECT = was; }
});

test("PF04 거부: 해제(disconnected) 뒤 다시 연결하면 새 확인 문구 (옛 스택과 섞이지 않게)", { skip }, async () => {
  const env = await create("pf04-disc");
  const first = (await post(`/environments/${env.id}/connection-link`)).json().externalId;
  await owner.query("UPDATE environments SET connection_status='disconnected' WHERE id=$1", [env.id]);
  const again = await post(`/environments/${env.id}/connection-link`);
  if (again.statusCode === 200) assert.notEqual(again.json().externalId, first);
  else assert.equal(again.statusCode, 409);   // 해제에서 링크를 안 받는 설계면 409 (어느 쪽이든 옛 문구 재사용 없음)
});

test("PF07 운영자 실수: 콘솔 모양 계정 번호(1234-5678-9012)는 12자리로 받고, 모자라면 400", { skip }, async () => {
  const env = await create("src-aws-pf07");
  assert.equal((await post(`/environments/${env.id}/connection-link`)).statusCode, 200);
  const bad = await post(`/environments/${env.id}/verify`, { accountId: "1234-5678-901" });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().code, "BAD_ACCOUNT_ID");
  const v = await post(`/environments/${env.id}/verify`, { accountId: " 1234-5678-9012 " });
  assert.equal(v.statusCode, 202, v.body);
  assert.equal((await dbRow(env.id)).account_id, "123456789012");
});

// 결정 3번 A안: GCP 확인 요청에 이전 전용 프로젝트를 같이 받는다. 원래 프로젝트와 같거나 gcp 가 아니면 400, 다음 링크 명령에 들어간다
test("A안 정상: gcp verify 에 targetProjectId → DB gcp_target_project, 화면 targetProjectId, 다음 링크 명령에 TARGET_PROJECT_ID", { skip }, async () => {
  const g = await create("gcp-target", {}, "gcp");
  const was = process.env.GCP_PLATFORM_PROJECT; process.env.GCP_PLATFORM_PROJECT = "svc-platform";
  try {
    assert.equal((await post(`/environments/${g.id}/connection-link`)).statusCode, 200);
    const v = await post(`/environments/${g.id}/verify`, { accountId: "cust-prj-1", targetProjectId: "cust-mig-1" });
    assert.equal(v.statusCode, 202, v.body);
    const row = (await owner.query("SELECT account_id, gcp_target_project FROM environments WHERE id=$1", [g.id])).rows[0];
    assert.deepEqual(row, { account_id: "cust-prj-1", gcp_target_project: "cust-mig-1" });
    const list = (await app.inject({ method: "GET", url: `${P}/environments`, headers: H })).json() as { items: Array<{ id: string; targetProjectId?: string }> };
    assert.equal(list.items.find((e) => e.id === g.id)?.targetProjectId, "cust-mig-1");
    // 다시 확인할 때 빠뜨려도 있던 값 그대로
    await owner.query("UPDATE environments SET connection_status='failed' WHERE id=$1", [g.id]);
    assert.equal((await post(`/environments/${g.id}/verify`, { accountId: "cust-prj-1" })).statusCode, 202);
    assert.equal((await owner.query("SELECT gcp_target_project FROM environments WHERE id=$1", [g.id])).rows[0].gcp_target_project, "cust-mig-1");
    await owner.query("UPDATE environments SET connection_status='failed' WHERE id=$1", [g.id]);
    const l = await post(`/environments/${g.id}/connection-link`);
    assert.match(l.json().command, /TARGET_PROJECT_ID='cust-mig-1'/);
  } finally { if (was === undefined) delete process.env.GCP_PLATFORM_PROJECT; else process.env.GCP_PLATFORM_PROJECT = was; }
});

test("A안 거부: 전용 프로젝트가 원래 프로젝트와 같음·모양 틀림·aws 환경이면 400 BAD_TARGET_PROJECT, DB 안 바뀜", { skip }, async () => {
  const g = await create("gcp-target-bad", {}, "gcp");
  const was = process.env.GCP_PLATFORM_PROJECT; process.env.GCP_PLATFORM_PROJECT = "svc-platform";
  try {
    assert.equal((await post(`/environments/${g.id}/connection-link`)).statusCode, 200);
    for (const t of ["cust-prj-1", "Bad_Project"]) {
      const r = await post(`/environments/${g.id}/verify`, { accountId: "cust-prj-1", targetProjectId: t });
      assert.equal(r.statusCode, 400, r.body); assert.equal(r.json().code, "BAD_TARGET_PROJECT");
    }
    assert.equal((await owner.query("SELECT gcp_target_project FROM environments WHERE id=$1", [g.id])).rows[0].gcp_target_project, null);
  } finally { if (was === undefined) delete process.env.GCP_PLATFORM_PROJECT; else process.env.GCP_PLATFORM_PROJECT = was; }
  const a = await create("aws-target-bad");
  const r = await post(`/environments/${a.id}/verify`, { accountId: "111122223333", targetProjectId: "cust-mig-1" });
  assert.equal(r.statusCode, 400); assert.equal(r.json().code, "BAD_TARGET_PROJECT");
});
