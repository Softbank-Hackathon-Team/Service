// NS-1: 네임스페이스 객체를 못 읽은 가져오기 판(namespaces.<ns> needs_review:true)이 spec_review 에 갇히지 않는다.
//   POST /plan(T04)은 검토 칸이 남아 409 → PATCH confirm namespaces.<ns> 200, needsReview 0 → POST /plan 202
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
const prev = process.env.SPEC_MIN_CONFIDENCE;
const SPEC = {"schemaVersion":"2","app":{"name":"shop"},"namespaces":[{"name":"real-app"}],"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"gke"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}}],"links":[],"posture":{"permissions":[],"network":[]}};
// 가져오기(adapters import/pipeline.ts namespacesOf)가 네임스페이스 객체를 못 읽었을 때 남기는 표시 그대로
const NS_META = { "namespaces.real-app": { source: "k8s:namespace/real-app", confidence: 0.6, needs_review: true,
  rationale: "네임스페이스 객체를 못 읽음 → 라벨(파드 보안 수준·메시 주입)이 있었는지 모름. 도착은 라벨 없이 만듦" } };

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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-ns-confirm')", [T]);
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
  if (prev === undefined) delete process.env.SPEC_MIN_CONFIDENCE; else process.env.SPEC_MIN_CONFIDENCE = prev;
  if (skip) return;
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

async function seed(meta: Record<string, unknown>) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'gcp','gke','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}','{}',$3)`,
    [T, id, JSON.stringify({ spec: SPEC, fieldMeta: meta, unmapped: [], ids: {} })]);
  return id;
}
const plan = (id: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/plan`, payload: {}, headers: { "x-dev-tenant": T } });
const patch = (id: string, payload: object) => app.inject({ method: "PATCH", url: `${P}/migrations/${id}/spec`, payload, headers: { "x-dev-tenant": T } });

for (const min of [undefined, "0.7"]) {
  test(`NS-1: namespaces.<ns> 검토 칸 → POST /plan 409, PATCH confirm 200·needsReview 0 → POST /plan 202 (SPEC_MIN_CONFIDENCE=${min ?? "끔"})`, { skip }, async () => {
    if (min === undefined) delete process.env.SPEC_MIN_CONFIDENCE; else process.env.SPEC_MIN_CONFIDENCE = min;
    const id = await seed(NS_META);
    const stuck = await plan(id);
    assert.equal(stuck.statusCode, 409, stuck.body);
    assert.match(stuck.json().message, /1 field\(s\) need review/);
    const r = await patch(id, { baseVersion: 1, confirm: ["namespaces.real-app"] });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().needsReview, []);
    assert.equal(r.json().fieldMeta["namespaces.real-app"].needs_review, false);
    assert.equal(r.json().fieldMeta["namespaces.real-app"].source, "k8s:namespace/real-app", "출처는 그대로");
    const ok = await plan(id);
    assert.equal(ok.statusCode, 202, ok.body);
  });
}

test("NS-1 거부: 머리 이름이 틀린 확인 경로는 400 그대로, 판은 안 바뀜", { skip }, async () => {
  const id = await seed(NS_META);
  for (const p of ["namespace.real-app", "namespaces real-app"])
    assert.equal((await patch(id, { baseVersion: 1, confirm: [p] })).statusCode, 400, p);
  assert.equal((await plan(id)).statusCode, 409);
});
