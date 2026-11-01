// Z20 (리뷰 Z10 M5): 발급기 회수가 실패해도 장부를 먼저 지우지 않는다 → 회수 증거가 거짓 true가 안 된다
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createTempRoleBroker, loadPermissionSet, mockIssuer, memoryLedger, type AuditRecord } from "../src/index.js";

const PERM_DIR = fileURLToPath(new URL("../../../infra/permissions/", import.meta.url));
const T = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const M = "44444444-4444-4444-8444-444444444444";
const t0 = new Date("2026-11-07T01:00:00Z");

function make(failRevokes: number) {
  const log: AuditRecord[] = [];
  const base = mockIssuer("gcp");
  let left = failRevokes;
  const flaky = { ...base, async revoke(ctx: Parameters<typeof base.revoke>[0]) {
    if (left-- > 0) throw new Error("oauth2 revoke HTTP 503");
    return base.revoke(ctx);
  } };
  const ledger = memoryLedger({ durable: true });
  const broker = createTempRoleBroker({
    issuers: { gcp: flaky }, now: () => t0, permissions: loadPermissionSet(PERM_DIR), ledger,
    resolveEnv: async () => ({ roleRef: "svc-operate@finals-demo.iam.gserviceaccount.com" }),
    audit: async (_t, a) => { log.push(a); },
  });
  return { broker, log, ledger };
}
const op = { tenantId: T, envId: E, provider: "gcp", purpose: "operate", migrationId: M,
  actions: ["cloudsql.instances.create"], ttlSec: 900 };

test("M5: 회수 실패 → revoke_failed 감사, 장부·보관함 그대로, 증거 false / 다시 하면 회수되고 true", async () => {
  const { broker, log, ledger } = make(1);
  const c = await broker.issue(op);
  const r1 = await broker.revokeForMigration(T, M, "cleanup");
  assert.equal(r1.evidence.operateRoleRevoked, false, "실패했는데 true면 T27이 거짓으로 통과");
  assert.deepEqual([r1.revoked, r1.failed, r1.stillActive], [0, 1, 1]);
  assert.ok(log.some((a) => a.action === "temp_role.revoke_failed" && a.result === "error"));
  assert.equal(ledger.rows.get(c.credentialRef)?.status, "active");
  assert.equal(broker.use(c.credentialRef, T, M).kind, "bearer", "다시 회수하려면 값이 남아 있어야 한다(GCP 토큰 회수)");
  const r2 = await broker.revokeForMigration(T, M, "cleanup");
  assert.deepEqual([r2.revoked, r2.failed, r2.stillActive, r2.evidence.operateRoleRevoked], [1, 0, 0, true]);
});

test("M5: 회수 하나가 실패해도 같은 이전의 다른 역할은 회수한다", async () => {
  const { broker } = make(1);
  await broker.issue(op); await broker.issue(op);
  const r = await broker.revokeForMigration(T, M, "cleanup");
  assert.deepEqual([r.revoked, r.failed, r.stillActive, r.evidence.operateRoleRevoked], [1, 1, 1, false]);
});
