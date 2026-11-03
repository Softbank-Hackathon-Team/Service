// 검증 PA2: 동시성·경계값·화면 신호·거부 뒤 흔적 0 (spec-patch.db.test.ts 가 안 본 것)
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
const SPEC = {
  schemaVersion: "1", app: { name: "shop" },
  service: { image: `ghcr.io/demo/shop@sha256:${"a".repeat(64)}`, port: 8080, healthPath: "/healthz", replicas: 2, cpu: "250m", memory: "512Mi",
             env: [{ name: "DB_PASSWORD", value: "s3cret-value" }], secretRefs: [] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 },
  ingress: { hostname: "shop.example.com", entry: "cloudflare-lb" },
};

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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vpa2'), ($2,'test-vpa2-other')", [T, OTHER]);
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
  for (const x of versions)
    await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta) VALUES ($1,$2,$3,$4,$5)`,
      [tenant, id, x.v, x.spec, x.meta]);
  return id;
}
const review = (ks: string[]) => Object.fromEntries(ks.map((k) => [k, { source: "ai", confidence: 0.6, needs_review: true }]));
const patch = (id: string, payload: unknown, o: { tenant?: string; key?: string } = {}) => app.inject({
  method: "PATCH", url: `${P}/migrations/${id}/spec`, payload: payload as object,
  headers: { "x-dev-tenant": o.tenant ?? T, ...(o.key ? { "idempotency-key": o.key } : {}) } });
const versions = async (id: string) => (await owner.query(
  "SELECT version, spec, field_meta FROM spec_versions WHERE migration_id=$1 ORDER BY version", [id])).rows;
const audits = async (id: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND action='spec.edited'", [id])).rows;


const planPost = (id: string) => app.inject({ method: "POST", url: `${P}/migrations/${id}/plan`, payload: {}, headers: { "x-dev-tenant": T } });
const audCount = async (id: string) => (await audits(id)).length;
const events = async <R>(fn: () => Promise<R>) => {
  const l = new pg.Client({ connectionString: OWNER }); await l.connect();
  const got: string[] = [];
  l.on("notification", (m) => got.push(m.payload ?? ""));
  await l.query("LISTEN migration_events");
  try { const r = await fn(); await new Promise((res) => setTimeout(res, 250)); return { r, got: got.map((g) => JSON.parse(g)) }; }
  finally { await l.end(); }
};

test("동시성: 같은 기준 판으로 동시에 둘 → 하나만 200, 하나는 409, 판은 한 개만 늘어남", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: review(["service.port"]) }]);
  const rs = await Promise.all([
    patch(id, { baseVersion: 1, changes: [{ path: "service.port", value: 9001 }] }),
    patch(id, { baseVersion: 1, changes: [{ path: "service.port", value: 9002 }] }),
  ]);
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(rs.find((r) => r.statusCode === 409)!.json().error?.code ?? rs.find((r) => r.statusCode === 409)!.json().code, "SPEC_VERSION_CONFLICT");
  assert.equal((await versions(id)).length, 2);
  assert.equal(await audCount(id), 1);
});

test("동시성: PATCH 와 POST /plan 이 겹쳐도 한쪽만 이기고 판·상태가 어긋나지 않는다", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: review(["service.port"]) }]);
  const [p, pl] = await Promise.all([patch(id, { baseVersion: 1, confirm: ["service.port"] }), planPost(id)]);
  const st = (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status;
  const n = (await versions(id)).length;
  if (p.statusCode === 200) {            // PATCH 가 먼저 → 검토 칸 0 이 된 뒤 계획이 돌 수 있다
    assert.equal(n, 2);
    assert.ok([202, 409].includes(pl.statusCode), `plan ${pl.statusCode}`);
  } else {                                // 계획이 먼저(검토 칸이 남아 막혔거나 이미 넘어감) → PATCH 는 상태 때문에 거부
    assert.equal(p.statusCode, 409, p.body);
    assert.equal(n, 1);
  }
  if (pl.statusCode === 202) assert.notEqual(st, "spec_review");
  if (p.statusCode === 200 && pl.statusCode === 202) assert.equal(n, 2);
});

test("본문 경계: 빈 변경·알 수 없는 키·baseVersion 0/소수·25칸 이상 → 400, 판·감사 그대로", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: review(["service.port"]) }]);
  const bad: unknown[] = [
    { baseVersion: 1 }, { baseVersion: 1, changes: [], confirm: [] }, { baseVersion: 0, confirm: ["service.port"] },
    { baseVersion: 1.5, confirm: ["service.port"] }, { confirm: ["service.port"] }, { baseVersion: 1, confirm: ["service.port"], extra: 1 },
    { baseVersion: 1, changes: [{ path: "service.port", value: 1, extra: 1 }] },
    { baseVersion: 1, changes: [{ path: "__proto__.x", value: 1 }] },
    { baseVersion: 1, confirm: Array(21).fill("service.port") },
    { baseVersion: 1, acceptDraft: 0 },
  ];
  for (const b of bad) assert.equal((await patch(id, b)).statusCode, 400, JSON.stringify(b).slice(0, 80));
  assert.equal((await versions(id)).length, 1);
  assert.equal(await audCount(id), 0);
});

test("acceptDraft 경계: 없는 번호 400, 받아들인 판보다 옛 초안 409, 받아들인 판이 더 새로우면 baseVersion 은 그 판", { skip }, async () => {
  const dm = { _draft: { source: "ai:x", confidence: 0.6, needs_review: true } };
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: dm }, { v: 2, spec: SPEC, meta: {} }]);
  assert.equal((await patch(id, { baseVersion: 2, acceptDraft: 9 })).statusCode, 400);
  const stale = await patch(id, { baseVersion: 2, acceptDraft: 1 });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.match(stale.body, /SPEC_DRAFT_STALE/);
  assert.equal((await patch(id, { baseVersion: 1, acceptDraft: 1 })).statusCode, 409, "화면이 보는 판은 2");
  assert.equal((await versions(id)).length, 2);
});

test("거부 뒤 흔적 0: 모양 검사 실패(400)는 판·감사·화면 신호가 하나도 안 남는다", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: review(["service.port"]) }]);
  const { r, got } = await events(() => patch(id, { baseVersion: 1, changes: [{ path: "service.port", value: "not-a-number" }] }));
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.body, /SPEC_PATCH_INVALID/);
  assert.ok(!r.body.includes("not-a-number"), "값을 되돌려 주면 안 됨");
  assert.equal((await versions(id)).length, 1);
  assert.equal(await audCount(id), 0);
  assert.deepEqual(got.filter((g) => g.id === id), []);
});

test("화면 신호: 성공하면 {t,id,s:spec_review} 한 번, 비밀 값은 안 실린다", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: review(["service.port"]) }]);
  const { r, got } = await events(() => patch(id, { baseVersion: 1, confirm: ["service.port"] }));
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(got.filter((g) => g.id === id), [{ t: T, id, s: "spec_review" }]);
});

test("멱등·경계: 표시 없는 칸 confirm 은 200(새 판), 감사 confirmed 는 비어 있음 / 같은 칸 changes 두 번은 마지막 값", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: {} }]);
  const a = await patch(id, { baseVersion: 1, confirm: ["service.port"] });
  assert.equal(a.statusCode, 200, a.body);
  assert.deepEqual((await audits(id))[0].detail.confirmed, []);
  const b = await patch(id, { baseVersion: 2, changes: [{ path: "service.replicas", value: 3 }, { path: "service.replicas", value: 4 }] });
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(b.json().spec.service.replicas, 4);
  assert.deepEqual((await audits(id))[1].detail.changed, ["service.replicas"]);
});

test("없는 이전 → 404, 다른 단계(planning·failed·paused) → 409 INVALID_TRANSITION, 판 그대로", { skip }, async () => {
  assert.equal((await patch(randomUUID(), { baseVersion: 1, confirm: ["service.port"] })).statusCode, 404);
  for (const s of ["planning", "failed", "paused", "approved"]) {
    const id = await seed(s, [{ v: 1, spec: SPEC, meta: review(["service.port"]) }]);
    const r = await patch(id, { baseVersion: 1, confirm: ["service.port"] });
    assert.equal(r.statusCode, 409, `${s} ${r.body}`);
    assert.match(r.body, /INVALID_TRANSITION/);
    assert.equal((await versions(id)).length, 1);
  }
});

test("명세 줄이 하나도 없는 이전 → 404 (판 만들지 않음)", { skip }, async () => {
  const id = await seed("spec_review", []);
  const r = await patch(id, { baseVersion: 1, confirm: ["service.port"] });
  assert.equal(r.statusCode, 404, r.body);
  assert.equal((await versions(id)).length, 0);
});

test("거부: changes 항목에 value 가 없으면 400, 판·감사 그대로 / 명시적 null 은 모양 검사에서 400(nullable 칸 없음)", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: review(["service.port"]) }]);
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "service.port" }] });
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.body, /value/);
  assert.equal((await versions(id)).length, 1);
  assert.equal(await audCount(id), 0);
  const n = await patch(id, { baseVersion: 1, changes: [{ path: "service.port", value: null }] });
  assert.equal(n.statusCode, 400, n.body);
  assert.match(n.body, /SPEC_PATCH_INVALID/);
  assert.equal((await versions(id)).length, 1);
});

test("정상: value 가 0·빈 글자·false 같은 값이어도 '있음'으로 보고 모양 검사로 넘어간다", { skip }, async () => {
  const id = await seed("spec_review", [{ v: 1, spec: SPEC, meta: {} }]);
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "service.secretRefs", value: [] }] });
  assert.equal(r.statusCode, 200, r.body);
});
