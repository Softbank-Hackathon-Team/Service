// VBOUNDARY DB 시험: 가져오기 처리기가 앱 경계(BOUNDARY)·앱 묶음(PARTOF) 결과를 spec_v2 에 저장하는지. 처리기를 직접 부른다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let adapters: typeof import("@svc/adapters");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  adapters = await import("@svc/adapters");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vboundary')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  delete process.env.IMPORT_IR;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(provider: "aws" | "gcp" | "onprem") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,$4,'s','connected'), ($2,$3,'aws','d','connected')`, [src, dst, T, provider]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-vbound-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0] as { status: string; failure_code: string | null };
const ver = async (id: string) => (await owner.query("SELECT spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1", [id])).rows as Array<{ spec: any; field_meta: Record<string, { needs_review: boolean }>; spec_v2: any }>;
const reviewKeys = (m: Record<string, { needs_review: boolean }>) => Object.keys(m).filter((k) => m[k]!.needs_review).sort();


const ver2 = async (id: string) => (await owner.query("SELECT version, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version", [id])).rows as Array<{ version: number; spec_v2: any }>;

/** 데모 onprem 원본: 기존 Deployment 전부 part-of=shop + 다른 앱 blog-api(part-of=blog) 하나 */
function withBlog(): () => void {
  const src = adapters.DEMO_INVENTORY_V2.onprem!;
  const orig = src.items;
  const items = structuredClone(orig) as any[];
  for (const it of items) if (it.kind === "k8s.deployment" || it.kind === "k8s.cronjob") it.metadata.labels = { ...(it.metadata.labels ?? {}), "app.kubernetes.io/part-of": "shop" };
  const tpl = items.find((it) => it.kind === "k8s.deployment" && it.metadata.name === "shop-web");
  const blog = structuredClone(tpl); blog.metadata.name = "blog-api"; blog.metadata.labels = { app: "blog-api", "app.kubernetes.io/part-of": "blog" };
  blog.spec.selector = { matchLabels: { app: "blog-api" } }; blog.spec.template.metadata.labels = { app: "blog-api" };
  blog.spec.template.spec.containers[0].name = "blog-api";
  items.push(blog);
  src.items = items;
  return () => { src.items = orig; };
}

test("정상: 두 앱이 섞인 원본 → spec_v2 에 shop 만, outOfBoundary 에 blog-api(이름·종류만), ids 표엔 blog-api 가 그대로 남는다", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore = withBlog();
  const id = await seed("onprem");
  try { await imp.handleImport(job(id)); } finally { restore(); }
  assert.equal((await row(id)).status, "spec_review");
  const [v] = await ver2(id);
  const comps = v!.spec_v2.spec.components.map((c: { id: string }) => c.id);
  assert.ok(!comps.includes("blog-api"), JSON.stringify(comps));
  assert.ok(comps.includes("shop-api"));
  assert.deepEqual(v!.spec_v2.outOfBoundary.map((o: { resource: string }) => o.resource), ["k8s.deployment:blog-api"]);
  assert.equal(v!.spec_v2.outOfBoundary[0].kind, "service");
  assert.ok(Object.values(v!.spec_v2.ids).includes("blog-api"), "ids 표는 경계 밖 자원 id 도 기억한다");
  assert.ok(!JSON.stringify(v!.spec_v2.fieldMeta).includes("blog-api"), "fieldMeta 에 경계 밖 앱 흔적 없음");
});

test("재가져오기 멱등: 같은 원본을 다시 가져오면 판 2 의 outOfBoundary·구성요소가 판 1 과 같다", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore = withBlog();
  const id = await seed("onprem");
  try {
    await imp.handleImport(job(id));
    await owner.query("UPDATE migrations SET status='importing' WHERE id=$1", [id]);
    await imp.handleImport(job(id));
  } finally { restore(); }
  const [a, b] = await ver2(id);
  assert.equal(b!.version, 2);
  assert.deepEqual(b!.spec_v2.outOfBoundary, a!.spec_v2.outOfBoundary);
  assert.deepEqual(b!.spec_v2.spec.components, a!.spec_v2.spec.components);
});

test("경계 없는 원본(라벨 없는 데모)은 outOfBoundary 가 비어 있고 구성요소가 옛 시험과 같다 (IMPORT_IR=v2)", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const id = await seed("onprem");
  await imp.handleImport(job(id));
  const [v] = await ver2(id);
  assert.deepEqual(v!.spec_v2.outOfBoundary ?? [], []);
  assert.deepEqual(v!.spec_v2.spec.components.map((c: { id: string }) => c.id), ["shop-api", "shop-cleanup", "shop-db", "shop-web", "shop-worker"]);
});

