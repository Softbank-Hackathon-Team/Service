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

test("ExternalId: 64자 hex (실측 hotfix: base64url 의 _ 가 템플릿 패턴에 걸림), 매번 다름, 힌트는 앞 4자", () => {
  const a = newExternalId(), b = newExternalId();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(externalIdHint(a), a.slice(0, 4));
});

test("연결 설정: 둘 다 있어야 하고, 하나라도 비면 null", () => {
  assert.equal(connectSettings({}), null);
  assert.equal(connectSettings({ CONNECT_TEMPLATE_URL: "https://x", PLATFORM_PRINCIPAL_ARN: " " }), null);
  assert.deepEqual(connectSettings({ CONNECT_TEMPLATE_URL: "https://x", PLATFORM_PRINCIPAL_ARN: "arn:a" }),
    { templateUrl: "https://x", principalArn: "arn:a" });
});

// F17: 같은 계정에 platform-app-boundary 가 이미 있으면 링크가 템플릿에 "만들지 마"를 넘긴다
import { shouldCreateBoundary, principalAccount } from "../src/connect/link.js";
test("F17 정상: 이미 있다고 알리거나 고객 계정 = 플랫폼 계정이면 CreateBoundaryPolicy=false 가 링크에 붙는다", () => {
  assert.equal(principalAccount(base.principalArn), "111122223333");
  assert.equal(shouldCreateBoundary({ boundaryPolicyExists: true, principalArn: base.principalArn }), false);
  assert.equal(shouldCreateBoundary({ envAccountId: "111122223333", principalArn: base.principalArn }), false);
  const u = awsQuickCreateUrl({ ...base, createBoundaryPolicy: false });
  assert.ok(u.includes("param_CreateBoundaryPolicy=false"));
});
test("F17 거부: 모르거나 다른 계정이면 템플릿 기본(만듦), 링크에 파라미터 없음", () => {
  assert.equal(shouldCreateBoundary({ principalArn: base.principalArn }), true);
  assert.equal(shouldCreateBoundary({ envAccountId: "999988887777", principalArn: base.principalArn }), true);
  assert.equal(shouldCreateBoundary({ boundaryPolicyExists: false, envAccountId: null, principalArn: "not-an-arn" }), true);
  assert.ok(!awsQuickCreateUrl({ ...base, createBoundaryPolicy: true }).includes("CreateBoundaryPolicy"));
  assert.ok(!awsQuickCreateUrl(base).includes("CreateBoundaryPolicy"));
});

// ID-1: Argo 허브 역할은 설정에 있을 때만 링크에 들어간다
test("ID-1: ARGO_HUB_ROLE_ARN 이 역할 ARN 이면 링크에 param_ArgoHubRoleArn, 없거나 이상하면 안 들어감", () => {
  const env = { CONNECT_TEMPLATE_URL: base.templateUrl, PLATFORM_PRINCIPAL_ARN: base.principalArn };
  const ok = connectSettings({ ...env, ARGO_HUB_ROLE_ARN: "arn:aws:iam::111122223333:role/argocd-hub" })!;
  assert.equal(ok.argoHubRoleArn, "arn:aws:iam::111122223333:role/argocd-hub");
  assert.ok(awsQuickCreateUrl({ ...base, argoHubRoleArn: ok.argoHubRoleArn }).includes(`param_ArgoHubRoleArn=${encodeURIComponent(ok.argoHubRoleArn!)}`));
  assert.equal(connectSettings({ ...env, ARGO_HUB_ROLE_ARN: "arn:aws:iam::111122223333:user/x" })!.argoHubRoleArn, undefined);
  assert.equal(connectSettings(env)!.argoHubRoleArn, undefined);
  assert.ok(!awsQuickCreateUrl(base).includes("ArgoHubRoleArn"));
});

// 실측 hotfix (connect CreateStack ValidationError): 만든 ExternalId 가 템플릿 AllowedPattern·MinLength 를 언제나 통과해야 한다
import { readFileSync } from "node:fs";
test("ExternalId: 여러 번 만들어도 전부 템플릿 패턴(새·예전 둘 다)·최소 길이 통과", () => {
  const tpl = JSON.parse(readFileSync(new URL("../../../infra/onboarding/aws-connect.json", import.meta.url), "utf8"));
  const p = tpl.Parameters.ExternalId as { AllowedPattern: string; MinLength: number };
  const now = new RegExp(p.AllowedPattern), old = /^[A-Za-z0-9+=,.@:/-]+$/;   // old = S3 에 아직 올라가 있을 수 있는 예전 패턴
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const id = newExternalId();
    assert.match(id, now); assert.match(id, old);
    assert.ok(id.length >= p.MinLength && id.length <= 1224, `길이 ${id.length}`);
    seen.add(id);
  }
  assert.equal(seen.size, 2000, "겹침 없음");
});

test("거부: 템플릿 패턴은 빈칸·따옴표 같은 문자를 막고, _ 는 받는다", () => {
  const tpl = JSON.parse(readFileSync(new URL("../../../infra/onboarding/aws-connect.json", import.meta.url), "utf8"));
  const re = new RegExp(tpl.Parameters.ExternalId.AllowedPattern as string);
  assert.ok(re.test("abc_DEF-123"));
  for (const bad of ["a b", "a\"b", "a;b", ""]) assert.ok(!re.test(bad), bad);
});

// 한 계정에 환경 여럿 (0056): 새 환경은 param_RoleSuffix=-<환경 8자> (= 스택 이름 꼬리), 옛 환경(NULL)은 매개변수 없음 → 템플릿 기본 "" = 예전 이름
test("RoleSuffix: 꼬리가 있으면 param_RoleSuffix 로 넘기고 스택 이름과 같은 8자, 없거나 모양이 틀리면 안 넘김", async () => {
  const { awsRoleSuffixFor } = await import("@svc/contracts");
  const suffix = awsRoleSuffixFor(base.envId);
  assert.equal(suffix, "-0f1e2d3c");
  const u = awsQuickCreateUrl({ ...base, roleSuffix: suffix });
  assert.ok(u.includes("param_RoleSuffix=-0f1e2d3c"));
  assert.equal(stackNameFor(base.envId).replace("svc-connect", ""), suffix, "스택 이름 꼬리 = 역할 이름 꼬리");
  for (const old of [undefined, null, "", "0f1e2d3c", "-0F1E2D3C", "-x&param_ExternalId=evil"])
    assert.ok(!awsQuickCreateUrl({ ...base, roleSuffix: old }).includes("param_RoleSuffix"), String(old));
});
