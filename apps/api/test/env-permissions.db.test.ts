// PERM-GATE DB 시험: GET /environments/:id/permissions 는 저장된 결과 + 묶음별·전체 고치는 링크(최소 권한), POST permission-check 는 작업 하나만.
//   api 는 클라우드 CLI 를 부르지 않는다. 명령에 계정 번호·비밀값이 없다. DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER || process.env.TEST_DB_ISOLATE !== "1" ? "DATABASE_URL / OWNER_DATABASE_URL / TEST_DB_ISOLATE 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();
const SA_ID = "t-0123456789abcdef0123456789ab";
const saved = { GCP_PLATFORM_PROJECT: process.env.GCP_PLATFORM_PROJECT, GCP_CONNECT_REPO_URL: process.env.GCP_CONNECT_REPO_URL,
  CONNECT_TEMPLATE_URL: process.env.CONNECT_TEMPLATE_URL, PLATFORM_PRINCIPAL_ARN: process.env.PLATFORM_PRINCIPAL_ARN };

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

const gap = (envId: string, o: Record<string, unknown>) => ({ bundleId: "gcp.env", envId, cloud: "gcp", stage: "env", side: "target", principal: "svc-env", role: "platform_env",
  requiredWhen: ["env_layer_create"], level: "block", missing: ["compute.addresses.setLabels"], missingApis: [], grantedVersion: null, requiredVersion: 1, ...o });

before(async () => {
  if (skip) return;
  process.env.GCP_PLATFORM_PROJECT = "platform-prj";
  process.env.GCP_CONNECT_REPO_URL = "https://github.com/example/service";
  process.env.CONNECT_TEMPLATE_URL = "https://example-bucket.s3.amazonaws.com/aws-connect.json";
  process.env.PLATFORM_PRINCIPAL_ARN = "arn:aws:iam::999988887777:role/platform-worker";
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { envPermissionRoutes } = await import("../src/routes/env-permissions.js");
  const { environmentRoutes } = await import("../src/routes/environments.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name, gcp_platform_sa) VALUES ($1,'test-perm-api',$3), ($2,'test-perm-api-other',NULL)", [T, OTHER, SA_ID]);
  await core.startBoss();
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(envPermissionRoutes, { prefix: P });
  await app.register(environmentRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed(provider: string, status = "connected") {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, gcp_target_project, region) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, T, provider, `e-${id.slice(0, 6)}`, status, provider === "gcp" ? "cust-prj" : provider === "aws" ? "111122223333" : null, provider === "gcp" ? "cust-mig" : null, provider === "aws" ? "ap-northeast-2" : null]);
  return id;
}
const store = (envId: string, gaps: object[]) => owner.query(
  `INSERT INTO environment_permissions (environment_id, tenant_id, result, requested_at, checked_at) VALUES ($1,$2,$3, now() - interval '2 seconds', now() - interval '1 second')`,
  [envId, T, JSON.stringify({ requiredVersion: 1, grantedVersion: null, gaps })]);
const get = (envId: string, q = "", h = T) => app.inject({ method: "GET", url: `${P}/environments/${envId}/permissions${q}`, headers: { "x-dev-tenant": h } });
const post = (envId: string, h = T) => app.inject({ method: "POST", url: `${P}/environments/${envId}/permission-check`, headers: { "x-dev-tenant": h } });
const jobs = async (envId: string) => Number((await owner.query("SELECT count(*) FROM pgboss.job WHERE name='permission-check' AND data->>'envId'=$1", [envId])).rows[0].count);

