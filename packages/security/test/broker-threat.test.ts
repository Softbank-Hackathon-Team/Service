// 임시 역할 중개자 위협 시험 (THREAT-MODEL.md T-ROLE-6~9). J 의 중개자(broker.ts)가 있어야 돈다.
// 막혀야 하는데 지금 못 막는 것은 { todo } 로 둔다. 고치면 todo 를 지운다
// J2: T-ROLE-6·7·8 을 고쳐 todo 3개를 지웠다 (시험 본문은 U 원본 그대로)
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createTempRoleBroker, loadPermissionSet, mockIssuer, TempRoleDenied, awsStsIssuer, memoryLedger, type AuditRecord } from "../src/index.js";

const PERM_DIR = fileURLToPath(new URL("../../../infra/permissions/", import.meta.url));
const T = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const M1 = "44444444-4444-4444-8444-444444444444";
const M2 = "55555555-5555-4555-8555-555555555555";
const t0 = new Date("2026-11-07T01:00:00Z");

function make(o: { withPermissions?: boolean } = {}) {
  const log: Array<{ tenantId: string } & AuditRecord> = [];
  const broker = createTempRoleBroker({
    issuers: { aws: mockIssuer("aws") }, now: () => t0,
    ...(o.withPermissions === false ? {} : { permissions: loadPermissionSet(PERM_DIR) }),
    resolveEnv: async (_t, _e, p) => ({ roleRef: `arn:aws:iam::000000000000:role/svc-${p}`, externalId: "ext-test-only" }),
    audit: async (tenantId, a) => { log.push({ tenantId, ...a }); },
  });
  return { broker, log };
}
const req = (stage: "plan" | "apply" | "destroy", actions: string[], migrationId = M1) =>
  ({ tenantId: T, envId: E, provider: "aws", purpose: "operate", stage, migrationId, actions, ttlSec: 900 });

test("막힘: plan 단계에서 지우기 동작 요청 → 천장 밖(세션 정책) 거부 + 감사 denied", async () => {
  const { broker, log } = make();
  await assert.rejects(broker.issue(req("plan", ["rds:DeleteDBInstance"])),
    (e: unknown) => e instanceof TempRoleDenied && e.code === "ROLE_OUTSIDE_CEILING");
  assert.equal(log.at(-1)?.action, "temp_role.denied");
});

test("막힘: 거부 감사에도 ExternalId·자격 증명 값이 없다", async () => {
  const { broker, log } = make();
  await broker.issue(req("apply", ["rds:CreateDBInstance"]));
  await broker.issue(req("plan", ["rds:DeleteDBInstance"])).catch(() => {});
  assert.doesNotMatch(JSON.stringify(log), /ext-test-only|mock-secret|mock-session|ASIAMOCK/);
});

test("막힘(J2): 천장 파일 없이 만든 중개자가 AWS 실행 역할을 세션 정책 없이 발급",
  async () => {
    const { broker } = make({ withPermissions: false });
    await assert.rejects(broker.issue(req("plan", ["rds:DeleteDBInstance"])));
  });

test("막힘(J2): 같은 회사의 다른 이전이 남의 자격 증명 참조를 씀",
  async () => {
    const { broker } = make();
    const c = await broker.issue(req("apply", ["rds:CreateDBInstance"], M1));
    const useAs = broker.use as unknown as (ref: string, tenantId: string, migrationId?: string) => unknown;
    assert.throws(() => useAs(c.credentialRef, T, M2));
  });

test("막힘(J2): 워커 두 대 — 다른 워커가 회수하면 '회수 완료' 증거가 거짓이 된다",
  async () => {
    const a = make(), b = make();
    await a.broker.issue(req("apply", ["rds:CreateDBInstance"], M1));
    const r = await b.broker.revokeForMigration(T, M1, "cleanup");
    assert.equal(r.evidence.operateRoleRevoked, false);
  });

