// VI3bfix DB 시험: IMPORT_IR 값 판정이 시작 설정 검사(configProblems)와 가져오기 처리기에서 같다 + 깃발 off 그대로
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
const prev = process.env.IMPORT_IR;

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
const configRejects = (v: string | undefined) =>
  configProblems("worker", { DATABASE_URL: "postgres://u@h/db", ...(v === undefined ? {} : { IMPORT_IR: v }) })
    .some((p) => p.includes("IMPORT_IR"));

test("IMPORT_IR 값 표: 설정 검사가 막는 값 = 가져오기가 영구 실패하는 값, 통과 값은 같은 판으로", { skip }, async () => {
  const table: Array<[string | undefined, "v1" | "v2" | "reject"]> = [
    [undefined, "v1"], ["", "v1"], ["   ", "v1"], ["v1", "v1"], ["v2", "v2"], [" v2 ", "v2"], ["\tv2\n", "v2"],
    ["V2", "reject"], ["v3", "reject"], ["2", "reject"], ["true", "reject"],
  ];
  for (const [val, want] of table) {
    const label = JSON.stringify(val);
    assert.equal(configRejects(val), want === "reject", `config ${label}`);
    if (val === undefined) delete process.env.IMPORT_IR; else process.env.IMPORT_IR = val;
    const id = await seed();
    await imp.handleImport({ tenantId: T, requestId: `r-vi3bfix-${id.slice(0, 8)}`, migrationId: id });
    const r = await result(id);
    if (want === "reject") assert.deepEqual(r, { status: "failed", failure: "IMPORT_SPEC_INVALID", v2: null }, label);
    else assert.deepEqual(r, { status: "spec_review", failure: null, v2: want === "v2" }, label);
  }
});

test("모르는 값 영구 실패: 재시도 안 함(1번에 failed), 감사 detail 은 permanent·이유에 값 앞 20자만", { skip }, async () => {
  process.env.IMPORT_IR = "V2-" + "x".repeat(40);
  const id = await seed();
  await imp.handleImport({ tenantId: T, requestId: `r-vi3bfix-p-${id.slice(0, 8)}`, migrationId: id });
  const a = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed'`, [id])).rows;
  assert.equal(a.length, 1);
  assert.equal(a[0].detail.permanent, true);
  assert.equal(a[0].detail.attempts, 1);
  assert.match(a[0].detail.error, /IMPORT_IR/);
  assert.ok(!a[0].detail.error.includes("x".repeat(30)), "받은 값을 길게 남기지 않음");
});
