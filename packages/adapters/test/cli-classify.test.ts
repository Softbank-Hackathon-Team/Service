// L5fix: CLI 오류 분류(일시 / 거부 / 그 밖)와 discover 가 던지는 오류 코드
import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError, classifyCliError, discoverOnprem, discoverAws, isAdapterError } from "../src/index.js";

const err = (stderr: string, code = 1) => new CliError("kubectl", ["get", "nodes"], code, stderr);

test("일시 3종 이상은 transient", () => {
  for (const s of [
    "Unable to connect to the server: dial tcp 10.0.0.1:443: connect: connection refused",
    "Unable to connect to the server: net/http: TLS handshake timeout",
    "Unable to connect to the server: dial tcp 1.2.3.4:443: i/o timeout",
    "Could not connect to the endpoint URL: \"https://eks.ap-northeast-2.amazonaws.com/clusters\"",
    "error: context deadline exceeded",
    "\n[z70] timeout 20000ms → SIGINT",
    "An error occurred (ThrottlingException) when calling the ListClusters operation: Rate exceeded",
  ]) assert.equal(classifyCliError(err(s)), "transient", s);
});

test("거부 2종 이상은 denied (연결 실패 문구가 섞여도 거부가 우선)", () => {
  for (const s of [
    'Error from server (Forbidden): deployments.apps is forbidden: User "x" cannot list resource "deployments"',
    "error: You must be logged in to the server (Unauthorized)",
    "An error occurred (AccessDenied) when calling the DescribeCluster operation",
    "Unable to connect to the server: x509: certificate signed by unknown authority",
    "Unable to locate credentials. You can configure credentials by running \"aws configure\".",
  ]) assert.equal(classifyCliError(err(s)), "denied", s);
});

test("그 밖: 명령 없음(127)·모르는 문구·CliError 아님은 other", () => {
  assert.equal(classifyCliError(err("not found", 127)), "other");
  assert.equal(classifyCliError(err("error: the server doesn't have a resource type \"foo\"")), "other");
  assert.equal(classifyCliError(new Error("connection refused")), "other");
});

const failExec = (stderr: string) => async () => ({ code: 1, stdout: "", stderr, ms: 1 });

test("discover(온프레): 노드 조회가 연결 거부 → SOURCE_TRANSIENT, Forbidden → SOURCE_UNAVAILABLE (재시도 여부가 갈림)", async () => {
  const t = await discoverOnprem({ exec: failExec("Unable to connect to the server: dial tcp: connection refused"), env: {} }).catch((e) => e);
  assert.ok(isAdapterError(t)); assert.equal(t.code, "SOURCE_TRANSIENT");
  const f = await discoverOnprem({ exec: failExec('Error from server (Forbidden): nodes is forbidden'), env: {} }).catch((e) => e);
  assert.ok(isAdapterError(f)); assert.equal(f.code, "SOURCE_UNAVAILABLE");
});

test("discover(aws): 자격 증명 확인이 endpoint 연결 실패 → SOURCE_TRANSIENT, 자격 없음 → SOURCE_UNAVAILABLE", async () => {
  const t = await discoverAws({ exec: failExec("Could not connect to the endpoint URL: https://sts.amazonaws.com/"), env: {} }).catch((e) => e);
  assert.equal(t.code, "SOURCE_TRANSIENT");
  const f = await discoverAws({ exec: failExec("Unable to locate credentials."), env: {} }).catch((e) => e);
  assert.equal(f.code, "SOURCE_UNAVAILABLE");
});
