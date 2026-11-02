// DB 시험 (I8apifix2): 이미 돌던 DB 에 스칼라·배열 spec_v2 줄이 있어도 0031 이 성공한다
//   그 줄의 spec_v2 만 NULL (v1 spec 그대로) + 회사 감사 사슬에 spec.v2_cleared 한 줄 (writeAudit 와 같은 해시) → 그다음 CHECK
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const SQL = readFileSync(new URL("../../../db/migrations/0031_spec_v2_object_check.sql", import.meta.url), "utf8");
const A = randomUUID(), B = randomUUID();

let core: typeof import("@svc/core");
let owner: pg.Client;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-i8apifix2-a'), ($2,'test-i8apifix2-b')", [A, B]);
});
after(async () => {
  if (skip) return;
  await core.pool.end(); await owner.end();
});

async function migration(t: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'gcp','gke','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, t]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'spec_review')`,
    [id, t, src, dst]);
  return id;
}
const put = (t: string, id: string, v: number, specV2: string | null) => owner.query(
  `INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,$3,$4,'{}',$5::jsonb)`,
  [t, id, v, { service: { name: `s${v}` } }, specV2]);
const rows = async (id: string) => (await owner.query(
  "SELECT version, spec, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version", [id])).rows;
const audits = async (t: string) => (await owner.query(
  "SELECT seq, tenant_id, actor, action, target, result, detail, prev_hash, hash FROM audit_events WHERE tenant_id=$1 ORDER BY seq", [t])).rows;

test("옛 DB 의 스칼라·배열·JSON null spec_v2 → NULL + 감사 한 줄씩, 객체·NULL 줄은 그대로, 그다음 CHECK 가 켜진다", { skip }, async () => {
  // 시험 DB 는 0031 이 이미 들어간 틀에서 복사됨 → 0031 전 상태로 되돌리고 깨진 줄을 넣는다
  await owner.query("ALTER TABLE spec_versions DROP CONSTRAINT spec_versions_spec_v2_object");
  const a = await migration(A), b = await migration(B);
  await put(A, a, 1, '{"spec":{},"fieldMeta":{}}');
  await put(A, a, 2, '"x"');
  await put(A, a, 3, "[]");
  await put(A, a, 4, null);
  await put(B, b, 1, "true");
  await put(B, b, 2, "null");
  // 회사 A 는 감사 사슬이 이미 있음 → 새 줄이 그 끝에 이어져야 한다. B 는 genesis 부터
  await core.withTenant(A, (tx) => core.writeAudit(tx, A, { actor: "test", action: "before", target: a, result: "ok" }));
  const beforeA = await audits(A);

  await owner.query(SQL);

  const ra = await rows(a), rb = await rows(b);
  assert.deepEqual(ra.map((r) => r.spec_v2), [{ spec: {}, fieldMeta: {} }, null, null, null]);
  assert.deepEqual(rb.map((r) => r.spec_v2), [null, null]);
  assert.deepEqual([...ra, ...rb].map((r) => r.spec.service.name), ["s1", "s2", "s3", "s4", "s1", "s2"], "v1 spec 은 그대로");

  const aa = (await audits(A)).slice(beforeA.length), ab = await audits(B);
  assert.deepEqual(aa.map((x) => [x.action, x.actor, x.target, x.detail.version, x.detail.jsonType]),
    [["spec.v2_cleared", "system", a, 2, "string"], ["spec.v2_cleared", "system", a, 3, "array"]]);
  assert.deepEqual(ab.map((x) => [x.detail.version, x.detail.jsonType]), [[1, "boolean"], [2, "null"]]);
  // 해시 = core writeAudit 와 같은 계산 (사슬 검사가 깨지지 않음)
  let prev = beforeA[beforeA.length - 1].hash;
  for (const x of aa) {
    assert.equal(x.prev_hash, prev);
    const body = { actor: x.actor, action: x.action, target: x.target, result: x.result, detail: x.detail, tenantId: A, prevHash: prev };
    assert.equal(x.hash, core.sha256(core.canonical(body)), "해시가 writeAudit 계산과 다름");
    prev = x.hash;
  }
  assert.equal(ab[0].prev_hash, "genesis");
  assert.equal(ab[1].prev_hash, ab[0].hash);
  // 다음 앱 감사 줄도 이어진다
  await core.withTenant(A, (tx) => core.writeAudit(tx, A, { actor: "test", action: "after", target: a, result: "ok" }));
  const last = (await audits(A)).at(-1)!;
  assert.equal(last.prev_hash, prev);

  const c = (await owner.query("SELECT convalidated FROM pg_constraint WHERE conname='spec_versions_spec_v2_object'")).rows[0];
  assert.equal(c.convalidated, true);
  await assert.rejects(put(A, a, 9, '"y"'), (e: { code?: string }) => e.code === "23514");
  assert.equal((await owner.query("SELECT current_setting('app.tenant_id', true) AS v")).rows[0].v ?? "", "", "회사 값이 세션에 안 남음");
});

test("깨진 줄이 없는 DB → spec_v2·감사 아무것도 안 바뀌고 CHECK 만 켜진다", { skip }, async () => {
  await owner.query("ALTER TABLE spec_versions DROP CONSTRAINT spec_versions_spec_v2_object");
  const a = await migration(A);
  await put(A, a, 1, '{"spec":{}}');
  const n = (await owner.query("SELECT count(*)::int n FROM audit_events")).rows[0].n;
  await owner.query(SQL);
  assert.deepEqual((await rows(a))[0].spec_v2, { spec: {} });
  assert.equal((await owner.query("SELECT count(*)::int n FROM audit_events")).rows[0].n, n);
  assert.ok((await owner.query("SELECT 1 FROM pg_constraint WHERE conname='spec_versions_spec_v2_object'")).rowCount);
});
