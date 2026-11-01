import { test } from "node:test";
import assert from "node:assert/strict";
import { awsRegion, gcpRegion, onpremContext, maskAccount, scrubAccountIds, CliError } from "../src/common/cli.js";

// Z104 04: .env 의 빈 줄(`AWS_REGION=`)은 설정 안 함 → 기본값 (빈 --region 으로 CLI 를 부르지 않음)
test("빈 값이면 리전·컨텍스트 기본값", () => {
  assert.equal(awsRegion({ AWS_REGION: "", AWS_DEFAULT_REGION: "" }), "ap-northeast-2");
  assert.equal(awsRegion({ AWS_REGION: "", AWS_DEFAULT_REGION: "us-east-1" }), "us-east-1");
  assert.equal(awsRegion({ AWS_REGION: "eu-west-1" }), "eu-west-1");
  assert.equal(gcpRegion({ GCP_REGION: "" }), "asia-northeast3");
  assert.equal(onpremContext({ ONPREM_KUBE_CONTEXT: "" }), "k3d-onprem");
  assert.equal(onpremContext({ ONPREM_KUBE_CONTEXT: "k3d-x" }), "k3d-x");
});

// Z104 03: 계정 번호 12자리는 끝 4자리만 (R8-46)
test("계정 번호 가림: 값·오류 글·CliError 메시지", () => {
  assert.equal(maskAccount("123456789012"), "••••9012");
  assert.equal(maskAccount(null), "?");
  assert.equal(scrubAccountIds("arn:aws:iam::123456789012:role/x 1234"), "arn:aws:iam::••••9012:role/x 1234");
  const e = new CliError("aws", ["sts"], 254, "User: arn:aws:iam::123456789012:user/x is not authorized");
  assert.doesNotMatch(e.message, /123456789012/);
  assert.match(e.stderr, /123456789012/, "원문 stderr 는 판정용으로 그대로 (화면에는 message 만)");
});
