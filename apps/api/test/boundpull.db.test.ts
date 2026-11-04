// BOUNDPULL: PATCH /migrations/:id/spec include — 경계 밖 데이터 자원을 명세 안으로 끌어오기
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

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;
// 가져오기 판 한 줄 (import.ts 와 같은 순서: normalizeV2 → checkV2 reviews)
const OOB_UNUSED = [{ resource: "s3.bucket:acme-terraform-state", kind: "objectStore", reason: "이 앱의 서비스·잡이 env·비밀·IAM 근거로 닿지 않음" }];
let V2: { spec: unknown; fieldMeta: Record<string, unknown>; specV2: Record<string, any> };

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const adapters = await import("@svc/adapters");
  const contracts = await import("@svc/contracts");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { specRoutes } = await import("../src/routes/spec.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  const NSX = "shop", DG = "sha256:" + "ab".repeat(32), ACC = "000000000000";
  const dep = { kind: "k8s.deployment", imageDigest: DG, metadata: { name: "shop-api", namespace: NSX, labels: { app: "shop-api" } },
    spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } }, template: { metadata: { labels: { app: "shop-api" } }, spec: { serviceAccountName: "shop-api", containers: [{
      name: "shop-api", image: "ghcr.io/demo/shop-api:1.0", ports: [{ containerPort: 8080 }], resources: { requests: { cpu: "250m", memory: "256Mi" } }, env: [] }] } } } };
  const items = [dep,
    { kind: "s3.bucket", Name: "shop-uploads", Arn: "arn:aws:s3:::shop-uploads" },
    { kind: "s3.bucket", Name: "acme-tfstate", Arn: "arn:aws:s3:::acme-tfstate" },
    { kind: "rds.dbInstance", DBInstanceIdentifier: "analytics-db", Engine: "postgres", EngineVersion: "16", AllocatedStorage: 20,
      Endpoint: { Address: "analytics-db.abc.ap-northeast-2.rds.amazonaws.com" }, DBInstanceArn: `arn:aws:rds:ap-northeast-2:${ACC}:db:analytics-db` }];
  const { result } = adapters.normalizeV2({ provider: "aws", coverage: {}, items } as never);
  const stored = contracts.ImportResultV2.parse(result);
  V2 = { spec: {}, fieldMeta: {}, specV2: stored as unknown as Record<string, any> };
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-boundpull'), ($2,'test-boundpull-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(specRoutes, { prefix: P });
  await app.register(planRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed(withV2 = true, tenant = T) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'gcp','gke','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, tenant]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`,
    [id, tenant, src, dst]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,$3,$4,$5)`,
    [tenant, id, V2.spec, V2.fieldMeta, withV2 ? V2.specV2 : null]);
  return id;
}
const patch = (id: string, payload: unknown, tenant = T) => app.inject({
  method: "PATCH", url: `${P}/migrations/${id}/spec`, payload: payload as object, headers: { "x-dev-tenant": tenant } });
const versions = async (id: string) => (await owner.query(
  "SELECT version, spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version", [id])).rows;
const svc = (v2: any, cid: string) => v2.spec.components.find((c: { id: string }) => c.id === cid);

const get = async (id: string) => (await app.inject({ method: "GET", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": T } })).json();
const plan = (id: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/plan`, payload: {}, headers: { "x-dev-tenant": T } });


const comps = (v: any) => v.spec_v2.spec.components.map((c: { id: string }) => c.id).sort();
const outRes = (v: any) => (v.spec_v2.outOfBoundary ?? []).map((o: { resource: string }) => o.resource).sort();

