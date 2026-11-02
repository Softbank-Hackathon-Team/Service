// 검증 묶음 VI3fix: I3fix(replicas 0 · 자격 든 연결 URL) 실제 DB 가져오기. 처리기를 직접 부른다. MOCK_SEED=1 데모 원본
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vi3fix')", [T]);
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
const job = (id: string) => ({ tenantId: T, requestId: `r-i3fix-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0] as { status: string; failure_code: string | null };
const ver = async (id: string) => (await owner.query("SELECT spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1", [id])).rows as Array<{ spec: any; field_meta: Record<string, { needs_review: boolean }>; spec_v2: any }>;
const reviewKeys = (m: Record<string, { needs_review: boolean }>) => Object.keys(m).filter((k) => m[k]!.needs_review).sort();


// DEMO_INVENTORY_V2.onprem 항목을 시험 동안만 바꾼다
function withItems(extra: Array<Record<string, unknown>>, replicas?: number) {
  const src = adapters.DEMO_INVENTORY_V2.onprem!;
  const orig = src.items;
  const worker = (orig as Array<any>).find((i) => i.kind === "k8s.deployment" && i.metadata.name === "shop-worker");
  const patched = JSON.parse(JSON.stringify(worker));
  patched.spec.template.spec.containers[0].env.push(...extra);
  if (replicas !== undefined) patched.spec.replicas = replicas;
  src.items = (orig as Array<any>).map((i) => (i === worker ? patched : i));
  return () => { src.items = orig; };
}
const audits = async (id: string) => (await owner.query("SELECT action, detail::text AS d FROM audit_events WHERE target=$1 ORDER BY seq", [id])).rows as Array<{ action: string; d: string }>;


test("실제 DB 가져오기: replicas 0 + 자격 든 URL → 막지 않고 spec_review, 의존성 0.9·검토 표시, 비밀번호는 DB 어디에도 없음", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const PW = "vi3fixPW8842zz";
  const restore = withItems([{ name: "DATABASE_URL", value: `postgres://admin:${PW}@shop-db-rw.shop.svc:5432/app` }], 0);
  const id = await seed("onprem");
  try { await imp.handleImport(job(id)); } finally { restore(); }
  assert.equal((await row(id)).status, "spec_review");
  const [v] = await ver(id);
  const w = v!.spec_v2.spec.components.find((c: any) => c.id === "shop-worker");
  assert.deepEqual(w.props.replicas, { min: 0, max: 0 });
  assert.ok(!w.props.env.some((e: any) => e.name === "DATABASE_URL"), "비밀로 뺀 env 가 남음");
  const link = v!.spec_v2.spec.links.find((l: any) => l.from === "shop-worker" && l.to === "shop-db");
  assert.ok(link, `의존성 없음: ${JSON.stringify(v!.spec_v2.spec.links)}`);
  // 데모 shop-worker 는 다른 근거로 이미 shop-db 와 신뢰도 1 연결이 있을 수 있다 → 0.9 이상이면 됨 (자격 URL 이 근거를 깎지 않음)
  assert.ok(v!.spec_v2.fieldMeta["links.shop-worker->shop-db"].confidence >= 0.9);
  const reviews = Object.keys(v!.spec_v2.fieldMeta).filter((k) => k.startsWith("check.reviews["));
  assert.ok(reviews.length >= 1, "replicas 0 검토 표시 없음");
  // 비밀번호는 spec·spec_v2·field_meta·감사 어디에도 없음 (v1 투영 service 는 데모의 주 서비스라 worker 와 다름)
  const all = JSON.stringify([v!.spec, v!.spec_v2, v!.field_meta]) + (await audits(id)).map((a) => a.d).join("\n");
  assert.ok(!all.includes(PW), "비밀번호가 남음");
});

test("깃발 off(기본)이면 spec_v2 NULL, 비밀번호는 여전히 안 남는다", { skip }, async () => {
  delete process.env.IMPORT_IR;
  const PW = "vi3fixPW0001qq";
  const restore = withItems([{ name: "DATABASE_URL", value: `postgres://admin:${PW}@shop-db-rw.shop.svc:5432/app` }], 0);
  const id = await seed("onprem");
  try { await imp.handleImport(job(id)); } finally { restore(); }
  const [v] = await ver(id);
  assert.equal(v!.spec_v2, null);
  assert.ok(!JSON.stringify([v!.spec, v!.field_meta]).includes(PW));
});
