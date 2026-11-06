// DB 시험: GET /migrations/:id/spec 이 출발·도착 환경 종류로 상품 대체 미리보기(substitutions)를 싣는다
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

const SPEC = { schemaVersion: "2", app: { name: "shop" },
  components: [
    { id: "shop", kind: "service", props: { runtime: "k8s", origin: { runtime: "k8s", product: "unknown" },
      image: { source: "registry", repository: "r/shop", digest: "sha256:" + "a".repeat(64) }, ports: [{ port: 8080, protocol: "TCP" }],
      replicas: { min: 1, max: 1 }, serviceAccount: "default", resources: { request: { cpuMilli: 500, memMiB: 1024 } }, env: [] } },
    { id: "shop-db", kind: "postgres", props: { majorVersion: "16", storageGb: 20 } },
    { id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 1024, tls: false, auth: false } },
  ],
  links: [{ from: "shop", to: "shop-db", intent: "connect" }, { from: "shop", to: "shop-cache", intent: "connect" }],
  posture: { permissions: [], network: [] } };

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { specRoutes } = await import("../src/routes/spec.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-spec-subs')", [T]);
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

async function seed(source: string, target: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,$4,'src','connected'), ($2,$3,$5,'dst','connected')`, [src, dst, T, source, target]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`,
    [id, T, src, dst]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}','{}',$3)`,
    [T, id, { spec: SPEC, fieldMeta: {} }]);
  return id;
}
const subs = async (id: string) => {
  const r = await app.inject({ method: "GET", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": T } });
  assert.equal(r.statusCode, 200, r.body);
  return (r.json().substitutions as { kind: string; subject: string; from: string; to: string }[]).map((x) => [x.kind, x.subject, x.from, x.to]);
};

test("AWS → GCP: RDS·ElastiCache 가 대체 2줄로 온다", { skip }, async () => {
  assert.deepEqual(await subs(await seed("aws", "gcp")), [
    ["substitute", "shop-cache", "ElastiCache (redis)", "Memorystore (redis)"],
    ["substitute", "shop-db", "RDS for PostgreSQL", "Cloud SQL for PostgreSQL"],
  ]);
});

test("같은 클라우드(GCP → GCP)면 0줄", { skip }, async () => {
  assert.deepEqual(await subs(await seed("gcp", "gcp")), []);
});