// Z47: 진짜 AWS 발급기는 ExternalId 없으면 거부 (Mock 은 통과)
test("Z47 T-ROLE-2: 진짜 STS 발급기 + ExternalId 없음 → ROLE_NO_EXTERNAL_ID, STS 는 안 불림", async () => {
  const mk = createTempRoleBroker, lp = loadPermissionSet, sts = awsStsIssuer, ml = memoryLedger, mi = mockIssuer, dir = PERM_DIR;
  let called = 0;
  const audit: string[] = [];
  const req = { tenantId: "11111111-1111-4111-8111-111111111111", envId: "22222222-2222-4222-8222-222222222222",
    provider: "aws", purpose: "operate", stage: "plan", migrationId: "44444444-4444-4444-8444-444444444444",
    actions: ["rds:DescribeDBInstances"], ttlSec: 900 };
  const real = mk({ permissions: lp(dir), ledger: ml({ durable: true }),
    issuers: { aws: sts({ sts: { assumeRole: async () => { called++; return {}; } } }) },
    resolveEnv: async () => ({ roleRef: "arn:aws:iam::000000000000:role/svc-operate" }),
    audit: async (_t, a) => { audit.push(`${a.action}:${(a.detail as { code?: string } | undefined)?.code ?? ""}`); } });
  await assert.rejects(real.issue(req), (e: Error & { code?: string }) => e.code === "ROLE_NO_EXTERNAL_ID");
  assert.equal(called, 0);
  assert.deepEqual(audit, ["temp_role.denied:ROLE_NO_EXTERNAL_ID"]);
  const mock = mk({ permissions: lp(dir), ledger: ml({ durable: true }), issuers: { aws: mi("aws") },
    resolveEnv: async () => ({ roleRef: "arn:aws:iam::000000000000:role/svc-operate" }), audit: async () => {} });
  assert.equal((await mock.issue(req)).stub, true);
});

// Z47: NotAction 으로 와일드카드 검사를 빠져나가는 세션 정책
test("Z47: 세션 정책에 Allow+NotAction / Action 없음 → ROLE_POLICY_SHAPE", async () => {
  const { checkSessionPolicy } = await import("../src/index.js");
  const ceiling = loadPermissionSet(PERM_DIR).aws.ceiling;
  const notAction = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", NotAction: "iam:*", Resource: "*" }] });
  assert.throws(() => checkSessionPolicy(notAction, ceiling), (e: Error & { code?: string }) => e.code === "ROLE_POLICY_SHAPE");
  const notRes = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "rds:DescribeDBInstances", NotResource: "arn:aws:rds:*:*:db:x" }] });
  assert.throws(() => checkSessionPolicy(notRes, ceiling), (e: Error & { code?: string }) => e.code === "ROLE_POLICY_SHAPE");
});

// Z47: 만료된 자격을 먼저 use() 해도 sweep 이 temp_role.expired 감사를 남긴다
test("Z47: 만료 뒤 use() → VaultMiss, 그 뒤 sweep 이 expired 감사를 남긴다", async () => {
  const { memoryLedger, VaultMiss } = await import("../src/index.js");
  let now = new Date("2026-11-07T01:00:00Z");
  const actions: string[] = [];
  const b = createTempRoleBroker({ issuers: { gcp: mockIssuer("gcp") }, permissions: loadPermissionSet(PERM_DIR),
    ledger: memoryLedger({ durable: true }), now: () => now,
    resolveEnv: async () => ({ roleRef: "app-x@p.iam.gserviceaccount.com" }), audit: async (_t, a) => { actions.push(a.action); } });
  const T = "11111111-1111-4111-8111-111111111111";
  const c = await b.issue({ tenantId: T, envId: "22222222-2222-4222-8222-222222222222", provider: "gcp", purpose: "observe",
    actions: ["cloudsql.instances.get"], ttlSec: 60 });
  now = new Date(now.getTime() + 61_000);
  assert.throws(() => b.use(c.credentialRef, T), VaultMiss);
  assert.equal((await b.sweep()).expired, 1);
  assert.ok(actions.includes("temp_role.expired"));
  assert.equal(b.active(T).length, 0);
});
