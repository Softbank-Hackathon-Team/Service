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
