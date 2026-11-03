// Z39 DB 시험: 작업 단계가 임시 역할을 빌리고 돌려준 기록이 장부(temp_credentials, 0013 칸)·감사에 남는가. DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let roles: typeof import("../src/jobs/_roles.js");
let platform: typeof import("../src/platform.js");
let owner: pg.Client;
const T = randomUUID(), AWS = randomUUID(), GCP = randomUUID(), AZ = randomUUID();
const M1 = randomUUID(), M2 = randomUUID(), M3 = randomUUID();
const mig = (id: string, sourceEnvId: string, targetEnvId: string) => ({ id, status: "provisioning" as const, sourceEnvId, targetEnvId });
const ledger = async (m: string) => (await owner.query(
  `SELECT purpose, stage, step, status, actions_count, requested_ttl_sec, stub, revoke_reason, expired_at, expires_at, role_ref
     FROM temp_credentials WHERE migration_id = $1 OR (migration_id IS NULL AND env_id = ANY($2::uuid[])) ORDER BY issued_at`,
  [m, [AWS, GCP, AZ]])).rows;
const audits = async (action: string) => (await owner.query(
  `SELECT detail FROM audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY seq`, [T, action])).rows.map((r) => r.detail);

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  roles = await import("../src/jobs/_roles.js");
  platform = await import("../src/platform.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z39')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id) VALUES
    ($1,$4,'aws','a','connected','999988887777'), ($2,$4,'gcp','g','connected','z39-project'), ($3,$4,'azure_mock','z','connected',NULL)`,
    [AWS, GCP, AZ, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES
    ($1,$4,$5,$6,'provisioning'), ($2,$4,$5,$7,'provisioning'), ($3,$4,$5,$6,'cleanup')`, [M1, M2, M3, T, AWS, GCP, AZ]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("apply 단계: 도착 gcp 실행 역할 1건 발급 → 단계 끝에 회수. 장부에 step·동작 수·요청 수명·Mock 이 남고 값은 없다", { skip }, async () => {
  const r = await roles.withStepRoles("apply", { tenantId: T, migrationId: M1 }, mig(M1, AWS, GCP), async (x) => x);
  assert.equal(r.creds.length, 1);
  assert.deepEqual(r.denied, []);
  const rows = (await ledger(M1)).filter((x) => x.purpose === "operate");
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.deepEqual([row.stage, row.step, row.status, row.revoke_reason, row.requested_ttl_sec, row.stub],
    ["apply", "apply", "revoked", "apply_done", 900, true]);
  assert.ok(row.actions_count > 0 && row.actions_count <= 50);
  assert.equal(row.role_ref, "svc-operate@z39-project.iam.gserviceaccount.com");   // environments.account_id 로 만든 참조
  assert.doesNotMatch(JSON.stringify(await ledger(M1)), /mock-token|mock-secret|ASIAMOCK/);
  const issued = await audits("temp_role.issued");
  assert.equal(issued.at(-1).step, "apply");
});

test("precheck 단계: 출발·도착 관찰 역할 2건 (이전 번호를 붙여 이 이전 장부에 보임), cleanup 은 아무것도 안 빌림(ID-4·ID-8)", { skip }, async () => {
  const before = (await audits("temp_role.issued")).length;
  const p = await roles.withStepRoles("precheck", { tenantId: T, migrationId: M1 }, mig(M1, AWS, GCP), async (x) => x);
  assert.deepEqual(p.creds.map((c) => `${c.provider}:${c.purpose}`), ["aws:observe", "gcp:observe"]);
  assert.equal((await ledger(M1)).filter((x) => x.step === "precheck" && x.purpose === "observe").length, 2);
  const c = await roles.withStepRoles("cleanup", { tenantId: T, migrationId: M1 }, mig(M1, AWS, GCP), async (x) => x);
  assert.deepEqual(c.creds, []);
  assert.equal((await audits("temp_role.issued")).length, before + 2);
});

test("Azure Mock 도착: 실행 역할은 묻지도 않는다 (거부 감사 없음, skipped 로만 남음)", { skip }, async () => {
  const denied = (await audits("temp_role.denied")).length;
  const r = await roles.withStepRoles("apply", { tenantId: T, migrationId: M2 }, mig(M2, AWS, AZ), async (x) => x);
  assert.deepEqual([r.creds.length, r.skipped[0]?.reason], [0, "azure_mock_no_operate"]);
  assert.equal((await audits("temp_role.denied")).length, denied);
});

test("만료 처리(0013): 단계가 돌려주기 전에 워커가 죽어 만료 시각이 지나면 정리 때 expired 로 닫히고 T27 증거는 true", { skip }, async () => {
  // 돌려주지 않고 빌리기만 (워커가 죽은 경우)
  const r = await roles.borrowStepRoles("apply", { tenantId: T, migrationId: M3 }, mig(M3, AWS, GCP));
  assert.equal(r.creds.length, 1);
  await owner.query(`UPDATE temp_credentials SET issued_at = now() - interval '20 min', expires_at = now() - interval '5 min'
    WHERE migration_id = $1`, [M3]);
  // 다른 워커가 정리한다고 치고 장부로 센다 (이 워커 보관함 것은 먼저 지워 "남의 것" 상황을 만든다)
  platform.tempRoles().vault.drop(r.creds[0]!.credentialRef);
  const out = await platform.tempRoles().revokeForMigration(T, M3, "cleanup");
  assert.equal(out.evidence.operateRoleRevoked, true);
  const row = (await ledger(M3)).find((x) => x.purpose === "operate")!;
  assert.equal(row.status, "expired");
  assert.equal(new Date(row.expired_at).getTime(), new Date(row.expires_at).getTime());   // 실제로 죽은 시각
  assert.ok((await audits("temp_role.expired")).some((d) => d.closedBy));
  // CHECK: expired 줄에 expired_at 없이는 못 넣는다
  await assert.rejects(owner.query(`UPDATE temp_credentials SET expired_at = NULL WHERE migration_id = $1 AND status = 'expired'`, [M3]));
});