test("남의 회사: 다른 회사로 부른 작업은 경계를 계산해도 아무것도 저장하지 않는다", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore = withBlog();
  const id = await seed("onprem");
  try { await imp.handleImport({ ...job(id), tenantId: randomUUID() }); } catch { /* 회사 벽에서 거부돼도 됨 */ } finally { restore(); }
  assert.equal((await ver2(id)).length, 0);
  assert.equal((await row(id)).status, "importing");
});

// ---- BOUNDPULL: 사람이 끌어온 자원은 재가져오기 뒤에도 경계 안 ----
function withOrphanBucket(drop = false): () => void {
  const src = adapters.DEMO_INVENTORY_V2.onprem!;
  const orig = src.items;
  src.items = drop ? orig : [...orig, { kind: "s3.bucket", Name: "orphan-bucket", Arn: "arn:aws:s3:::orphan-bucket" } as never];
  return () => { src.items = orig; };
}
async function pullAsPatchDoes(id: string, name: string) {
  const { applyInclude } = adapters;
  const [v] = await ver2(id);
  const inc = applyInclude(v!.spec_v2, [name]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
    SELECT tenant_id, migration_id, 2, spec, field_meta, $2::jsonb FROM spec_versions WHERE migration_id=$1 AND version=1`, [id, JSON.stringify(inc.result)]);
}
const reimport = async (id: string) => { await owner.query("UPDATE migrations SET status='importing' WHERE id=$1", [id]); await imp.handleImport(job(id)); };

test("BOUNDPULL: 끌어온 버킷은 재가져오기(판 3)에도 구성요소로 남고 경계 밖 목록에 다시 안 나온다, 사람이 안 끌어온 건 계속 밖", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore = withOrphanBucket();
  const id = await seed("onprem");
  try {
    await imp.handleImport(job(id));
    const [v1] = await ver2(id);
    assert.ok(v1!.spec_v2.outOfBoundary.some((o: { resource: string }) => o.resource === "s3.bucket:orphan-bucket"));
    assert.ok("s3.bucket:orphan-bucket" in v1!.spec_v2.boundaryPool);
    await pullAsPatchDoes(id, "s3.bucket:orphan-bucket");
    await reimport(id);
  } finally { restore(); }
  const v = await ver2(id);
  assert.equal(v.length, 3);
  const last = v[2]!.spec_v2;
  assert.ok(last.spec.components.some((c: { id: string }) => c.id === "orphan-bucket"));
  assert.ok(!last.outOfBoundary.some((o: { resource: string }) => o.resource === "s3.bucket:orphan-bucket"));
  assert.deepEqual(last.included, ["s3.bucket:orphan-bucket"]);
  assert.equal(last.fieldMeta["components.orphan-bucket.boundary"].source, "human");
  assert.equal(last.fieldMeta["components.orphan-bucket.boundary"].needs_review, true);
  assert.equal(v[2]!.spec_v2.ids && Object.values(last.ids).includes("orphan-bucket"), true);
});

test("BOUNDPULL 제어 사례: 끌어오지 않았으면 재가져오기 뒤에도 경계 밖 (같은 원본)", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore = withOrphanBucket();
  const id = await seed("onprem");
  try { await imp.handleImport(job(id)); await reimport(id); } finally { restore(); }
  const v = await ver2(id);
  const last = v[v.length - 1]!.spec_v2;
  assert.ok(!last.spec.components.some((c: { id: string }) => c.id === "orphan-bucket"));
  assert.ok(last.outOfBoundary.some((o: { resource: string }) => o.resource === "s3.bucket:orphan-bucket"));
  assert.equal(last.included, undefined);
});

test("BOUNDPULL: 끌어온 자원이 원본에서 사라지면 재가져오기는 에러 없이 그 자원만 빠진다 (included 도 비움)", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore1 = withOrphanBucket();
  const id = await seed("onprem");
  try { await imp.handleImport(job(id)); await pullAsPatchDoes(id, "s3.bucket:orphan-bucket"); } finally { restore1(); }
  await reimport(id);   // 원본에 버킷이 없음
  assert.equal((await row(id)).status, "spec_review");
  const last = (await ver2(id)).at(-1)!.spec_v2;
  assert.ok(!last.spec.components.some((c: { id: string }) => c.id === "orphan-bucket"));
  assert.equal(last.included, undefined);
});