test("정상: include 로 버킷을 끌어오면 새 판 2 에 구성요소가 있고 경계 밖 목록에서 빠지며, 응답·GET 에도 반영, 감사에 이름만", { skip }, async () => {
  const id = await seed();
  const v0 = (await versions(id))[0];
  assert.ok(outRes(v0).includes("s3.bucket:shop-uploads"), JSON.stringify(outRes(v0)));
  const r = await patch(id, { baseVersion: 1, include: ["s3.bucket:shop-uploads"] });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().specV2.components.some((c: { id: string }) => c.id === "shop-uploads"));
  assert.ok(!r.json().outOfBoundary.some((o: { resource: string }) => o.resource === "s3.bucket:shop-uploads"));
  assert.equal(r.json().fieldMetaV2["components.shop-uploads.boundary"].source, "human");
  assert.ok(r.json().needsReviewV2.includes("components.shop-uploads.boundary"), "사람이 넣은 자원은 확인 필요");
  const v = await versions(id);
  assert.equal(v.length, 2);
  assert.deepEqual(v[1].spec_v2.included, ["s3.bucket:shop-uploads"]);
  assert.ok(!("shop-uploads" in (v[1].spec_v2.boundaryPool ?? {})) && !("s3.bucket:shop-uploads" in (v[1].spec_v2.boundaryPool ?? {})));
  const a = await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='spec.edited' ORDER BY seq DESC LIMIT 1`, [id]);
  assert.deepEqual(a.rows[0].detail.included, ["s3.bucket:shop-uploads"]);
  // 확인하면 검토 칸이 사라진다
  const c = await patch(id, { baseVersion: 2, confirm: ["components.shop-uploads.boundary"] });
  assert.equal(c.statusCode, 200, c.body);
  assert.ok(!c.json().needsReviewV2.includes("components.shop-uploads.boundary"));
  assert.deepEqual(c.json().specV2.components.map((x: { id: string }) => x.id).sort(), comps((await versions(id))[2]));
});

test("include + changes 한 요청: 끌어온 구성요소의 칸을 같은 요청에서 고칠 수 있다 (include 가 먼저)", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, include: ["s3.bucket:shop-uploads"], changes: [{ path: "components.shop-uploads.versioning", value: true }] });
  assert.equal(r.statusCode, 200, r.body);
  const v = (await versions(id))[1];
  assert.equal(v.spec_v2.spec.components.find((c: { id: string }) => c.id === "shop-uploads").props.versioning, true);
});

test("거부: 없는 이름 → 400 SPEC_PATCH_INVALID, 이미 끌어온 이름 → 400, 판 그대로", { skip }, async () => {
  const id = await seed();
  const bad = await patch(id, { baseVersion: 1, include: ["s3.bucket:nope"] });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().code, "SPEC_PATCH_INVALID");
  assert.match(bad.json().message, /s3\.bucket:nope/);
  assert.equal((await versions(id)).length, 1);
  assert.equal((await patch(id, { baseVersion: 1, include: ["s3.bucket:shop-uploads"] })).statusCode, 200);
  const again = await patch(id, { baseVersion: 2, include: ["s3.bucket:shop-uploads"] });
  assert.equal(again.statusCode, 400, again.body);
  assert.match(again.json().message, /이미/);
  assert.equal((await versions(id)).length, 2);
});

test("거부: 좋은 이름 + 나쁜 이름이 섞이면 통째로 400, 좋은 쪽도 안 들어간다 / 낡은 baseVersion 은 409", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, include: ["s3.bucket:shop-uploads", "s3.bucket:nope"] });
  assert.equal(r.statusCode, 400);
  assert.ok(!comps((await versions(id))[0]).includes("shop-uploads"));
  assert.equal((await versions(id)).length, 1);
  const stale = await patch(id, { baseVersion: 9, include: ["s3.bucket:shop-uploads"] });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, "SPEC_VERSION_CONFLICT");
});

test("409: 끌어올 재료가 없는 판(boundaryPool 없는 옛 판) · 워크로드 이름 → SPEC_INCLUDE_UNAVAILABLE", { skip }, async () => {
  const id = await seed();
  await owner.query("UPDATE spec_versions SET spec_v2 = spec_v2 - 'boundaryPool' WHERE migration_id=$1", [id]);
  const r = await patch(id, { baseVersion: 1, include: ["s3.bucket:shop-uploads"] });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "SPEC_INCLUDE_UNAVAILABLE");
  assert.equal((await versions(id)).length, 1);
});

test("거부: 예전 판(spec_v2 NULL)에 include → 409 SPEC_INVALID / 빈 include 만 보내면 400(할 일 없음)", { skip }, async () => {
  const v1 = await seed(false);
  const r = await patch(v1, { baseVersion: 1, include: ["s3.bucket:shop-uploads"] });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "SPEC_INVALID");
  const id = await seed();
  assert.equal((await patch(id, { baseVersion: 1, include: [] })).statusCode, 400);
});

test("남의 회사 이전에 include → 404, 판 그대로", { skip }, async () => {
  const id = await seed(true, OTHER);
  const r = await patch(id, { baseVersion: 1, include: ["s3.bucket:shop-uploads"] }, T);
  assert.equal(r.statusCode, 404, r.body);
  assert.equal((await versions(id)).length, 1);
});

test("GET spec 보기에 boundaryPool·included 같은 재료가 새지 않는다 (outOfBoundary 만)", { skip }, async () => {
  const id = await seed();
  await patch(id, { baseVersion: 1, include: ["s3.bucket:shop-uploads"] });
  const j = await get(id);
  assert.ok(!("boundaryPool" in j) && !("included" in j));
  assert.ok(!JSON.stringify(j).includes("boundaryPool"));
});

test("DB(postgres) 도 끌어올 수 있다 — v1 투영(rebuildFromV2)이 깨지지 않고 새 판이 저장된다", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, include: ["rds.dbInstance:analytics-db"] });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().specV2.components.some((c: { id: string; kind: string }) => c.id === "analytics-db" && c.kind === "postgres"));
});
