// DB 시험(I3b): 가져오기에 공통 명세 v2 연결 (IMPORT_IR 깃발 뒤). 처리기를 직접 부른다. MOCK_SEED=1 데모 원본
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-i3b')", [T]);
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
const job = (id: string) => ({ tenantId: T, requestId: `r-i3b-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0] as { status: string; failure_code: string | null };
const ver = async (id: string) => (await owner.query("SELECT spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1", [id])).rows as Array<{ spec: any; field_meta: Record<string, { needs_review: boolean }>; spec_v2: any }>;
const reviewKeys = (m: Record<string, { needs_review: boolean }>) => Object.keys(m).filter((k) => m[k]!.needs_review).sort();

test("정상: 출발 gcp + IMPORT_IR=v2 → spec(v1)·spec_v2 둘 다 저장, spec_review", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const id = await seed("gcp");
  await imp.handleImport(job(id));
  assert.equal((await row(id)).status, "spec_review");
  const [v] = await ver(id);
  assert.ok(v, "spec_versions 한 줄");
  assert.equal(v!.spec.schemaVersion, "1");
  assert.equal(v!.spec.app.name, "shop-api");
  assert.equal(v!.spec_v2.spec.schemaVersion, "2");
  assert.deepEqual(v!.spec_v2.spec.components.map((c: { id: string }) => c.id), ["shop-api", "shop-cleanup", "shop-db", "shop-web", "shop-worker"]);
  assert.ok(!JSON.stringify(v!.spec_v2).includes("10.20.0.5\""), "출발 주소 값은 spec_v2 에 없음 (fromLink)");
  // v1 field_meta 검토 수 = 같은 원본을 v1 경로로 읽었을 때와 같다 (golden R14 와 같은 규칙). 데모 v2 원본은 300m·768Mi → 단계 올림 2개
  assert.deepEqual(reviewKeys(v!.field_meta), ["service.cpu", "service.memory"]);
});

test("되돌아감: 출발 aws(ECS 데모 원본) + IMPORT_IR=v2 → v1 경로, spec_v2 NULL", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  // I9: aws v2 데모가 ECS 3티어가 됐다 → 워크로드 없는 원본(DB 만)일 때 되돌아가는지로 본다
  const src = adapters.DEMO_INVENTORY_V2.aws!;
  const orig = src.items;
  src.items = orig.filter((i) => (i as { kind: string }).kind !== "ecs.service");
  const id = await seed("aws");
  try { await imp.handleImport(job(id)); } finally { src.items = orig; }
  assert.equal((await row(id)).status, "spec_review");
  const [v] = await ver(id);
  assert.equal(v!.spec_v2, null);
  assert.equal(v!.spec.schemaVersion, "1");
  const a = await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review'", [id]);
  assert.equal(a.rows[0]?.detail?.ir, "v1-fallback");
});

test("깃발 off: 지금 동작 그대로 (spec_v2 NULL, 감사 detail 에 ir 없음)", { skip }, async () => {
  delete process.env.IMPORT_IR;
  const id = await seed("onprem");
  await imp.handleImport(job(id));
  assert.equal((await row(id)).status, "spec_review");
  const [v] = await ver(id);
  assert.equal(v!.spec_v2, null);
  const a = await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review'", [id]);
  assert.equal(a.rows[0]?.detail?.ir, undefined);
});

test("거부: checkV2 구조 오류 원본 → 재시도 없이 바로 failed(IMPORT_SPEC_INVALID)", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const src = adapters.DEMO_INVENTORY_V2.onprem!;
  const orig = src.items;
  // digest 없는 CronJob → checkV2 "digest 아님" (구조 오류)
  src.items = [...orig, { kind: "k8s.cronjob", imageDigest: null, metadata: { name: "broken", namespace: "shop" },
    spec: { schedule: "0 1 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name: "b", image: "ghcr.io/demo/b:1" }] } } } } } }];
  const id = await seed("onprem");
  try { await imp.handleImport(job(id)); } finally { src.items = orig; }
  const r = await row(id);
  assert.equal(r.status, "failed");
  assert.equal(r.failure_code, "IMPORT_SPEC_INVALID");
  assert.equal((await ver(id)).length, 0, "명세 판 저장 안 함");
  const a = await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed'", [id]);
  assert.equal(a.rows[0]?.detail?.permanent, true);
  assert.equal(a.rows[0]?.detail?.attempts, 1);
  assert.match(String(a.rows[0]?.detail?.error), /digest 아님/);
});

test("남의 회사: 다른 회사로 부른 작업은 아무것도 안 바꾼다 (회사 벽)", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const id = await seed("gcp");
  const other = randomUUID();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-i3b-other')", [other]);
  await imp.handleImport({ ...job(id), tenantId: other });
  assert.equal((await row(id)).status, "importing");
  assert.equal((await ver(id)).length, 0);
});
