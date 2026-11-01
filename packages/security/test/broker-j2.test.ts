// J2: 위협 모델(U) T-ROLE-6~10 반영 확인
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  createTempRoleBroker, loadPermissionSet, mockIssuer, memoryLedger, gcpIamIssuer, TempRoleDenied, VaultMiss,
  type AuditRecord, type FetchLike,
} from "../src/index.js";

const PERM_DIR = fileURLToPath(new URL("../../../infra/permissions/", import.meta.url));
const T = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const M1 = "44444444-4444-4444-8444-444444444444";
const M2 = "55555555-5555-4555-8555-555555555555";
const t0 = new Date("2026-11-07T01:00:00Z");

function make(o: { permissions?: boolean; ledger?: ReturnType<typeof memoryLedger>; owner?: string } = {}) {
  const log: Array<{ tenantId: string } & AuditRecord> = [];
  const broker = createTempRoleBroker({
    issuers: { aws: mockIssuer("aws"), gcp: mockIssuer("gcp") }, now: () => t0, owner: o.owner,
    ...(o.permissions === false ? {} : { permissions: loadPermissionSet(PERM_DIR) }),
    ...(o.ledger ? { ledger: o.ledger } : {}),
    resolveEnv: async (_t, _e, p) => ({ roleRef: `arn:aws:iam::000000000000:role/svc-${p}` }),
    audit: async (tenantId, a) => { log.push({ tenantId, ...a }); },
  });
  return { broker, log };
}
const op = (migrationId = M1) => ({ tenantId: T, envId: E, provider: "aws", purpose: "operate", stage: "apply", migrationId,
  actions: ["rds:CreateDBInstance"], ttlSec: 3600 });

test("T-ROLE-6: 권한 파일 없으면 실행 역할 거부(ROLE_NO_CEILING + 감사), 관찰 역할은 읽기만이라 발급", async () => {
  const { broker, log } = make({ permissions: false });
  await assert.rejects(broker.issue(op()), (e) => e instanceof TempRoleDenied && e.code === "ROLE_NO_CEILING");
  assert.equal(log.at(-1)?.action, "temp_role.denied");
  const c = await broker.issue({ tenantId: T, envId: E, provider: "aws", purpose: "observe", actions: ["rds:DescribeDBInstances"], ttlSec: 900 });
  assert.equal(c.purpose, "observe");
  assert.equal(broker.use(c.credentialRef, T).kind, "aws");   // 관찰 역할은 이전 번호 없이 같은 회사면 쓴다
});

test("T-ROLE-9: 실행 역할은 3600초를 요청해도 900초(15분)로 줄인다", async () => {
  const c = await make().broker.issue(op());
  assert.equal(c.expiresAt, "2026-11-07T01:15:00.000Z");
  assert.equal(c.ttlAdjustedSec, 900);
});

test("T-ROLE-7: 같은 회사라도 다른 이전 번호로는 못 꺼낸다", async () => {
  const { broker } = make();
  const c = await broker.issue(op(M1));
  assert.throws(() => broker.use(c.credentialRef, T, M2), VaultMiss);
  assert.equal(broker.use(c.credentialRef, T, M1).kind, "aws");
});

test("T-ROLE-8: 워커 두 대가 같은 장부 → 남이 쥔 건 회수 요청만, 주인이 청소한 뒤에야 증거가 참", async () => {
  const shared = memoryLedger({ durable: true });
  const a = make({ ledger: shared, owner: "worker-a" }), b = make({ ledger: shared, owner: "worker-b" });
  const c = await a.broker.issue(op(M1));
  const r1 = await b.broker.revokeForMigration(T, M1, "cleanup");
  assert.deepEqual([r1.revoked, r1.requested, r1.stillActive, r1.evidence.operateRoleRevoked], [0, 1, 1, false]);
  assert.equal(b.log.at(-1)?.action, "temp_role.revoke_pending");
  assert.equal(a.broker.use(c.credentialRef, T, M1).kind, "aws");   // 아직 A 메모리에 있다
  assert.deepEqual(await a.broker.sweep(), { expired: 0, revokedOnRequest: 1 });
  assert.throws(() => a.broker.use(c.credentialRef, T, M1), VaultMiss);
  const r2 = await b.broker.revokeForMigration(T, M1, "cleanup");
  assert.equal(r2.evidence.operateRoleRevoked, true);
  assert.equal(shared.rows.get(c.credentialRef)?.status, "revoked");
});

test("T-ROLE-8: 장부에 값은 없다, 메모리 장부(durable=false)는 회수 증거를 참으로 안 낸다", async () => {
  const ledger = memoryLedger();
  const { broker } = make({ ledger });
  await broker.issue(op(M1));
  assert.doesNotMatch(JSON.stringify([...ledger.rows.values()]), /mock-secret|mock-session|ASIAMOCK/);
  const r = await broker.revokeForMigration(T, M1, "cleanup");
  assert.equal(r.revoked, 1);
  assert.equal(r.evidence.operateRoleRevoked, false);
});

test("T-ROLE-10: GCP 강제 회수는 토큰을 URL 이 아니라 본문에 싣는다", async () => {
  let seen: { url: string; body?: string } | null = null;
  const f: FetchLike = async (url, init) => { seen = { url, body: init.body }; return { status: 200, json: async () => ({}) }; };
  const iss = gcpIamIssuer({ platformToken: async () => "p", fetch: f });
  await iss.revoke({ roleRef: "sa@x", issuedAt: t0, now: t0, material: { kind: "bearer", token: "ya29.SECRET" }, hard: true });
  assert.equal(seen!.url, "https://oauth2.googleapis.com/revoke");
  assert.equal(seen!.body, "token=ya29.SECRET");
});
