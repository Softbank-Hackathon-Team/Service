import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConnectionStatus, CONNECTION_VALID, canTransition, nextAfterPeriodic, UNSTABLE_AFTER_FAILURES,
  checkAccountId, ConnectionLink, CreateEnvironmentBody, VerifyBody, ConnectionFailure, JOB_SCHEMAS,
} from "../src/index.js";

const ALLOWED: Record<string, string[]> = {
  draft: ["awaiting_customer", "connected", "disconnected"],
  awaiting_customer: ["awaiting_customer", "verifying", "expired", "connected", "disconnected"],
  verifying: ["connected", "failed"],
  connected: ["connected", "unstable", "disconnected"],
  unstable: ["connected", "unstable", "disconnected"],
  failed: ["awaiting_customer", "verifying", "disconnected"],
  expired: ["awaiting_customer", "disconnected"],
  disconnected: [],
};

test("연결 전이 표: 8×8 중 허용 목록과 정확히 같다 (onprem 기준)", () => {
  for (const from of ConnectionStatus.options) {
    for (const to of ConnectionStatus.options) {
      assert.equal(canTransition("onprem", from, to), ALLOWED[from]!.includes(to), `${from} -> ${to}`);
    }
    assert.deepEqual([...CONNECTION_VALID[from]].sort(), [...ALLOWED[from]!].sort());
  }
});

test("연결 전이 표: disconnected에서는 어디도 못 간다", () => {
  for (const to of ConnectionStatus.options) {
    for (const p of ["aws", "gcp", "onprem", "azure_mock"] as const) {
      assert.equal(canTransition(p, "disconnected", to), false);
    }
  }
});

test("draft·awaiting_customer → connected 는 온프레만", () => {
  assert.equal(canTransition("aws", "draft", "connected"), false);
  assert.equal(canTransition("gcp", "awaiting_customer", "connected"), false);
  assert.equal(canTransition("onprem", "draft", "connected"), true);
  assert.equal(canTransition("onprem", "awaiting_customer", "connected"), true);
  assert.equal(canTransition("aws", "verifying", "connected"), true);
});

test("nextAfterPeriodic: 연속 실패 3번이면 unstable, 성공이면 0으로", () => {
  assert.equal(UNSTABLE_AFTER_FAILURES, 3);
  assert.deepEqual(nextAfterPeriodic("connected", 1, false, false), { status: "connected", failures: 2 });
  assert.deepEqual(nextAfterPeriodic("connected", 2, false, false), { status: "unstable", failures: 3 });
  assert.deepEqual(nextAfterPeriodic("unstable", 3, true, false), { status: "connected", failures: 0 });
  assert.deepEqual(nextAfterPeriodic("connected", 0, false, true), { status: "disconnected", failures: 0 });
});

test("checkAccountId: 제공자별 모양", () => {
  assert.equal(checkAccountId("aws", "12345678901"), false);
  assert.equal(checkAccountId("aws", "123456789012"), true);
  assert.equal(checkAccountId("gcp", "my-project-01"), true);
  assert.equal(checkAccountId("gcp", "My_Project"), false);
  assert.equal(checkAccountId("onprem", "anything"), false);
  assert.equal(checkAccountId("azure_mock", "123456789012"), false);
});

test("ConnectionLink: url·command 둘 다 없으면 거부, 하나면 통과", () => {
  const exp = "2026-11-04T00:00:00Z";
  assert.equal(ConnectionLink.safeParse({ kind: "aws_quick_create", expiresAt: exp }).success, false);
  assert.equal(ConnectionLink.safeParse({ kind: "aws_quick_create", url: "https://console.aws.amazon.com/x",
    externalId: "abc", expiresAt: exp }).success, true);
  assert.equal(ConnectionLink.safeParse({ kind: "onprem_install", command: "curl -sSL x | sh", expiresAt: exp }).success, true);
  assert.equal(ConnectionLink.safeParse({ kind: "nope", command: "x", expiresAt: exp }).success, false);
});

test("CreateEnvironmentBody·VerifyBody·ConnectionFailure 모양", () => {
  assert.equal(CreateEnvironmentBody.safeParse({ provider: "aws", name: " shop ", region: "ap-northeast-2" }).success, true);
  assert.equal(CreateEnvironmentBody.safeParse({ provider: "azure_mock", name: "m" }).success, true);
  assert.equal(CreateEnvironmentBody.safeParse({ provider: "aws", name: "   " }).success, false);
  assert.equal(CreateEnvironmentBody.safeParse({ provider: "aws", name: "x", extra: 1 }).success, false);
  assert.equal(VerifyBody.safeParse({ accountId: "123456789012" }).success, true);
  assert.equal(VerifyBody.safeParse({}).success, false);
  assert.equal(ConnectionFailure.safeParse("ROLE_NOT_FOUND").success, true);
  assert.equal(ConnectionFailure.safeParse("WRONG_ACCOUNT").success, false);
});

test("verify-connection 작업은 reason 필수, security-scan은 그대로", () => {
  const base = { tenantId: "11111111-1111-4111-8111-111111111111", requestId: "r",
    envId: "22222222-2222-4222-8222-222222222222" };
  assert.equal(JOB_SCHEMAS["verify-connection"].safeParse(base).success, false);
  assert.equal(JOB_SCHEMAS["verify-connection"].safeParse({ ...base, reason: "user" }).success, true);
  assert.equal(JOB_SCHEMAS["verify-connection"].safeParse({ ...base, reason: "other" }).success, false);
  assert.equal(JOB_SCHEMAS["security-scan"].safeParse(base).success, true);
  assert.equal(JOB_SCHEMAS["security-scan"].safeParse({ ...base, reason: "user" }).success, false);
});
