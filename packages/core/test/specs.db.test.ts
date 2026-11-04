// Z75-03: latestAcceptedSpecV2 — 받아들인(초안 아닌) 최신 판만 고른다. DB 가 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL;
const OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

type Core = typeof import("../src/index.js");
let core: Core;
let owner: pg.Client;
const T = randomUUID(), T2 = randomUUID(), S = randomUUID(), G = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z75-spec'), ($2, 'test-z75-spec-2')", [T, T2]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
});
after(async () => {
  if (skip) return;
  await core.pool.end();
  await owner.end();
});

async function newMigration() {
  return core.withTenant(T, async (tx) => (await tx.query(
    "INSERT INTO migrations (tenant_id, source_env_id, target_env_id) VALUES ($1,$2,$3) RETURNING id", [T, S, G])).rows[0].id as string);
}
// 명세는 spec_v2 칸에 (예전 칸 spec 은 '{}', field_meta 는 초안 표시 자리)
async function putVersion(m: string, v: number, spec: object, meta: object) {
  await core.withTenant(T, (tx) => tx.query(
    "INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,$3,'{}',$4,$5)",
    [T, m, v, meta, { spec, fieldMeta: {}, unmapped: [], ids: {} }]));
}
const latest = async (t: string, m: string) => (await core.withTenant(t, (tx) => core.latestAcceptedSpecV2(tx, m)))?.specV2 ?? null;

test("Z75-03: 판이 없으면 null", { skip }, async () => {
  const m = await newMigration();
  assert.equal(await latest(T, m), null);
});

test("Z75-03: 초안(_draft) 판은 건너뛰고 받아들인 최신 판을 준다", { skip }, async () => {
  const m = await newMigration();
  await putVersion(m, 1, { v: 1 }, {});
  await putVersion(m, 2, { v: 2 }, { name: { needs_review: true } });
  await putVersion(m, 3, { v: 3 }, { [core.SPEC_DRAFT_KEY]: true });
  assert.deepEqual(await latest(T, m), { v: 2 });
});

test("Z75-03: 초안만 있으면 null", { skip }, async () => {
  const m = await newMigration();
  await putVersion(m, 1, { v: 1 }, { [core.SPEC_DRAFT_KEY]: true });
  assert.equal(await latest(T, m), null);
});

test("Z75-03: 다른 회사로는 안 보인다 (회사 벽)", { skip }, async () => {
  const m = await newMigration();
  await putVersion(m, 1, { v: 1 }, {});
  assert.equal(await latest(T2, m), null);
});
