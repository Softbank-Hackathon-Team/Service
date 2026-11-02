// VL5fix: CLI 오류 분류 경계 (일시 / 거부 / 그 밖). 문구 표, 대소문자, 여러 줄 stderr, 이름 속 낱말 오탐
import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError, classifyCliError } from "../src/index.js";

const err = (stderr: string, code = 1, bin = "kubectl") => new CliError(bin, ["get", "nodes"], code, stderr);
type K = "transient" | "denied" | "other";
const TABLE: Array<[K, string]> = [
  // 일시
  ["transient", "Unable to connect to the server: dial tcp 10.0.0.1:6443: connect: connection refused"],
  ["transient", "read tcp 10.0.0.2:5555->10.0.0.1:6443: read: connection reset by peer"],
  ["transient", "Unable to connect to the server: net/http: TLS handshake timeout"],
  ["transient", "Unable to connect to the server: dial tcp: lookup api.example.internal: no such host"],
  ["transient", "Unable to connect to the server: dial tcp 1.2.3.4:443: i/o timeout"],
  ["transient", "Could not connect to the endpoint URL: \"https://eks.ap-northeast-2.amazonaws.com/clusters\""],
  ["transient", "error: context deadline exceeded"],
  ["transient", "Unable to connect to the server: unexpected EOF"],
  ["transient", "Error from server (ServiceUnavailable): the server is currently unable to handle the request"],
  ["transient", "An error occurred (ThrottlingException) when calling the ListClusters operation (reached max retries: 2): Rate exceeded"],
  ["transient", "Error from server (TooManyRequests): too many requests, please try again later"],
  ["transient", "Temporary failure in name resolution"],
  ["transient", "Error from server: etcdserver: request timed out"],
  ["transient", "UNABLE TO CONNECT TO THE SERVER: CONNECTION REFUSED"],
  ["transient", "error: HTTP status 503"],
  // 거부
  ["denied", "Error from server (Forbidden): deployments.apps is forbidden: User \"u\" cannot list resource \"deployments\" in API group \"apps\""],
  ["denied", "error: You must be logged in to the server (Unauthorized)"],
  ["denied", "An error occurred (AccessDenied) when calling the DescribeCluster operation: User is not authorized to perform: eks:DescribeCluster"],
  ["denied", "Unable to connect to the server: x509: certificate signed by unknown authority"],
  ["denied", "Unable to locate credentials. You can configure credentials by running \"aws configure\"."],
  ["denied", "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired"],
  ["denied", "An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation"],
  ["denied", "ERROR: (gcloud.container.clusters.list) PERMISSION_DENIED: Access Denied"],
  ["denied", "FORBIDDEN"],
  // 그 밖
  ["other", "error: the server doesn't have a resource type \"foo\""],
  ["other", "Error from server (NotFound): namespaces \"shop\" not found"],
  ["other", "error: unknown command \"gett\" for \"kubectl\""],
  ["other", ""],
  ["other", "응답 JSON 해석 실패: Unexpected token"],
];

test("문구 표 30개: 일시 / 거부 / 그 밖", () => {
  for (const [want, s] of TABLE) assert.equal(classifyCliError(err(s)), want, s);
  assert.ok(TABLE.length >= 20);
});

test("여러 줄 stderr: 마지막 줄만 보지 않고 전체를 본다 (거부 문구가 앞줄에 있어도 거부, 일시 문구가 앞줄에 있어도 일시)", () => {
  assert.equal(classifyCliError(err("E1102 reflector.go: Failed to watch\nUnable to connect to the server: connection refused\nerror: exit status 1")), "transient");
  assert.equal(classifyCliError(err("Error from server (Forbidden): pods is forbidden\nerror: giving up after 3 attempts")), "denied");
  assert.equal(classifyCliError(err("Unable to connect to the server: dial tcp: i/o timeout\nx509: certificate has expired")), "denied", "거부가 우선");
  assert.equal(classifyCliError(err("\n\n  \n")), "other");
});

test("명령 없음(127)은 문구와 상관없이 other, CliError 가 아니면 other, 다른 bin 도 같은 규칙", () => {
  assert.equal(classifyCliError(err("connection refused", 127)), "other");
  assert.equal(classifyCliError(new Error("connection refused")), "other");
  assert.equal(classifyCliError(null), "other");
  assert.equal(classifyCliError(undefined), "other");
  assert.equal(classifyCliError(err("Rate exceeded", 1, "aws")), "transient");
  assert.equal(classifyCliError(err("PERMISSION_DENIED: forbidden", 1, "gcloud")), "denied");
});

test("오탐 방지: 리소스 이름 속 낱말(timeout·502·certificate)은 분류에 영향 없음", () => {
  assert.equal(classifyCliError(err('Error from server (NotFound): deployments.apps "timeout-svc" not found')), "other");
  assert.equal(classifyCliError(err('Error from server (NotFound): pods "app-502" not found')), "other");
  assert.equal(classifyCliError(err('Error from server (NotFound): secrets "certificate-store" not found')), "other");
  assert.equal(classifyCliError(err('Error from server (NotFound): namespaces "connection-refused-demo" not found')), "other");
});
