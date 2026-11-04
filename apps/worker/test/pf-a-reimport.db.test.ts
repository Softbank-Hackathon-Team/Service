// PF-A 6회차 (관점 8 재실행·멱등): 실검증 EKS 입력(가짜 CLI)으로 import 처리기를 같은 작업에 동시 두 번 + 한 번 더 → 명세 판 1개, spec_review.
//   처리기를 직접 부른다(pg-boss 없이). 바깥 읽기는 importDeps.discover 를 가짜 CLI discoverAws 로 바꿔 끼운다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-pf-a-reimport')", [T]);
});
after(async () => {
  if (skip) return;
  await core.pool.end(); await owner.end();
});

test("PF-A 6: 같은 import 작업이 동시에 두 번·뒤늦게 한 번 더 와도 명세 판 1개, ids 는 출발 자원마다 하나", { skip }, async () => {
  const { discoverAws } = await import("@svc/adapters");
  const { pfExec } = await import("../../../packages/adapters/test/pf-a-eks-demo-fixture.js");
  const id = randomUUID(), s = randomUUID(), g = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, g, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, source_scope) VALUES ($1,$2,$3,$4,'importing',$5)`,
    [id, T, s, g, { namespaces: ["real-app"], appName: "shop" }]);
  const orig = imp.importDeps.discover;
  let calls = 0;
  imp.importDeps.discover = (async (_p: unknown, opts: Parameters<typeof discoverAws>[1]) => { calls++; return discoverAws({ exec: pfExec({}).exec, env: {} }, opts); }) as typeof orig;
  const job = { tenantId: T, requestId: "pf-a-6", migrationId: id };
  try {
    await Promise.all([imp.handleImport(job), imp.handleImport(job)]);
    await imp.handleImport(job);
  } finally { imp.importDeps.discover = orig; }
  const m = (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0];
  assert.equal(m.status, "spec_review");
  const v = (await owner.query("SELECT version, spec_v2 FROM spec_versions WHERE migration_id=$1", [id])).rows as Array<{ version: number; spec_v2: { spec: { app: { name: string }; components: Array<{ id: string }> }; ids: Record<string, string> } }>;
  assert.equal(v.length, 1, "동시에 둘이 읽어도 저장은 하나(행 잠금 + 상태 다시 보기)");
  assert.equal(v[0]!.spec_v2.spec.app.name, "shop", "출발 범위 appName");
  assert.deepEqual(v[0]!.spec_v2.spec.components.map((c) => c.id).sort(), ["platform-demo-db", "shop-api", "shop-web"]);
  assert.equal(new Set(Object.values(v[0]!.spec_v2.ids)).size, Object.values(v[0]!.spec_v2.ids).length, "id 겹침 없음");
  assert.ok(calls <= 2, `세 번째(이미 spec_review)는 바깥을 안 읽음 (읽은 횟수 ${calls})`);
  await owner.query("DELETE FROM migrations WHERE id=$1", [id]).catch(() => {});
});
