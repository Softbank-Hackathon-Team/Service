// DB 시험 (I8apifix): spec_v2 가 JSON 스칼라·배열이면 GET /spec 이 409 SPEC_INVALID, DB 는 0031 CHECK 로 거부
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const T = randomUUID();

let owner: pg.Client;
let app: pg.Client;
let toSpecView: typeof import("../src/routes/spec.js").toSpecView;
let DomainError: typeof import("@svc/core").DomainError;

before(async () => {
  if (skip) return;
  ({ toSpecView } = await import("../src/routes/spec.js"));
  ({ DomainError } = await import("@svc/core"));
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  app = new pg.Client({ connectionString: DB }); await app.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-i8apifix')", [T]);
});
after(async () => {
  if (skip) return;
  const core = await import("@svc/core");
  await core.pool.end(); await owner.end(); await app.end();
});

async function migration() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'gcp','gke','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`,
    [id, T, src, dst]);
  return id;
}
const insert = (c: pg.Client, id: string, v: number, specV2: string | null) => c.query(
  `INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,$3,'{}','{}',$4::jsonb)`,
  [T, id, v, specV2]);
const isCheck = (e: unknown) => (e as { code?: string; constraint?: string }).code === "23514"
  && (e as { constraint?: string }).constraint === "spec_versions_spec_v2_object";

test("0031: 스칼라·배열 spec_v2 INSERT·UPDATE 는 DB 가 거부, NULL·객체는 통과", { skip }, async () => {
  const id = await migration();
  let v = 1;
  for (const bad of ['"x"', "1", "true", "[]", "null"]) await assert.rejects(insert(owner, id, v++, bad), isCheck, bad);
  await insert(owner, id, 10, null);
  await insert(owner, id, 11, '{"spec":{}}');
  await assert.rejects(owner.query(`UPDATE spec_versions SET spec_v2 = '"x"' WHERE migration_id=$1 AND version=11`, [id]), isCheck);
  // 앱 역할(RLS 안)도 같은 CHECK
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.tenant_id', $1, true)", [T]);
  await assert.rejects(insert(app, id, 12, '"x"'), isCheck);
  await app.query("ROLLBACK");
  const c = (await owner.query(`SELECT convalidated FROM pg_constraint WHERE conname='spec_versions_spec_v2_object'`)).rows[0];
  assert.equal(c.convalidated, true, "NOT VALID 없이 기존 줄까지 검사");
});

test("toSpecView: spec_v2 가 JSON 스칼라면 409 SPEC_INVALID (CHECK 전 옛 줄 대비), NULL 도 409", { skip }, () => {
  const row = { version: 1, createdAt: "2026-11-02T00:00:00.000Z", spec: {}, fieldMeta: {}, draft: false };
  for (const s of ["x", 1, true, 0, "", false]) {
    assert.throws(() => toSpecView("m", { ...row, specV2: s }),
      (e: unknown) => e instanceof DomainError && e.status === 409 && e.code === "SPEC_INVALID", String(s));
  }
  assert.throws(() => toSpecView("m", { ...row, specV2: [] }), (e: unknown) => e instanceof DomainError && e.code === "SPEC_INVALID");
  // 명세 칸이 없는 예전 판(NULL)도 409 SPEC_INVALID (다시 가져와야 함, 가짜 기본값으로 안 채움)
  for (const s of [null, undefined])
    assert.throws(() => toSpecView("m", { ...row, specV2: s }), (e: unknown) => e instanceof DomainError && e.code === "SPEC_INVALID");
});
