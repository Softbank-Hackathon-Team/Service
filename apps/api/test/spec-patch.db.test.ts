// DB 시험 (PA2, 계획 26 · A2): PATCH /migrations/:id/spec — 사람 수정·확인·AI 초안 받아들이기 → 새 판 하나
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
const SPEC: any = {"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"ghcr.io/demo/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":2,"max":2},"serviceAccount":"default","resources":{"request":{"cpuMilli":250,"memMiB":512}},"env":[{"name":"DB_PASSWORD","value":"s3cret-value"}]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["shop.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}};

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  const { specRoutes } = await import("../src/routes/spec.js");
  const { planRoutes } = await import("../src/routes/plans.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-pa2'), ($2,'test-pa2-other')", [T, OTHER]);
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

async function seed(status: string, versions: { v: number; spec: unknown; meta: Record<string, unknown> }[], tenant = T) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','k3s','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, tenant]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, tenant, src, dst, status]);
  // 명세는 spec_v2 칸에만. v1 칸 spec 은 '{}', field_meta 는 초안 표시(_draft)만
  for (const x of versions) {
    const { _draft, ...meta } = x.meta as Record<string, unknown>;
    await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,$3,'{}',$4,$5)`,
      [tenant, id, x.v, _draft ? { _draft } : {}, { spec: x.spec, fieldMeta: meta, unmapped: [], ids: {} }]);
  }
  return id;
}
const review = (ks: string[]) => Object.fromEntries(ks.map((k) => [k, { source: "ai", confidence: 0.6, needs_review: true }]));
const patch = (id: string, payload: unknown, o: { tenant?: string; key?: string } = {}) => app.inject({
  method: "PATCH", url: `${P}/migrations/${id}/spec`, payload: payload as object,
  headers: { "x-dev-tenant": o.tenant ?? T, ...(o.key ? { "idempotency-key": o.key } : {}) } });
// 판마다 (version, spec, field_meta) — field_meta 는 명세 칸 표시 + 초안 표시를 합친 것
const versions = async (id: string) => (await owner.query(
  "SELECT version, spec_v2->'spec' AS spec, COALESCE(spec_v2->'fieldMeta', '{}'::jsonb) || field_meta AS field_meta FROM spec_versions WHERE migration_id=$1 ORDER BY version", [id])).rows;
const audits = async (id: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND action='spec.edited'", [id])).rows;

test("정상: 검토 필요 2칸 confirm → 새 판 0칸 → POST /plan 202", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: review(["components.shop.ports", "components.shop.replicas"]) }]);
  const before = await app.inject({ method: "POST", url: `${P}/migrations/${id}/plan`, payload: {}, headers: { "x-dev-tenant": T } });
  assert.equal(before.statusCode, 409, "검토 칸이 남으면 계획 못 함");
  const r = await patch(id, { baseVersion: 1, confirm: ["components.shop.ports", "components.shop.replicas"] });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.version, 2);
  assert.equal(b.source, "accepted");
  assert.deepEqual(b.needsReview, []);
  const vs = await versions(id);
  assert.equal(vs.length, 2);
  assert.equal(vs[1].field_meta["components.shop.ports"].source, "ai", "confirm 은 출처·신뢰도 그대로");
  assert.equal(vs[1].field_meta["components.shop.ports"].confidence, 0.6);
  const a = await audits(id);
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].detail.confirmed, ["components.shop.ports", "components.shop.replicas"]);
  const plan = await app.inject({ method: "POST", url: `${P}/migrations/${id}/plan`, payload: {}, headers: { "x-dev-tenant": T } });
  assert.equal(plan.statusCode, 202, plan.body);
});

test("정상: changes → 값 바뀌고 그 칸은 사람 출처, 감사엔 칸 이름만(값 없음)", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: review(["components.shop.ports"]) }]);
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop.ports", value: [{ port: 9090, protocol: "TCP" }] },
    { path: "components.shop.env", value: [{ name: "DB_PASSWORD", value: "new-secret-xyz" }] }] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().spec.components[0].props.ports[0].port, 9090);
  const vs = await versions(id);
  assert.deepEqual(vs[1].field_meta["components.shop.ports"], { source: "human", confidence: 1, needs_review: false });
  const a = JSON.stringify(await audits(id));
  assert.ok(a.includes("components.shop.env"));
  assert.ok(!a.includes("new-secret-xyz") && !a.includes("s3cret-value"), "감사에 값이 새면 안 됨");
});

test("정상: acceptDraft → 사람 판 생김(_draft 빠짐), AI 칸은 아직 검토 필요", { skip }, async () => {
  const draftMeta = { ...review(["components.shop.replicas"]), _draft: { source: "ai:x", confidence: 0.6, needs_review: true } };
  const id = await seed("spec_review", [
    { v: 1, spec: SPEC, meta: {} },
    { v: 2, spec: { ...SPEC, components: [{ ...SPEC.components[0], props: { ...SPEC.components[0].props, replicas: { min: 3, max: 3 } } }, SPEC.components[1]] }, meta: draftMeta },
  ]);
  const r = await patch(id, { baseVersion: 1, acceptDraft: 2 });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.version, 3);
  assert.equal(b.source, "accepted");
  assert.deepEqual(b.spec.components[0].props.replicas, { min: 3, max: 3 });
  assert.deepEqual(b.needsReview, ["components.shop.replicas"]);
  const vs = await versions(id);
  assert.equal(vs[2].field_meta._draft, undefined);
  const g = (await app.inject({ url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": T } })).json();
  assert.equal(g.version, 3, "GET 도 새 판을 보여 줌");
});

test("거부: 옛 baseVersion → 409 SPEC_VERSION_CONFLICT, 판 그대로", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: {} }, { v: 2, spec: SPEC, meta: {} }]);
  const r = await patch(id, { baseVersion: 1, confirm: ["components.shop.ports"] });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "SPEC_VERSION_CONFLICT");
  assert.equal((await versions(id)).length, 2);
});

test("거부: 이미지 디지스트를 latest 태그로 → 400, 판 그대로 / 없는 칸 이름 → 400", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: {} }]);
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop.image", value: { source: "registry", repository: "ghcr.io/demo/shop:latest", digest: "latest" } }] });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().code, "SPEC_PATCH_INVALID");
  assert.ok(!r.body.includes("ghcr.io/demo/shop:latest"), "오류에 값을 되돌려 주지 않음");
  const bad = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop.nope", value: 1 }] });
  assert.equal(bad.statusCode, 400);
  const empty = await patch(id, { baseVersion: 1 });
  assert.equal(empty.statusCode, 400, "할 일이 없는 본문");
  assert.equal((await versions(id)).length, 1);
});

test("거부: 상태 planning → 409 INVALID_TRANSITION / AI 초안만 있는데 acceptDraft 없음 → 409", { skip }, async () => {
  const id = await seed("planning", [{ v: 1, spec: SPEC, meta: review(["components.shop.ports"]) }]);
  const r = await patch(id, { baseVersion: 1, confirm: ["components.shop.ports"] });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "INVALID_TRANSITION");
  assert.equal((await versions(id)).length, 1);
  const d = await seed("spec_review", [{ v: 1, spec: SPEC, meta: { _draft: { source: "ai:x", confidence: 0.6, needs_review: true } } }]);
  const r2 = await patch(d, { baseVersion: 1, confirm: ["components.shop.ports"] });
  assert.equal(r2.statusCode, 409, r2.body);
  assert.equal(r2.json().code, "SPEC_DRAFT_NOT_ACCEPTED");
});

test("거부: 남의 회사 이전 → 404, 판 그대로", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: review(["components.shop.ports"]) }]);
  const r = await patch(id, { baseVersion: 1, confirm: ["components.shop.ports"] }, { tenant: OTHER });
  assert.equal(r.statusCode, 404, r.body);
  assert.equal((await versions(id)).length, 1);
});

test("거부: 같은 멱등 키 재전송 → 같은 판 번호, 판은 하나만 늘어남", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: review(["components.shop.ports"]) }]);
  const key = `pa2-${randomUUID()}`;
  const a = await patch(id, { baseVersion: 1, confirm: ["components.shop.ports"] }, { key });
  const b = await patch(id, { baseVersion: 1, confirm: ["components.shop.ports"] }, { key });
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(b.headers["idempotent-replayed"], "true");
  assert.equal(a.json().version, b.json().version);
  assert.equal((await versions(id)).length, 2);
  assert.equal((await audits(id)).length, 1);
});
