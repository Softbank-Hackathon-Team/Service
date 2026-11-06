// 한 AWS 계정에 환경 여럿 (0056 environments.aws_role_suffix) DB 시험: 마이그레이션 칸·CHECK, 연결 링크가 꼬리를 정하고 넘기는지.
//   새 환경 = 확인 문구를 새로 만들 때 "-<환경 번호 앞 8자>" 를 적고 링크에 param_RoleSuffix. 옛 환경(이 배포 전 링크) = NULL 그대로, 매개변수 없음
// DATABASE_URL(app_user)·OWNER_DATABASE_URL(표 주인)이 없으면 건너뛴다 (CI 의 DB 시험에서 돈다)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID();
const H = { "x-dev-tenant": T };
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-aws-role-suffix')", [T]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(environmentRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
});

const post = (url: string, payload?: unknown) => app.inject({ method: "POST", url: P + url, headers: H, payload: payload ?? {} });
async function create(name: string, provider = "aws", extra: Record<string, unknown> = { clusterName: "shop-eks" }) {
  const r = await post("/environments", { provider, name, ...(provider === "aws" ? extra : {}) });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { id: string };
}
const suffixOf = async (id: string) => (await owner.query("SELECT aws_role_suffix FROM environments WHERE id=$1", [id])).rows[0]?.aws_role_suffix as string | null;
const link = async (id: string) => {
  const r = await post(`/environments/${id}/connection-link`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as { url: string; externalId: string };
};
const paramOf = (url: string, k: string) => new URLSearchParams(url.split("#")[1]?.split("?")[1] ?? "").get(k);

test("마이그레이션: 칸은 NULL 허용·기본값 없음, 모양 CHECK·AWS 전용 CHECK", { skip }, async () => {
  const col = (await owner.query(`SELECT is_nullable, column_default FROM information_schema.columns
    WHERE table_schema='public' AND table_name='environments' AND column_name='aws_role_suffix'`)).rows[0];
  assert.deepEqual(col, { is_nullable: "YES", column_default: null });
  const aws = await create("suffix-check-aws");
  assert.equal(await suffixOf(aws.id), null, "draft 환경은 아직 꼬리 없음");
  for (const bad of ["783df2ef", "-783DF2EF", "-783df2e", "-783df2ef0", "-*"]) {
    await assert.rejects(owner.query("UPDATE environments SET aws_role_suffix=$2 WHERE id=$1", [aws.id, bad]), (e: { code?: string }) => e.code === "23514", bad);
  }
  const gcp = await create("suffix-check-gcp", "gcp");
  await assert.rejects(owner.query("UPDATE environments SET aws_role_suffix='-0123abcd' WHERE id=$1", [gcp.id]), (e: { code?: string }) => e.code === "23514");
});

test("새 AWS 환경: 첫 링크가 꼬리(-<환경 8자>)를 적고 param_RoleSuffix 로 넘긴다, 다시 받아도 같은 꼬리", { skip }, async () => {
  const env = await create("suffix-new");
  const want = `-${env.id.replace(/-/g, "").slice(0, 8)}`;
  const l1 = await link(env.id);
  assert.equal(await suffixOf(env.id), want);
  assert.equal(paramOf(l1.url, "param_RoleSuffix"), want);
  assert.equal(paramOf(l1.url, "stackName"), `svc-connect${want}`, "스택 이름 꼬리 = 역할 이름 꼬리");
  const l2 = await link(env.id);
  assert.equal(l2.externalId, l1.externalId);
  assert.equal(paramOf(l2.url, "param_RoleSuffix"), want);
  // 감사에 꼬리가 남는다 (확인 문구 원문은 없음)
  const audit = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='env.link_issued' ORDER BY seq", [env.id])).rows;
  assert.equal(audit[0]?.detail.roleSuffix, want);
});

test("같은 회사·같은 계정 두 환경: 꼬리가 서로 달라 두 번째 스택이 역할 이름으로 부딪히지 않는다", { skip }, async () => {
  const a = await create("suffix-pair-a"), b = await create("suffix-pair-b");
  const [la, lb] = [await link(a.id), await link(b.id)];
  const [sa, sb] = [paramOf(la.url, "param_RoleSuffix"), paramOf(lb.url, "param_RoleSuffix")];
  assert.ok(sa && sb && sa !== sb);
  assert.notEqual(la.externalId, lb.externalId);
});

test("옛 환경(이 배포 전에 링크를 받음 = 문구 있음·꼬리 NULL): 다시 받아도 꼬리를 안 붙인다 (이미 옛 이름 스택을 만들었을 수 있음)", { skip }, async () => {
  const env = await create("suffix-old");
  const ext = "a".repeat(64);
  await owner.query(`UPDATE environments SET external_id=$2, connection_status='awaiting_customer', link_issued_at=now() WHERE id=$1`, [env.id, ext]);
  const l = await link(env.id);
  assert.equal(l.externalId, ext);
  assert.equal(await suffixOf(env.id), null);
  assert.equal(paramOf(l.url, "param_RoleSuffix"), null, "매개변수가 없으면 템플릿 기본 \"\" = 예전 이름");
});

test("이미 연결된 옛 환경: 줄이 그대로 (마이그레이션이 값을 채우지 않음)", { skip }, async () => {
  const env = await create("suffix-connected-old");
  await owner.query(`UPDATE environments SET external_id=$2, account_id='111122223333', connection_status='connected' WHERE id=$1`, [env.id, "b".repeat(64)]);
  assert.equal(await suffixOf(env.id), null);
});