test("GET 권한: 묶음마다 Cloud Shell 링크(ONLY_BUNDLES=그 묶음만) + 전체 링크, 환경 목록엔 고칠 묶음 수", { skip }, async () => {
  const id = await seed("gcp");
  await store(id, [gap(id, {}), gap(id, { bundleId: "gcp.observe.target", stage: "observe", principal: "svc-observe", role: "platform_observe", level: "warn", missing: [], unverified: "x" }),
    gap(id, { bundleId: "gcp.operate", principal: "svc-operate", role: "platform_operate", missing: [], notInTable: ["compute.weird.get"] })]);
  const r = await get(id);
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.gaps.length, 3);
  assert.equal(b.gaps[0].fix.kind, "cloudshell");
  assert.match(b.gaps[0].fix.command, /ONLY_BUNDLES=gcp\.env bash onboarding\/gcp-connect\.sh$/);
  assert.match(b.gaps[0].fix.url, /^https:\/\/shell\.cloud\.google\.com\/cloudshell\/editor\?cloudshell_git_repo=/);
  assert.equal(b.gaps[2].fix, undefined, "권한표에 없는 것만 있는 묶음은 고객 링크로 못 고친다");
  assert.match(b.fix.command, /ONLY_BUNDLES=gcp\.env,gcp\.observe\.target /);
  assert.ok(!/\d{12}/.test(JSON.stringify(b)), "계정 번호 없음");
  assert.equal(b.refreshing, false); assert.ok(b.checkedAt);
  // 사전 점검이 막은 묶음만 고르면 그 묶음만
  assert.match((await get(id, "?bundles=gcp.operate.postgres")).json().fix.command, /ONLY_BUNDLES=gcp\.operate\.postgres /);
  const list = await app.inject({ method: "GET", url: `${P}/environments`, headers: { "x-dev-tenant": T } });
  assert.equal(list.json().items.find((e: { id: string }) => e.id === id).permissionGaps, 1, "빠진 권한이 있는 묶음 수");
  const fresh = await seed("gcp");
  assert.equal(list.json().items.find((e: { id: string }) => e.id === fresh), undefined);
  const l2 = await app.inject({ method: "GET", url: `${P}/environments`, headers: { "x-dev-tenant": T } });
  assert.ok(!("permissionGaps" in l2.json().items.find((e: { id: string }) => e.id === fresh)), "확인한 적 없으면 칸 없음");
});

test("GET 권한 AWS: 같은 연결 스택 업데이트 (매개변수 이전 값, 계정 번호 없음)", { skip }, async () => {
  const id = await seed("aws");
  await store(id, [gap(id, { bundleId: "aws.relay.target", cloud: "aws", stage: "relay", principal: "svc-operate", role: "relay", requiredWhen: ["relay_gcp_aws"],
    missing: ["ec2:AuthorizeSecurityGroupIngress"] })]);
  const f = (await get(id)).json().fix;
  assert.equal(f.kind, "cloudformation");
  assert.match(f.command, new RegExp(`^aws cloudformation update-stack --region ap-northeast-2 --stack-name svc-connect-${id.replace(/-/g, "").slice(0, 8)} `));
  assert.match(f.command, /UsePreviousValue=true/);
  assert.match(f.url, /#\/stacks\/update\/template\?stackId=svc-connect-/);
  assert.ok(!/\d{12}/.test(f.command + f.url), "플랫폼·고객 계정 번호 없음");
});

test("POST 다시 확인: 작업 하나(도는 중이면 또 안 넣음), 연결 안 됨 409, 남의 회사 404, 확인 전 GET 은 빈 결과", { skip }, async () => {
  const id = await seed("gcp");
  const empty = (await get(id)).json();
  assert.deepEqual([empty.checkedAt, empty.gaps, empty.refreshing], [null, [], false]);
  const a = await post(id);
  assert.equal(a.statusCode, 202, a.body);
  assert.deepEqual(a.json(), { envId: id, queued: true });
  assert.deepEqual((await post(id)).json(), { envId: id, queued: false });
  assert.equal(await jobs(id), 1);
  assert.equal((await get(id)).json().refreshing, true);
  assert.equal((await post(await seed("gcp", "awaiting_customer"))).statusCode, 409);
  assert.equal((await post(id, OTHER)).statusCode, 404);
  assert.equal((await get(id, "", OTHER)).statusCode, 404);
  assert.equal((await post(await seed("onprem"))).statusCode, 400);
});
