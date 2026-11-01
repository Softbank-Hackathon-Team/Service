import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { checkGuard } from "@svc/core";
import {
  createTempRoleBroker, loadPermissionSet, mockIssuer, awsStsIssuer, gcpIamIssuer, assumeRoleInput, memoryLedger,
  checkSessionPolicy, TempRoleDenied, CredentialVault, VaultMiss, type AuditRecord, type StsApi, type FetchLike,
} from "../src/index.js";

// G 가 만든 진짜 최소 권한 파일을 그대로 읽는다 (복사본 아님)
const PERM_DIR = fileURLToPath(new URL("../../../infra/permissions/", import.meta.url));
const T = "11111111-1111-4111-8111-111111111111";
const T2 = "33333333-3333-4333-8333-333333333333";
const E = "22222222-2222-4222-8222-222222222222";
const M = "44444444-4444-4444-8444-444444444444";
const t0 = new Date("2026-11-07T01:00:00Z");

function setup(o: { now?: () => Date; ledger?: ReturnType<typeof memoryLedger> } = {}) {
  const log: Array<{ tenantId: string } & AuditRecord> = [];
  const issuers = { aws: mockIssuer("aws"), gcp: mockIssuer("gcp"), onprem: mockIssuer("onprem") };
  const broker = createTempRoleBroker({
    issuers, permissions: loadPermissionSet(PERM_DIR), now: o.now ?? (() => t0), ledger: o.ledger ?? memoryLedger({ durable: true }),
    resolveEnv: async (_t, _e, purpose) => ({ roleRef: `arn:aws:iam::000000000000:role/svc-${purpose}`, externalId: "ext-123" }),
    audit: async (tenantId, a) => { log.push({ tenantId, ...a }); },
  });
  return { broker, log, issuers };
}
const awsApply = { tenantId: T, envId: E, provider: "aws", purpose: "operate", stage: "apply", migrationId: M,
  actions: ["rds:CreateDBInstance", "rds:DescribeDBInstances"], ttlSec: 600 };

test("최소 권한 파일 읽기: AWS 천장·세션 정책 3개, GCP 커스텀 역할, k3s ClusterRole", () => {
  const p = loadPermissionSet(PERM_DIR);
  assert.ok(p.aws.ceiling.includes("rds:CreateDBInstance"));
  assert.ok(p.aws.ceiling.every((a) => !a.includes("*")));
  for (const s of ["plan", "apply", "destroy"] as const) assert.ok(checkSessionPolicy(p.aws.sessionPolicies[s], p.aws.ceiling).length > 0);
  assert.ok(p.gcp.ceiling.includes("cloudsql.instances.create"));
  assert.ok(p.onprem.ceiling.includes("apps/deployments:create"));
  assert.ok(p.onprem.ceiling.includes("core/namespaces:get"));
});

test("AWS 실행 역할 발급: apply 세션 정책이 붙고, STS 최소 900초로 올림, 감사에 값 없이 참조만", async () => {
  const { broker, log } = setup();
  const c = await broker.issue(awsApply);
  assert.equal(c.stub, true);
  assert.equal(c.stage, "apply");
  assert.equal(c.ttlAdjustedSec, 900);
  assert.equal(c.expiresAt, "2026-11-07T01:15:00.000Z");
  assert.match(c.credentialRef, /^cred\/aws\/svc-operate-11111111-44444444-/);
  const issued = log.find((l) => l.action === "temp_role.issued")!;
  assert.equal(issued.result, "ok");
  assert.equal((issued.detail!.issuer as { sessionPolicyChars: number }).sessionPolicyChars > 0, true);
  // 비밀 값(mock-secret…, ExternalId 값)은 감사·자격 참조 어디에도 없다
  const dump = JSON.stringify(log) + JSON.stringify(c);
  assert.doesNotMatch(dump, /mock-secret|mock-session|ext-123/);
  // 값은 같은 회사가 use() 할 때만 나온다
  const m = broker.use(c.credentialRef, T, M);
  assert.equal(m.kind, "aws");
  assert.throws(() => broker.use(c.credentialRef, T2, M), VaultMiss);   // 남의 회사 → 없음
  assert.throws(() => broker.use(c.credentialRef, T), VaultMiss);       // 이전 번호 없이 → 없음
});

test("거부: 천장 밖 동작, 단계 없음, 관찰 역할 쓰기 → 403 + 감사 denied", async () => {
  const { broker, log } = setup();
  await assert.rejects(broker.issue({ ...awsApply, actions: ["s3:DeleteBucket"] }), (e) => e instanceof TempRoleDenied && e.code === "ROLE_OUTSIDE_CEILING");
  await assert.rejects(broker.issue({ ...awsApply, stage: undefined }), (e) => e instanceof TempRoleDenied && e.code === "ROLE_OPERATE_NO_STAGE");
  // apply 단계에 destroy 동작을 달라고 하면 거부 (세션 정책이 더 좁다)
  await assert.rejects(broker.issue({ ...awsApply, actions: ["rds:DeleteDBInstance"] }), (e) => e instanceof TempRoleDenied && e.code === "ROLE_OUTSIDE_CEILING");
  await assert.rejects(broker.issue({ ...awsApply, purpose: "observe", stage: undefined, actions: ["rds:CreateDBInstance"] }),
    (e) => e instanceof TempRoleDenied && e.code === "ROLE_OBSERVE_WRITE");
  assert.deepEqual(log.map((l) => [l.action, l.result]), Array(4).fill(["temp_role.denied", "denied"]));
});

