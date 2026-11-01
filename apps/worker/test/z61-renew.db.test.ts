// Z61 DB 시험: 단계 동안 임시 자격을 주기적으로 다시 받는가(장부 0015 사슬·감사), 재발급 실패면 단계가 paused 로 멈추는가.
// 시간 가속: CRED_RENEW_SEC=0.05 (진짜 기본 600초). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let roles: typeof import("../src/jobs/_roles.js");
let step: typeof import("../src/jobs/_step.js");
let security: typeof import("@svc/security");
let owner: pg.Client;
const T = randomUUID(), AWS = randomUUID(), GCP = randomUUID();
const M1 = randomUUID(), M2 = randomUUID(), M3 = randomUUID();
const mig = (id: string) => ({ id, status: "provisioning" as const, sourceEnvId: AWS, targetEnvId: GCP });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chain = async (m: string) => (await owner.query(
  `SELECT credential_ref, renewed_from, renew_seq, status, revoke_reason, step, expires_at FROM temp_credentials
    WHERE migration_id = $1 AND purpose = 'operate' ORDER BY renew_seq`, [m])).rows;
const audits = async (action: string, m: string) => (await owner.query(
  `SELECT detail FROM audit_events WHERE tenant_id = $1 AND action = $2 AND target = $3 ORDER BY seq`, [T, action, m])).rows.map((r) => r.detail);

before(async () => {
  if (skip) return;
  process.env.CRED_RENEW_SEC = "0.05";
  core = await import("@svc/core");
  roles = await import("../src/jobs/_roles.js");
  step = await import("../src/jobs/_step.js");
  security = await import("@svc/security");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-z61')", [T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id) VALUES
    ($1,$3,'aws','a','connected','999988887777'), ($2,$3,'gcp','g','connected','z61-project')`, [AWS, GCP, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES
    ($1,$4,$5,$6,'provisioning'), ($2,$4,$5,$6,'provisioning'), ($3,$4,$5,$6,'provisioning')`, [M1, M2, M3, T, AWS, GCP]);
});
after(async () => {
  if (skip) return;
  delete process.env.CRED_RENEW_SEC; delete process.env.CRED_RENEW_STUB_FAIL;
  await core.pool.end(); await owner.end();
});

test("긴 apply: 주기마다 재발급 → 장부에 renewed_from 사슬(seq 0,1,2,…), 앞 줄은 revoked(renewed), 마지막 줄은 단계 끝 회수(apply_done)", { skip }, async () => {
  const r = await roles.withStepRoles("apply", { tenantId: T, migrationId: M1 }, mig(M1), async (x) => { await sleep(300); return x; });
  assert.ok((r.renewals ?? 0) >= 2, `renewals=${r.renewals}`);
  assert.equal(roles.rolesDetail(r).renewals, r.renewals);
  const rows = await chain(M1);
  assert.equal(rows.length, (r.renewals ?? 0) + 1);
  rows.forEach((x, i) => {
    assert.equal(x.renew_seq, i);
    assert.equal(x.renewed_from, i === 0 ? null : rows[i - 1].credential_ref);
    assert.equal(x.step, "apply");
    assert.equal(x.status, "revoked");
    assert.equal(x.revoke_reason, i === rows.length - 1 ? "apply_done" : "renewed");
  });
  assert.equal(r.creds[0]!.credentialRef, rows.at(-1).credential_ref);   // 단계가 쥔 참조 = 늘 최신
  assert.ok(new Date(rows.at(-1).expires_at) > new Date(rows[0].expires_at));
  assert.equal((await audits("temp_role.renewed", M1)).length, r.renewals);
  // 사슬 제약: 재발급 줄에 앞 참조가 없으면 거부, 같은 자격에서 두 번 갈라지면 거부
  await assert.rejects(owner.query(`UPDATE temp_credentials SET renewed_from = NULL WHERE credential_ref = $1`, [rows[1].credential_ref]));
  await assert.rejects(owner.query(`UPDATE temp_credentials SET renewed_from = $1 WHERE credential_ref = $2`,
    [rows[0].credential_ref, rows[2].credential_ref]));
});

test("재발급 실패(CRED_RENEW_STUB_FAIL=1): 일을 기다리지 않고 CredRenewFailed, 감사 renew_failed, 자격은 회수돼 살아 있는 실행 역할 0", { skip }, async () => {
  process.env.CRED_RENEW_STUB_FAIL = "1";
  try {
    const t0 = Date.now();
    let signal: AbortSignal | undefined;
    await assert.rejects(roles.withStepRoles("apply", { tenantId: T, migrationId: M2 }, mig(M2),
      async (x) => { signal = x.signal; await sleep(2000); return x; }),
      (e) => e instanceof security.CredRenewFailed && e.reason === "STUB_RENEW_FAULT");
    assert.ok(Date.now() - t0 < 1500, "2초짜리 일을 끝까지 기다리지 않는다");
    assert.equal(signal?.aborted, true);
    const f = await audits("temp_role.renew_failed", M2);
    assert.equal(f.length, 1);
    assert.equal(f[0].renewSeq, 1);
    const rows = await chain(M2);
    assert.deepEqual(rows.map((x) => [x.renew_seq, x.status, x.revoke_reason]), [[0, "revoked", "apply_done"]]);
  } finally { delete process.env.CRED_RENEW_STUB_FAIL; }
});

test("runStep + failedOnRenewFailure (Z38 REVIEW-4 Z43-1): provisioning → failed(CRED_RENEW_FAILED, failed_at provisioning), 감사 apply.failed — 롤백 대신 정리 확인·다시 계획 길", { skip }, async () => {
  process.env.CRED_RENEW_STUB_FAIL = "1";
  try {
    const res = await step.runStep({ tenantId: T, requestId: randomUUID(), migrationId: M3 }, {
      name: "apply", expect: "provisioning", lock: false,
      work: (j, m) => roles.withStepRoles("apply", j, m, async () => { await sleep(1000); return { to: "deploying" as const }; }),
      onError: async (e) => roles.failedOnRenewFailure(e),
    });
    assert.equal(res, "advanced");
  } finally { delete process.env.CRED_RENEW_STUB_FAIL; }
  const m = (await owner.query(`SELECT status, paused_from, failure_code, failed_at_status FROM migrations WHERE id = $1`, [M3])).rows[0];
  assert.deepEqual([m.status, m.paused_from, m.failure_code, m.failed_at_status], ["failed", null, "CRED_RENEW_FAILED", "provisioning"]);
  const a = await audits("apply.failed", M3);
  assert.equal(a.at(-1).credRenew.reason, "STUB_RENEW_FAULT");
  // 다른 예외는 그대로 (null → 원래 처리). cleanup 쪽 paused 판은 그대로 있다
  assert.equal(roles.failedOnRenewFailure(new Error("x")), null);
  assert.equal(roles.pausedOnRenewFailure(new Error("x")), null);
});
