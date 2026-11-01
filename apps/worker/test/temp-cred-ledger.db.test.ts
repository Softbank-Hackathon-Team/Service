// DB 시험: 임시 자격 장부(temp_credentials)로 워커 두 대의 회수 증거 (위협 모델 T-ROLE-8). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let sec: typeof import("@svc/security");
let ledgerMod: typeof import("../src/temp-cred-ledger.js");
let owner: pg.Client;
const T = randomUUID(), S = randomUUID(), G = randomUUID(), M = randomUUID();
const PERM_DIR = fileURLToPath(new URL("../../../infra/permissions/", import.meta.url));

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  sec = await import("@svc/security");
  ledgerMod = await import("../src/temp-cred-ledger.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-temp-cred')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'cleanup')`, [M, T, S, G]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

function worker(name: string) {
  return sec.createTempRoleBroker({
    issuers: { aws: sec.mockIssuer("aws") }, permissions: sec.loadPermissionSet(PERM_DIR),
    ledger: ledgerMod.pgLedger(), owner: name,
    resolveEnv: async () => ({ roleRef: "arn:aws:iam::000000000000:role/svc-operate" }),
    audit: (tenantId, a) => core.withTenant(tenantId, (tx) => core.writeAudit(tx, tenantId, a)),
  });
}

test("워커 두 대: B 의 회수는 요청만 → 증거 false, A 청소 뒤 → true. 표에는 값이 없다", { skip }, async () => {
  const a = worker("worker-a"), b = worker("worker-b");
  const c = await a.issue({ tenantId: T, envId: G, provider: "aws", purpose: "operate", stage: "apply", migrationId: M,
    actions: ["rds:CreateDBInstance"], ttlSec: 900 });
  const r1 = await b.revokeForMigration(T, M, "cleanup");
  assert.deepEqual([r1.requested, r1.evidence.operateRoleRevoked], [1, false]);
  assert.equal((await a.sweep()).revokedOnRequest, 1);
  const r2 = await b.revokeForMigration(T, M, "cleanup");
  assert.equal(r2.evidence.operateRoleRevoked, true);
  const row = (await owner.query("SELECT * FROM temp_credentials WHERE credential_ref=$1", [c.credentialRef])).rows[0];
  assert.equal(row.status, "revoked");
  assert.equal(row.owner, "worker-a");
  assert.doesNotMatch(JSON.stringify(row), /mock-secret|mock-session|ASIAMOCK/);
});

test("회사 벽: 다른 회사로는 장부 줄이 안 보인다 (RLS)", { skip }, async () => {
  const other = randomUUID();
  const n = await core.withTenant(other, (tx) => tx.query("SELECT count(*)::int AS n FROM temp_credentials"));
  assert.equal((n.rows[0] as { n: number }).n, 0);
});
