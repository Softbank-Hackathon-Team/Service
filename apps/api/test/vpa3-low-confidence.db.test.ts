// 검증 VPA3: 신뢰도 문턱값(SPEC_MIN_CONFIDENCE) 경계값·옛 판·초안 판 + 명세 PATCH(confirm/changes)와 POST /plan 연동
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
const prev = process.env.SPEC_MIN_CONFIDENCE;
// 명세 한 벌 (spec_v2 칸): 서비스 shop + postgres db
const SPEC = {"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["s.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}};

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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vpa3'), ($2,'test-vpa3-other')", [T, OTHER]);
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

async function seed(versions: { v: number; meta: Record<string, unknown>; spec?: unknown }[], tenant = T) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','k3s','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, tenant]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`,
    [id, tenant, src, dst]);
  // 칸 표시는 spec_v2.fieldMeta, AI 초안 표시(_draft)만 옛 칸 field_meta
  for (const x of versions) {
    const { _draft, ...meta } = x.meta;
    await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,$3,'{}',$4,$5)`,
      [tenant, id, x.v, JSON.stringify(_draft ? { _draft } : {}), JSON.stringify({ spec: x.spec ?? SPEC, fieldMeta: meta, unmapped: [], ids: {} })]);
  }
  return id;
}
const plan = (id: string, tenant = T) => app.inject({ method: "POST", url: `${P}/migrations/${id}/plan`, payload: {}, headers: { "x-dev-tenant": tenant } });
const patch = (id: string, payload: object) => app.inject({ method: "PATCH", url: `${P}/migrations/${id}/spec`, payload, headers: { "x-dev-tenant": T } });
const flag = (v: string | undefined) => { if (v === undefined) delete process.env.SPEC_MIN_CONFIDENCE; else process.env.SPEC_MIN_CONFIDENCE = v; };
const e = (confidence: unknown, needs_review?: boolean) => ({ source: "x", confidence, ...(needs_review === undefined ? {} : { needs_review }) });
const blocked = async (id: string) => {
  const r = await plan(id);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "GUARD_FAILED");
  assert.match(r.json().message, /below min confidence/);
};

test("경계값: confidence == 문턱값이면 통과(미만만 막음)", { skip }, async () => {
  flag("0.6");
  const id = await seed([{ v: 1, meta: { a: e(0.6) } }]);
  assert.equal((await plan(id)).statusCode, 202);
});

test("문턱값 1: 0.9 미처리 칸(needs_review 없음) → 409, 정수 1 은 통과", { skip }, async () => {
  flag("1");
  await blocked(await seed([{ v: 1, meta: { a: e(0.9) } }]));
  assert.equal((await plan(await seed([{ v: 1, meta: { a: e(1) } }]))).statusCode, 202);
});

test("옛 판: confidence 가 숫자 아닌 글자·없음·null 이면 가장 낮은 쪽 → 막음", { skip }, async () => {
  flag("0.5");
  for (const c of ["high", null, undefined, "0.6abc"])
    await blocked(await seed([{ v: 1, meta: { a: c === undefined ? { source: "x" } : e(c) } }]));
});

test("깃발 값이 틀리면(글자·범위 밖) 꺼짐 = 지금 동작", { skip }, async () => {
  for (const v of ["abc", "7", "-1", "0"]) {
    flag(v);
    assert.equal((await plan(await seed([{ v: 1, meta: { a: e(0.1) } }]))).statusCode, 202, `SPEC_MIN_CONFIDENCE=${v}`);
  }
});

test("AI 초안 판(_draft)은 세지 않는다: 받아들인 판이 깨끗하면 통과", { skip }, async () => {
  flag("0.7");
  const id = await seed([{ v: 1, meta: { a: e(1, false) } },
                         { v: 2, meta: { a: e(0.6), _draft: { source: "ai:x", confidence: 0.6, needs_review: true } } }]);
  assert.equal((await plan(id)).statusCode, 202);
});

test("연동: 문턱값 0.7 + 가져오기 모양(프로브 기본값·평문 비밀 env 칸) → 409, PATCH confirm 두 칸 → POST /plan 202", { skip }, async () => {
  flag("0.7");
  const meta = { "components.shop.probes": { source: "default", confidence: 0.6, needs_review: true },
                 "components.shop.env.DB_PASSWORD": { source: "source.env", confidence: 0.6, needs_review: true, rationale: "평문 비밀" } };
  const id = await seed([{ v: 1, meta }]);
  assert.equal((await plan(id)).statusCode, 409);
  const r = await patch(id, { baseVersion: 1, confirm: ["components.shop.probes", "components.shop.env.DB_PASSWORD"] });
  assert.equal(r.statusCode, 200, r.body);   
  assert.deepEqual(r.json().needsReview, []);
  const ok = await plan(id);
  assert.equal(ok.statusCode, 202, ok.body);
});

test("연동: changes 로 components.<id>.env 를 다시 쓰면 그 아래 env 칸 표시도 처리됨 → 202", { skip }, async () => {
  flag("0.7");
  const id = await seed([{ v: 1, meta: { "components.shop.env.API_TOKEN": { source: "source.env", confidence: 0.6, needs_review: true } } }]);
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "components.shop.env", value: [] }] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().needsReview, []);
  assert.equal((await plan(id)).statusCode, 202);
});

test("거부: confirm 칸 이름 모양이 틀리면 400 (service.env.<이름> 만 추가로 받음)", { skip }, async () => {
  const id = await seed([{ v: 1, meta: {} }]);
  for (const p of ["service.env.", "service.env.1BAD", "service.env.A.B", "service.secretRefs.X"])
    assert.equal((await patch(id, { baseVersion: 1, confirm: [p] })).statusCode, 400, p);
});

test("거부: 남의 회사 이전 → POST /plan 404", { skip }, async () => {
  flag("0.7");
  const id = await seed([{ v: 1, meta: { a: e(0.1) } }]);
  assert.equal((await plan(id, OTHER)).statusCode, 404);
});

// 설계 관찰(고치지 않음): "처리됨 = needs_review false" 라서 가져오기가 needs_review:false 로 낸 0.9 칸은 문턱값 0.95 에서도 통과한다
test("관찰: 가져오기가 검토 불필요로 낸 칸은 문턱값보다 낮아도 처리된 것으로 본다 (H-2 미결)", { skip }, async () => {
  flag("0.95");
  assert.equal((await plan(await seed([{ v: 1, meta: { a: e(0.9, false) } }]))).statusCode, 202);
});
