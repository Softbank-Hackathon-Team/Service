// DB 시험(TA3): 계획이 쓸 v2 명세를 같은 판에서 고른다 (spec_v2 / upconvert / NEEDS_HUMAN). 가져오기 처리기로 판을 만든다
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
const T = randomUUID(), OTHER = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  adapters = await import("@svc/adapters");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-ta3'), ($2, 'test-ta3-other')", [T, OTHER]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  delete process.env.IMPORT_IR;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function imported(provider: "aws" | "gcp") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,$4,'s','connected'), ($2,$3,'gcp','d','connected')`, [src, dst, T, provider]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  process.env.IMPORT_IR = "v2";
  await imp.handleImport({ tenantId: T, requestId: `r-ta3-${id.slice(0, 8)}`, migrationId: id });
  return id;
}
const pick = (tenant: string, id: string) => core.withTenant(tenant, (tx) => core.latestAcceptedSpecV2(tx, id));

test("정상: v2 가져오기 판 → spec_v2, v1 되돌아감 판 → upconvert", { skip }, async () => {
  const g = await pick(T, await imported("gcp"));
  const rg = adapters.resolveSpecV2(g!);
  assert.equal(rg.ok && rg.source, "spec_v2");
  assert.equal(rg.ok && rg.spec.components.some((c) => c.kind === "postgres"), true);
  assert.equal(adapters.v2PrecheckItems("gcp", g!)[0]!.id, "PC-V2-SOURCE");
  // I9: aws 데모가 ECS v2 가 됐다 → 워크로드 없는 원본(DB 만)으로 v1 되돌아감 판을 만든다
  const src = adapters.DEMO_INVENTORY_V2.aws!, orig = src.items;
  src.items = orig.filter((i) => (i as { kind: string }).kind !== "ecs.service");
  let aid: string;
  try { aid = await imported("aws"); } finally { src.items = orig; }
  const a = await pick(T, aid);
  assert.equal(a!.specV2, null);
  const ra = adapters.resolveSpecV2(a!);
  assert.equal(ra.ok && ra.source, "upconvert");
});

test("거부: 사람이 고친 새 판에 spec_v2 가 없으면 NEEDS_HUMAN, 다른 회사에선 판이 안 보인다", { skip }, async () => {
  const id = await imported("gcp");
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta)
    SELECT tenant_id, migration_id, 2, spec, '{}'::jsonb FROM spec_versions WHERE migration_id=$1 AND version=1`, [id]);
  const r = await pick(T, id);
  assert.equal(r!.version, 2);
  assert.equal(r!.hadV2Before, true);
  const res = adapters.resolveSpecV2(r!);
  assert.equal(!res.ok && res.code, "NEEDS_HUMAN");
  assert.throws(() => adapters.specV2OrThrow(r!), (e: unknown) => e instanceof adapters.AdapterError && e.code === "NEEDS_HUMAN");
  assert.equal(await pick(OTHER, id), null);
});
