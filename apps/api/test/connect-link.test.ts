// 입력층 L2: 연결 링크 문자열 (순수 함수, DB 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { awsQuickCreateUrl, stackNameFor, newExternalId, externalIdHint, connectSettings } from "../src/connect/link.js";

const base = {
  envId: "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b",
  templateUrl: "https://bucket.s3.ap-northeast-2.amazonaws.com/onboarding/aws-connect.json?v=1&x=y",
  principalArn: "arn:aws:iam::111122223333:role/svc-worker",
  externalId: "abc_DEF-123",
  clusterName: "shop eks",
};

test("AWS 빠른 생성 링크: 파라미터 이름·인코딩·기본 리전", () => {
  const u = awsQuickCreateUrl(base);
  assert.ok(u.startsWith("https://ap-northeast-2.console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks/create/review?"));
  assert.ok(u.includes(`templateURL=${encodeURIComponent(base.templateUrl)}`));
  assert.ok(!u.includes("v=1&x=y"), "템플릿 주소 안의 & 가 그대로 새면 안 된다");
  assert.ok(u.includes("param_ExternalId=abc_DEF-123"));
  assert.ok(u.includes(`param_PlatformPrincipalArn=${encodeURIComponent(base.principalArn)}`));
  assert.ok(u.includes("param_EksClusterName=shop%20eks"));
  assert.ok(u.includes("stackName=svc-connect-0f1e2d3c"));
});

test("AWS 빠른 생성 링크: region 을 주면 그 리전, 공백이면 기본", () => {
  assert.ok(awsQuickCreateUrl({ ...base, region: "us-east-1" }).startsWith("https://us-east-1.console.aws.amazon.com/"));
  assert.ok(awsQuickCreateUrl({ ...base, region: "  " }).startsWith("https://ap-northeast-2."));
});

test("스택 이름: 영문 시작, 128자 이하, 허용 글자만", () => {
  for (const id of [base.envId, "ffffffff-ffff-4fff-8fff-ffffffffffff"]) {
    const n = stackNameFor(id);
    assert.match(n, /^[A-Za-z][A-Za-z0-9-]{0,127}$/);
  }
});

test("ExternalId: 43자 base64url, 매번 다름, 힌트는 앞 4자", () => {
  const a = newExternalId(), b = newExternalId();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(externalIdHint(a), a.slice(0, 4));
});

test("연결 설정: 둘 다 있어야 하고, 하나라도 비면 null", () => {
  assert.equal(connectSettings({}), null);
  assert.equal(connectSettings({ CONNECT_TEMPLATE_URL: "https://x", PLATFORM_PRINCIPAL_ARN: " " }), null);
  assert.deepEqual(connectSettings({ CONNECT_TEMPLATE_URL: "https://x", PLATFORM_PRINCIPAL_ARN: "arn:a" }),
    { templateUrl: "https://x", principalArn: "arn:a" });
});