test("GCP·온프레: 커스텀 역할·ClusterRole 천장 안만 허용", async () => {
  const { broker } = setup();
  const g = await broker.issue({ tenantId: T, envId: E, provider: "gcp", purpose: "operate", migrationId: M,
    actions: ["cloudsql.instances.create"], ttlSec: 1800 });
  assert.equal(g.ttlAdjustedSec, 900);   // 실행 역할은 15분까지 (T-ROLE-9)
  await assert.rejects(broker.issue({ tenantId: T, envId: E, provider: "gcp", purpose: "operate", migrationId: M,
    actions: ["storage.buckets.delete"], ttlSec: 1800 }), (e) => e instanceof TempRoleDenied && e.code === "ROLE_OUTSIDE_CEILING");
  const k = await broker.issue({ tenantId: T, envId: E, provider: "onprem", purpose: "operate", migrationId: M,
    actions: ["apps/deployments:patch"], ttlSec: 300 });
  assert.equal(k.ttlAdjustedSec, 600);   // k8s TokenRequest 최소 600초
});

test("회수: 이전 끝나면 실행 역할 전부 회수 → cleanup→completed 조건(T27) 통과, 감사 revoked", async () => {
  const { broker, log } = setup();
  const a = await broker.issue(awsApply);
  await broker.issue({ ...awsApply, stage: "destroy", actions: ["rds:DeleteDBInstance"] });
  const r = await broker.revokeForMigration(T, M, "cleanup");
  assert.equal(r.revoked, 2);
  assert.equal(checkGuard("cleanup", "completed", { facts: {} as never, ev: { ...r.evidence, tempResources: 0 } }), null);
  assert.throws(() => broker.use(a.credentialRef, T, M), VaultMiss);
  assert.equal(log.filter((l) => l.action === "temp_role.revoked").length, 2);
  assert.equal(broker.active(T).length, 0);
});

test("만료: 시간이 지나면 use 실패, sweep 이 지우고 감사 expired", async () => {
  let now = t0;
  const { broker, log } = setup({ now: () => now });
  const c = await broker.issue(awsApply);
  now = new Date(t0.getTime() + 901_000);
  assert.equal((await broker.sweep()).expired, 1);
  assert.throws(() => broker.use(c.credentialRef, T, M), VaultMiss);
  assert.ok(log.some((l) => l.action === "temp_role.expired"));
});

test("보관함: 값을 JSON·inspect 로 찍어도 [redacted]", () => {
  const v = new CredentialVault();
  v.put({ ref: "r", tenantId: T, migrationId: null, provider: "gcp", expiresAt: t0.getTime() + 1000, material: { kind: "bearer", token: "SECRET-XYZ" } });
  assert.doesNotMatch(JSON.stringify(v) + inspect(v, { depth: 5 }), /SECRET-XYZ/);
  assert.equal((v.use("r", T, t0) as { token: string }).token, "SECRET-XYZ");
});

test("AWS STS 요청 모양: ExternalId·세션 정책·태그·SourceIdentity, 회수는 고객 역할을 안 건드림", async () => {
  const calls: unknown[] = [];
  const sts: StsApi = { async assumeRole(i) { calls.push(i); return {
    Credentials: { AccessKeyId: "ASIA1", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(t0.getTime() + 900_000) },
    AssumedRoleUser: { Arn: "arn:aws:sts::000000000000:assumed-role/svc-operate/x" } }; } };
  const iss = awsStsIssuer({ sts });
  const req = { ...awsApply, purpose: "operate" as const, provider: "aws" as const, stage: "apply" as const };
  const out = await iss.issue({ req, now: t0, roleRef: "arn:aws:iam::000000000000:role/svc-operate", sessionName: "svc-operate-x", sessionPolicy: "{}", externalId: "ext" });
  assert.equal(out.ttlSec, 900);
  const i = calls[0] as ReturnType<typeof assumeRoleInput>;
  assert.equal(i.ExternalId, "ext"); assert.equal(i.Policy, "{}"); assert.equal(i.DurationSeconds, 900);
  assert.deepEqual(i.Tags!.map((x) => x.Key), ["svc:tenant", "svc:purpose", "svc:migration"]);
  const rv = await iss.revoke({ roleRef: "arn:aws:iam::000000000000:role/svc-operate", issuedAt: t0, now: t0, material: null, hard: true });
  assert.deepEqual(rv, { hardRevoked: false, detail: { method: "drop_and_expire", maxRemainingSec: 900 } });
});

test("GCP generateAccessToken 요청 모양: SA 경로, cloud-platform 범위, 수명 초 단위, 플랫폼 토큰", async () => {
  let seen: { url: string; auth: string; body: { scope: string[]; lifetime: string } } | null = null;
  const f: FetchLike = async (url, init) => {
    seen = { url, auth: init.headers.authorization!, body: JSON.parse(init.body!) };
    return { status: 200, json: async () => ({ accessToken: "ya29.mock", expireTime: "2026-11-07T01:30:00Z" }) };
  };
  const iss = gcpIamIssuer({ platformToken: async () => "platform-tok", fetch: f });
  const out = await iss.issue({ req: { tenantId: T, envId: E, provider: "gcp", purpose: "operate", migrationId: M, actions: [], ttlSec: 1800 },
    now: t0, roleRef: "svc-operate@proj.iam.gserviceaccount.com", sessionName: "s" });
  assert.equal(seen!.url, "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/svc-operate%40proj.iam.gserviceaccount.com:generateAccessToken");
  assert.equal(seen!.auth, "Bearer platform-tok");
  assert.deepEqual(seen!.body, { scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: "1800s" });
  assert.equal(out.expiresAt.toISOString(), "2026-11-07T01:30:00.000Z");
});
