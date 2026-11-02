// VE2EDATA2: E2EDATA2 고침 ② (PATCH 로 posture 통째 고치기) 경계 — 권한(다른 회사 404)·모양 거부·감사·판 충돌·v1 판·남은 검토 칸
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
// 가져오기 v2 판 한 줄 (import.ts importV2 와 같은 순서: normalizeV2 → checkV2 reviews → projectV1)
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
  // 앱 하나 + Memorystore(방화벽 못 읽음 = posture 에 ingress "unknown") — E2EDATA2 에서 영원히 spec_review 에 갇히던 모양
  const inv = { provider: "gcp", coverage: {}, items: [
    { kind: "k8s.deployment", imageDigest: "sha256:" + "ab".repeat(32), metadata: { name: "shop-api", namespace: "shop", labels: { app: "shop-api" } },
      spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } }, template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{
        name: "api", image: "ghcr.io/demo/shop-api:1.0", ports: [{ containerPort: 8080 }], env: [{ name: "REDIS_HOST", value: "10.0.0.3" }] }] } } } },
    { kind: "memorystore.instance", name: "projects/p/locations/asia-northeast3/instances/shop-redis", redisVersion: "REDIS_7_0", memorySizeGb: 1, tier: "BASIC",
      transitEncryptionMode: "DISABLED", authEnabled: false, host: "10.0.0.3", port: 6379 },
  ] } as never;
  const { result, projectionEnv } = adapters.normalizeV2(inv);
  const stored = contracts.ImportResultV2.parse(result);
  const v1 = adapters.projectV1(stored, projectionEnv);
  V2 = { spec: v1.spec, fieldMeta: v1.fieldMeta, specV2: stored as unknown as Record<string, any> };
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-ve2edata2'), ($2,'test-ve2edata2-other')", [T, OTHER]);
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

const audits = async (id: string) => (await owner.query("SELECT action, detail FROM audit_events WHERE target=$1 AND action='spec.edited' ORDER BY seq", [id])).rows;
const posture = () => structuredClone(V2.specV2.spec.posture) as { permissions: any[]; network: any[] };
const withKnownIngress = () => {
  const p = posture();
  p.network = p.network.map((n) => (n.scope === "component" && n.ingress === "unknown" ? { ...n, ingress: [{ from: "shop-api", port: 6379 }] } : n));
  return p;
};

test("준비 확인: 가져온 판 posture 에 방화벽 못 읽음(unknown) 칸이 있고 다른 칸은 정상", { skip }, async () => {
  const unknown = posture().network.filter((n) => n.scope === "component" && n.ingress === "unknown");
  assert.ok(unknown.length >= 1, JSON.stringify(posture().network));
});

test("정상: posture 통째 PATCH → 새 판(spec_v2.posture 바뀜), 사람 표시, 감사에 경로만(값 없음), 다른 칸은 그대로", { skip }, async () => {
  const id = await seed();
  const before = (await versions(id))[0]!;
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "posture", value: withKnownIngress() }] });
  assert.equal(r.statusCode, 200, r.body);
  const vs = await versions(id);
  assert.equal(vs.length, 2);
  const v2 = vs[1]!.spec_v2;
  assert.ok(!v2.spec.posture.network.some((n: any) => n.scope === "component" && n.ingress === "unknown"));
  assert.deepEqual(v2.spec.components, before.spec_v2.spec.components);
  assert.deepEqual(v2.spec.links, before.spec_v2.spec.links);
  assert.deepEqual(v2.fieldMeta.posture, { source: "human", confidence: 1, needs_review: false });
  const a = (await audits(id)).at(-1)!;
  assert.deepEqual(a.detail.changed, ["posture"]);
  assert.equal(a.detail.ir, "v2");
  assert.ok(!JSON.stringify(a.detail).includes("6379"), "감사에 posture 값이 들어감");
});

test("거부: 다른 회사 토큰으로는 404 (403 아님), 새 판 없음, 감사 없음", { skip }, async () => {
  const id = await seed();
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "posture", value: withKnownIngress() }] }, OTHER);
  assert.equal(r.statusCode, 404, r.body);
  assert.equal((await versions(id)).length, 1);
  assert.equal((await audits(id)).length, 0);
  assert.equal((await app.inject({ method: "GET", url: `${P}/migrations/${id}/spec`, headers: { "x-dev-tenant": OTHER } })).statusCode, 404);
});

