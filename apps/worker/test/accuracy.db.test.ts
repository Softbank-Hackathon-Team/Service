// ACCURACY DB 시험: 가져오기 결과(감사 detail)에 정확도 숫자가 붙는다. 실클라우드 호출 0 (MOCK 출발 = 데모 원본)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ImportAccuracy } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID();
const saved = { IMPORT_IR: process.env.IMPORT_IR };

before(async () => {
  if (skip) return;
  process.env.IMPORT_IR = "v2";
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-acc'), ($2,'test-acc-other')", [T, OTHER]);
});
after(async () => {
  if (skip) return;
  if (saved.IMPORT_IR === undefined) delete process.env.IMPORT_IR; else process.env.IMPORT_IR = saved.IMPORT_IR;
  await core.pool.end(); await owner.end();
});

async function seed(tenant: string, srcP: string, dstP: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,$4,'s','connected'), ($2,$3,$5,'d','connected')`, [src, dst, tenant, srcP, dstP]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, tenant, src, dst]);
  return id;
}
const job = (tenant: string, id: string) => ({ tenantId: tenant, requestId: `r-acc-${id.slice(0, 8)}`, migrationId: id });
const detail = async (id: string) => (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review'", [id])).rows[0]?.detail;

test("정상: 가져오기 끝나면 감사 detail.accuracy 에 계약 모양 숫자가 붙는다 (출발 gcp → 도착 aws, 렌더 기준)", { skip }, async () => {
  const id = await seed(T, "gcp", "aws");
  await imp.handleImport(job(T, id));
  const d = await detail(id);
  assert.equal(d.ir, "v2");
  const a = ImportAccuracy.parse(d.accuracy);
  assert.equal(a.basis, "render");
  assert.equal(a.percent, 100); assert.ok(a.comparable > 0);
});

test("도착 종류가 달라도 숫자가 붙는다 (도착 onprem)", { skip }, async () => {
  const id = await seed(T, "gcp", "onprem");
  await imp.handleImport(job(T, id));
  assert.equal(ImportAccuracy.parse((await detail(id)).accuracy).percent, 100);
});

test("거부: v1 길(깃발 끔)이면 accuracy 칸이 없다 (기존 감사 모양 그대로)", { skip }, async () => {
  delete process.env.IMPORT_IR;
  try {
    const id = await seed(T, "gcp", "aws");
    await imp.handleImport(job(T, id));
    const d = await detail(id);
    assert.ok(d && !("accuracy" in d));
  } finally { process.env.IMPORT_IR = "v2"; }
});

test("다른 회사: 남의 회사 이전의 감사는 내 회사 문맥에서 안 보인다 (RLS)", { skip }, async () => {
  const id = await seed(T, "gcp", "aws");
  await imp.handleImport(job(T, id));
  const seen = await core.withTenant(OTHER, async (tx) => (await tx.query("SELECT 1 FROM audit_events WHERE target=$1", [id])).rows.length);
  assert.equal(seen, 0);
});
