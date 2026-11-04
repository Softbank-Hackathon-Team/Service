// DB 시험 (Z100, Z101 요청): GET /migrations/:id/spec — 받아들인 최신 판 우선, 없으면 AI 초안, 둘 다 없으면 404, 남의 회사 404
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
// 명세 한 벌 (spec_v2 칸): 서비스 shop + postgres db
const SPEC = {"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["s.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}};
const withReplicas = (n: number) => ({ ...SPEC, components: SPEC.components.map((c) => c.id === "shop" ? { ...c, props: { ...c.props, replicas: { min: n, max: n } } } : c) });

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;
const get = (tenant: string, id: string) => app.inject({ url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": tenant } });

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { specRoutes } = await import("../src/routes/spec.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z100'), ($2,'test-z100-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(specRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
});

async function seed(tenant: string, versions: { v: number; spec: unknown; meta: Record<string, unknown> }[]) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','k3s','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, tenant]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`,
    [id, tenant, src, dst]);
  // 칸 표시는 spec_v2.fieldMeta, AI 초안 표시(_draft)만 옛 칸 field_meta
  for (const x of versions) {
    const { _draft, ...m } = x.meta;
    await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,$3,'{}',$4,$5)`,
      [tenant, id, x.v, _draft ? { _draft } : {}, { spec: x.spec, fieldMeta: m, unmapped: [], ids: {} }]);
  }
  return id;
}
const meta = (needs: string[]) => Object.fromEntries(needs.map((k) => [k, { source: "ai", confidence: 0.6, needs_review: true }]));

test("받아들인 최신 판을 돌려준다 (그보다 새 AI 초안 판이 있어도)", { skip }, async () => {
  const id = await seed(T, [
    { v: 1, spec: withReplicas(1), meta: {} },
    { v: 2, spec: withReplicas(2), meta: meta(["components.shop.ports"]) },
    { v: 3, spec: { ...SPEC, app: { name: "ai" } }, meta: { _draft: { by: "ai" } } },
  ]);
  const r = await get(T, id);
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.version, 2);
  assert.equal(b.source, "accepted");
  assert.equal(b.complete, true);
  assert.deepEqual(b.spec.components.find((c: { id: string }) => c.id === "shop").props.replicas, { min: 2, max: 2 });
  assert.deepEqual(b.needsReview, ["components.shop.ports"]);
  assert.deepEqual(b.reviewLabels, { "components.shop.ports": "구성요소 shop 의 ports" });
  assert.match(b.createdAt, /Z$/);
});

test("받아들인 판이 없으면 AI 초안 판 (source ai_draft)", { skip }, async () => {
  const id = await seed(T, [{ v: 1, spec: SPEC, meta: { _draft: { by: "ai" } } }]);
  const b = (await get(T, id)).json();
  assert.equal(b.source, "ai_draft");
  assert.deepEqual(b.needsReview, []);
});

test("구조 검증(checkV2)을 못 넘는 판 → complete false, 명세는 그대로 보임", { skip }, async () => {
  const half = { ...SPEC, app: { name: "half" }, links: [...SPEC.links, { from: "shop", to: "nope", intent: "connect" }] };
  const id = await seed(T, [{ v: 1, spec: half, meta: {} }]);
  const r = await get(T, id);
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.complete, false);
  assert.equal(b.spec.app.name, "half");
});

test("명세가 없으면 404, 남의 회사 이전도 404", { skip }, async () => {
  const none = await seed(T, []);
  assert.equal((await get(T, none)).statusCode, 404);
  const mine = await seed(T, [{ v: 1, spec: SPEC, meta: {} }]);
  assert.equal((await get(OTHER, mine)).statusCode, 404);
});

test("모양이 깨진 판 → 409 SPEC_INVALID (가짜 기본값으로 안 채움)", { skip }, async () => {
  const id = await seed(T, [{ v: 1, spec: { service: { port: "x" } }, meta: {} }]);
  const r = await get(T, id);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error?.code ?? r.json().code, "SPEC_INVALID");
});