test("거부: 모양이 틀린 posture(빠진 칸·모르는 칸·없는 컴포넌트 지목·타입 틀림·null)는 400 SPEC_PATCH_INVALID 이고 판이 안 늘어남", { skip }, async () => {
  const id = await seed();
  const good = withKnownIngress();
  const bad: Array<[string, unknown]> = [
    ["null", null], ["빈 객체", {}], ["network 없음", { permissions: [] }], ["permissions 없음", { network: [] }],
    ["모르는 칸", { ...good, extra: 1 }],
    ["network 가 배열 아님", { ...good, network: "open" }],
    ["ingress 값이 unknown 아닌 글자", { ...good, network: good.network.map((n: any) => (n.scope === "component" ? { ...n, ingress: "any" } : n)) }],
    ["permissions 가 없는 컴포넌트 지목", { ...good, permissions: [{ subject: "ghost", source: "iam:x", effect: "Allow", actions: ["s3:Get*"], resources: ["*"], mode: "mirror" }] }],
    ["없는 컴포넌트 지목", { ...good, network: [...good.network, { scope: "component", subject: "ghost", mode: "mirror", ingress: "unknown", public: null }] }],
    ["50개 초과", { ...good, network: Array.from({ length: 51 }, () => good.network[0]) }],
  ];
  for (const [name, value] of bad) {
    const r = await patch(id, { baseVersion: 1, changes: [{ path: "posture", value }] });
    assert.ok(r.statusCode === 400, `${name}: ${r.statusCode} ${r.body.slice(0, 200)}`);
    assert.equal(r.json().code ?? r.json().error?.code, "SPEC_PATCH_INVALID", name);
  }
  assert.equal((await versions(id)).length, 1);
  assert.equal((await audits(id)).length, 0);
  // 대조군: 같은 모양에서 지목만 실제 컴포넌트로 바꾸면 통과 (위 거부가 모양 때문이 아니라 '없는 컴포넌트' 때문임)
  const ok = await patch(id, { baseVersion: 1, changes: [{ path: "posture", value: { ...good, permissions: [{ subject: "shop-api", source: "iam:x", effect: "Allow", actions: ["s3:Get*"], resources: ["*"], mode: "mirror" }] } }] });
  assert.equal(ok.statusCode, 200, ok.body);
  const ok2 = await patch(id, { baseVersion: 2, changes: [{ path: "posture", value: { ...good, network: [...good.network.filter((n: any) => n.subject !== "shop-api"), { scope: "component", subject: "shop-api", mode: "mirror", ingress: "unknown", public: null }] } }] });
  assert.equal(ok2.statusCode, 200, ok2.body);   // 대조군 2: 같은 network 항목을 실제 컴포넌트 지목으로 바꾸면 통과
});

test("거부: 깊은 경로(posture.network)·모르는 경로는 400 (경로 검사), 낡은 baseVersion 은 409", { skip }, async () => {
  const id = await seed();
  for (const path of ["posture.network", "posture.permissions", "security"]) {
    const r = await patch(id, { baseVersion: 1, changes: [{ path, value: [] }] });
    assert.equal(r.statusCode, 400, `${path}: ${r.body.slice(0, 200)}`);
  }
  assert.equal((await patch(id, { baseVersion: 1, changes: [{ path: "posture", value: withKnownIngress() }] })).statusCode, 200);
  const stale = await patch(id, { baseVersion: 1, changes: [{ path: "posture", value: posture() }] });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal((await versions(id)).length, 2);
});

test("거부: v1 판(spec_v2 없음)에 posture 경로를 보내면 400 SPEC_PATH_IR_MISMATCH", { skip }, async () => {
  const id = await seed(false);
  const r = await patch(id, { baseVersion: 1, changes: [{ path: "posture", value: posture() }] });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().code ?? r.json().error?.code, "SPEC_PATH_IR_MISMATCH");
});

test("posture 와 컴포넌트 칸을 한 번에 고쳐도 한 판, 다른 검토 칸(confirm 안 한 것)은 남음, posture 를 두 번 고치면 마지막 값", { skip }, async () => {
  const id = await seed();
  const open = Object.entries((await versions(id))[0]!.spec_v2.fieldMeta as Record<string, any>).filter(([, m]) => m.needs_review).map(([k]) => k);
  const r1 = await patch(id, { baseVersion: 1, changes: [{ path: "posture", value: withKnownIngress() }, { path: "components.shop-redis.memoryMiB", value: 2048 }] });
  assert.equal(r1.statusCode, 200, r1.body);
  const v2 = (await versions(id))[1]!.spec_v2;
  assert.equal(svc(v2, "shop-redis").props.memoryMiB, 2048);
  for (const k of open.filter((k) => k !== "components.shop-redis.memoryMiB")) assert.equal(v2.fieldMeta[k].needs_review, true, `${k} 가 검토 표시 사라짐`);
  const r2 = await patch(id, { baseVersion: 2, changes: [{ path: "posture", value: posture() }] });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.ok((await versions(id))[2]!.spec_v2.spec.posture.network.some((n: any) => n.scope === "component" && n.ingress === "unknown"));
  assert.equal((await audits(id)).length, 2);
});
