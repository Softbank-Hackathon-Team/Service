// VI3bfix DB 시험: 옛 깃발 IMPORT_IR 은 없어졌다. 값이 남아 있어도 설정 검사·가져오기 둘 다 무시하고 늘 명세(spec_v2) 판을 만든다
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { configProblems } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let owner: pg.Client;
const T = randomUUID();
const prev = process.env.IMPORT_IR;   // 옛 .env 에 남은 값 흉내

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vi3bfix')", [T]);
  await core.startBoss();
});
afterEach(() => { if (prev === undefined) delete process.env.IMPORT_IR; else process.env.IMPORT_IR = prev; });
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'gcp','s','connected'), ($2,$3,'aws','d','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
const result = async (id: string) => {
  const m = (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
  const v = (await owner.query("SELECT spec_v2 IS NOT NULL AS v2 FROM spec_versions WHERE migration_id=$1", [id])).rows[0];
  return { status: m.status as string, failure: m.failure_code as string | null, v2: v ? v.v2 === true : null };
};
test("옛 IMPORT_IR 값(없음·v1·v2·모르는 값)이 남아 있어도 설정 검사는 안 막고, 가져오기는 늘 spec_v2 판으로 spec_review", { skip }, async () => {
  for (const val of [undefined, "", "v1", "v2", "V2", "v3"]) {
    const label = JSON.stringify(val);
    assert.equal(configProblems("worker", { DATABASE_URL: "postgres://u@h/db", ...(val === undefined ? {} : { IMPORT_IR: val }) })
      .some((p) => p.includes("IMPORT_IR")), false, `config ${label}`);
    if (val === undefined) delete process.env.IMPORT_IR; else process.env.IMPORT_IR = val;
    const id = await seed();
    await imp.handleImport({ tenantId: T, requestId: `r-vi3bfix-${id.slice(0, 8)}`, migrationId: id });
    assert.deepEqual(await result(id), { status: "spec_review", failure: null, v2: true }, label);
  }
});

test("거부: 명세 저장 칸은 spec_v2 하나. 옛 칸 spec 은 '{}', field_meta 는 초안 표시 자리라 가져오기 판엔 비어 있다", { skip }, async () => {
  const id = await seed();
  await imp.handleImport({ tenantId: T, requestId: `r-vi3bfix-c-${id.slice(0, 8)}`, migrationId: id });
  const v = (await owner.query("SELECT spec, field_meta FROM spec_versions WHERE migration_id=$1", [id])).rows[0];
  assert.deepEqual(v.spec, {});
  assert.deepEqual(v.field_meta, {});
});
