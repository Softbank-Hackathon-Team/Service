// VI9 DB 시험: aws(ECS) v2 가져오기 — 두 번 가져와도 같은 명세(결정적), 깃발 off 면 v1 그대로, 다른 회사는 판이 안 보임, 감사에 계정 ARN 없음
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID();
const prev = process.env.IMPORT_IR;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vi9'), ($2, 'test-vi9-other')", [T, OTHER]);
  await core.startBoss();
});
afterEach(() => { if (prev === undefined) delete process.env.IMPORT_IR; else process.env.IMPORT_IR = prev; });
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function imported(ir: "v2" | undefined) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','d','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  if (ir) process.env.IMPORT_IR = ir; else delete process.env.IMPORT_IR;
  await imp.handleImport({ tenantId: T, requestId: `r-vi9-${id.slice(0, 8)}`, migrationId: id });
  return id;
}
const row = async (id: string) => (await owner.query("SELECT spec, spec_v2 FROM spec_versions WHERE migration_id=$1", [id])).rows[0];

test("결정적: 같은 ECS 원본을 두 번 가져오면 spec_v2·v1 투영이 글자 하나까지 같다", { skip }, async () => {
  const a = await row(await imported("v2")), b = await row(await imported("v2"));
  assert.ok(a.spec_v2);
  assert.equal(core.canonical(a.spec_v2), core.canonical(b.spec_v2));
  assert.equal(core.canonical(a.spec), core.canonical(b.spec));
});

test("깃발 off: aws ECS 데모여도 IMPORT_IR 없으면 spec_v2 없이 v1 그대로 (shop-api)", { skip }, async () => {
  const v = await row(await imported(undefined));
  assert.equal(v.spec_v2, null);
  assert.equal(v.spec.app.name, "shop-api");
});

test("거부: 다른 회사에선 ECS 가져오기 판이 안 보이고, 감사엔 비밀 ARN 계정·평문 env 값이 없다", { skip }, async () => {
  const id = await imported("v2");
  assert.equal(await core.withTenant(OTHER, (tx) => core.latestAcceptedSpecV2(tx, id)), null);
  assert.ok(await core.withTenant(T, (tx) => core.latestAcceptedSpecV2(tx, id)));
  const t = (await owner.query("SELECT string_agg(detail::text, '\n') AS t FROM audit_events WHERE target=$1", [id])).rows[0].t as string;
  assert.equal(/arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d{12}:/.test(t), false, "감사에 ARN 계정 ID");
  assert.equal(/"value"\s*:/.test(t), false, "감사에 env 값");
});
