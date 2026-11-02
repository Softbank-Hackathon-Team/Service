// VL1: L1 계약의 경계값·거부 경로 보강 (DB 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConnectionStatus, canTransition, nextAfterPeriodic, checkAccountId, ConnectionLink, CreateEnvironmentBody, VerifyBody, JOB_SCHEMAS,
} from "../src/index.js";

test("CreateEnvironmentBody: 이름 64자는 통과·65자는 거부, region 32/33, clusterName 100/101", () => {
  const ok = (o: object) => CreateEnvironmentBody.safeParse({ provider: "aws", name: "n", ...o }).success;
  assert.equal(ok({ name: "a".repeat(64) }), true);
  assert.equal(ok({ name: "a".repeat(65) }), false);
  assert.equal(ok({ region: "r".repeat(32) }), true);
  assert.equal(ok({ region: "r".repeat(33) }), false);
  assert.equal(ok({ clusterName: "c".repeat(100) }), true);
  assert.equal(ok({ clusterName: "c".repeat(101) }), false);
  assert.equal(CreateEnvironmentBody.parse({ provider: "aws", name: "  shop  " }).name, "shop", "앞뒤 공백 정리");
  assert.equal(CreateEnvironmentBody.safeParse({ provider: "aws" }).success, false, "이름 필수");
  assert.equal(CreateEnvironmentBody.safeParse({ provider: "heroku", name: "x" }).success, false);
});

test("checkAccountId: AWS 12자리 숫자만, GCP 프로젝트 ID 6~30자 경계", () => {
  assert.equal(checkAccountId("aws", "1234567890123"), false);
  assert.equal(checkAccountId("aws", "12345678901a"), false);
  assert.equal(checkAccountId("aws", " 123456789012"), false);
  assert.equal(checkAccountId("aws", "123456789012\n"), false, "끝 줄바꿈 거부");
  assert.equal(checkAccountId("gcp", "abcde"), false, "5자");
  assert.equal(checkAccountId("gcp", "abcdef"), true, "6자");
  assert.equal(checkAccountId("gcp", "a" + "b".repeat(28) + "c"), true, "30자");
  assert.equal(checkAccountId("gcp", "a" + "b".repeat(29) + "c"), false, "31자");
  assert.equal(checkAccountId("gcp", "1abcdef"), false, "숫자로 시작");
  assert.equal(checkAccountId("gcp", "abcdef-"), false, "하이픈으로 끝남");
  assert.equal(VerifyBody.safeParse({ accountId: "1", extra: 1 }).success, false, "strict");
});

test("ConnectionLink: strict(모르는 칸 거부), url 형식 검사", () => {
  const exp = "2026-11-04T00:00:00Z";
  assert.equal(ConnectionLink.safeParse({ kind: "aws_quick_create", url: "not a url", expiresAt: exp }).success, false);
  assert.equal(ConnectionLink.safeParse({ kind: "gcp_cloud_shell", command: "x", expiresAt: exp, secret: "s" }).success, false);
  assert.equal(ConnectionLink.safeParse({ kind: "gcp_cloud_shell", command: "x" }).success, false, "expiresAt 필수");
});

test("전이: 자기 자신으로 가기는 connected·unstable·awaiting_customer 만, 나머지는 거부 (aws)", () => {
  const selfOk = ConnectionStatus.options.filter((s) => canTransition("aws", s, s));
  assert.deepEqual([...selfOk].sort(), ["awaiting_customer", "connected", "unstable"]);
  assert.equal(canTransition("azure_mock", "awaiting_customer", "connected"), false);
  assert.equal(canTransition("gcp", "draft", "connected"), false);
  assert.equal(canTransition("onprem", "awaiting_customer", "connected"), true);
  assert.equal(canTransition("onprem", "failed", "connected"), false, "failed → connected 는 온프레도 안 됨");
});

test("nextAfterPeriodic: 경계 — 2번째 실패는 connected 유지, roleGone 이 실패 수 초과보다 우선, 성공 시 unstable 만 connected 로", () => {
  assert.deepEqual(nextAfterPeriodic("connected", 0, false, false), { status: "connected", failures: 1 });
  assert.deepEqual(nextAfterPeriodic("unstable", 5, false, false), { status: "unstable", failures: 6 });
  assert.deepEqual(nextAfterPeriodic("connected", 2, false, true), { status: "disconnected", failures: 2 });
  assert.deepEqual(nextAfterPeriodic("connected", 4, true, false), { status: "connected", failures: 0 });
});

test("verify-connection 작업: 필수 칸 빠짐·uuid 아님 거부", () => {
  const s = JOB_SCHEMAS["verify-connection"];
  const good = { tenantId: "11111111-1111-4111-8111-111111111111", requestId: "r", envId: "22222222-2222-4222-8222-222222222222", reason: "periodic" };
  assert.equal(s.safeParse(good).success, true);
  assert.equal(s.safeParse({ ...good, envId: "nope" }).success, false);
  const { requestId: _r, ...noReq } = good;
  assert.equal(s.safeParse(noReq).success, false);
});
