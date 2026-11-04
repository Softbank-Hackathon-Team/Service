// PF FM-ORC-20: 롤백 단계는 실행 역할 회수를 withStepRoles 가 끝난 뒤에 한다 (재발급 고리가 단계 자신의 자격을 잃지 않게)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DB 없음" : false;
let core: typeof import("@svc/core");
let roles: typeof import("../src/jobs/_roles.js");
let platform: typeof import("../src/platform.js");
let owner: pg.Client;
const T = randomUUID(), AWS = randomUUID(), GCP = randomUUID(), M = randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SRC = readFileSync(new URL("../src/jobs/rollback.ts", import.meta.url), "utf8");

before(async () => {
  if (skip) return;
  process.env.CRED_RENEW_SEC = "0.05";
  core = await import("@svc/core");
  roles = await import("../src/jobs/_roles.js");
  platform = await import("../src/platform.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-orc-20')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id) VALUES
    ($1,$3,'aws','a','connected','999988887777'), ($2,$3,'gcp','g','connected','pf20-project')`, [AWS, GCP, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'rolling_back')`, [M, T, AWS, GCP]);
});
after(async () => { if (skip) return; delete process.env.CRED_RENEW_SEC; await core.pool.end(); await owner.end(); });

test("PF FM-ORC-20 정상: 재발급 주기를 넘는 롤백 일이 끝까지 돌고, 회수는 그 뒤", { skip }, async () => {
  const mig = { id: M, status: "rolling_back" as const, sourceEnvId: AWS, targetEnvId: GCP };
  const out = await roles.withStepRoles("rollback", { tenantId: T, migrationId: M }, mig as never, async () => { await sleep(300); return 1; });
  assert.equal(out, 1);
  const r = await platform.tempRoles().revokeForMigration(T, M, "rolled_back");
  assert.ok(Array.isArray(r.revoked) || typeof r.revoked === "number");
});

test("PF FM-ORC-20 거부: rollback.ts 의 단계 일(withStepRoles 안)에서 revokeForMigration 을 부르지 않는다", () => {
  assert.match(SRC, /withRevokeAfter\(j, await withStepRoles\("rollback"/);
  const inside = SRC.slice(SRC.indexOf('withStepRoles("rollback"'), SRC.indexOf("onError:"));
  assert.doesNotMatch(inside, /revokeForMigration/);
});
