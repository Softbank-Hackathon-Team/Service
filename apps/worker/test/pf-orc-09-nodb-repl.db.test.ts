// PF FM-ORC-09 ①: 받아들인 명세에 postgres 가 없으면 워커 전역 REPL_* 가 있어도 복제를 시도하지 않는다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
let repl: typeof import("../src/jobs/_repl.js");
let adapters: typeof import("@svc/adapters");
let core: typeof import("@svc/core");
let owner: pg.Client;
const T = randomUUID();
const ENV = { REPL_SOURCE_URL: "postgres://u:p@src.invalid:5432/shop", REPL_TARGET_URL: "postgres://u:x@tgt.invalid:5432/shop" /* FM-INT-09: PF-E22 뒤 못 채운 {tf:} 는 바로 REPL_TF_FACTS_MISSING 이라 채운 주소로 */ };

before(async () => {
  if (skip) return;
  Object.assign(process.env, ENV);
  core = await import("@svc/core");
  adapters = await import("@svc/adapters");
  repl = await import("../src/jobs/_repl.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-orc-09')", [T]);
});
after(async () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  if (skip) return; await core.pool.end(); await owner.end();
});

async function seed(spec: unknown | null) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'syncing')`, [id, T, src, dst]);
  if (spec) await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
    VALUES ($1,$2,1,'{}','{}',$3)`, [T, id, JSON.stringify({ spec, fieldMeta: {}, unmapped: [], ids: {} })]);
  return id;
}
function noDb() {
  const s = structuredClone(adapters.DEMO_SPEC) as { components: { id: string; kind: string }[]; links: unknown[] };
  const dbIds = new Set(s.components.filter((c) => c.kind === "postgres").map((c) => c.id));
  assert.ok(dbIds.size > 0, "데모 명세엔 postgres 가 있다");
  s.components = s.components.filter((c) => !dbIds.has(c.id));
  s.links = s.links.filter((l) => ![...dbIds].some((d) => JSON.stringify(l).includes(`"${d}"`)));
  return s;
}

test("PF FM-ORC-09 정상: postgres 없는 명세 → 복제 객체 없음(null, STUB 길)", { skip }, async () => {
  const id = await seed(noDb());
  assert.equal(await repl.specHasPostgres(T, id), false);
  assert.equal(await repl.replicationFor(T, id), null);
});

test("PF FM-ORC-09 거부(예전 그대로): postgres 있는 명세·명세 못 읽음 → env 복제 객체", { skip }, async () => {
  const withDb = await seed(adapters.DEMO_SPEC);
  assert.equal(await repl.specHasPostgres(T, withDb), true);
  assert.ok(await repl.replicationFor(T, withDb));
  const none = await seed(null);
  assert.equal(await repl.specHasPostgres(T, none), null);
  assert.ok(await repl.replicationFor(T, none));
});
