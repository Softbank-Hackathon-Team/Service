// 고객 AWS 연결 템플릿(infra/onboarding/aws-connect.json) 시험. JSON.parse만 쓴다(새 의존성 0).
// 클라우드 호출(validate-template 등)은 하지 않는다 — 모양과 권한 범위만 고정
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAwsConnectTemplate, OBSERVE_ROLE_NAME, OPERATE_ROLE_NAME, VIEW_ONLY_ARN } from "../scripts/aws-connect-template.js";

const root = new URL("../../../infra/", import.meta.url);
const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, root), "utf8"));
const load = () => readJson("onboarding/aws-connect.json");

type J = any; // JSON 구조 시험이라 느슨하게 (경계 타입 아님)
const arr = (x: unknown): string[] => (Array.isArray(x) ? x : [x]) as string[];
const TRUST_ACTIONS = ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"];

// 템플릿 검사 함수: 문제 목록을 돌려준다(빈 배열 = 통과)
function checkTemplate(t: J): string[] {
  const bad: string[] = [];
  const names = [OBSERVE_ROLE_NAME, OPERATE_ROLE_NAME];
  for (const key of ["ObserveRole", "OperateRole"]) {
    const props = t.Resources?.[key]?.Properties;
    if (!names.includes(props?.RoleName)) bad.push(`${key}: 역할 이름`);
    for (const s of props?.AssumeRolePolicyDocument?.Statement ?? []) {
      const p = s.Principal?.AWS;
      if (JSON.stringify(p) !== JSON.stringify({ Ref: "PlatformPrincipalArn" })) bad.push(`${key}: Principal이 파라미터 참조가 아님`);
      if (JSON.stringify(s).includes(":root")) bad.push(`${key}: :root`);
      if (JSON.stringify([...arr(s.Action)].sort()) !== JSON.stringify([...TRUST_ACTIONS].sort())) bad.push(`${key}: 신뢰 Action`);
      if (JSON.stringify(s.Condition?.StringEquals?.["sts:ExternalId"]) !== JSON.stringify({ Ref: "ExternalId" })) bad.push(`${key}: ExternalId 조건`);
    }
  }
  return bad;
}

test("정상: 역할 2개 이름·신뢰 정책(Action 3개·ExternalId·Principal 파라미터)", () => {
  const t = load();
  assert.equal(t.Resources.ObserveRole.Properties.RoleName, "svc-observe");
  assert.equal(t.Resources.OperateRole.Properties.RoleName, "svc-operate");
  assert.deepEqual(checkTemplate(t), []);
  assert.equal(t.Resources.ObserveRole.Properties.MaxSessionDuration, 3600);
  assert.equal(t.Resources.OperateRole.Properties.MaxSessionDuration, 3600);
});

test("파라미터: ExternalId는 NoEcho 아님·32자 이상, 주체는 역할 ARN만", () => {
  const p = load().Parameters;
  assert.equal(p.ExternalId.NoEcho, undefined);
  assert.ok(p.ExternalId.MinLength >= 32);
  assert.ok(p.EksClusterName.MinLength >= 1);
  assert.equal(p.CreateBoundaryPolicy.Default, "true");
  const re = new RegExp(p.PlatformPrincipalArn.AllowedPattern);
  assert.ok(re.test("arn:aws:iam::123456789012:role/platform-worker"));
  assert.ok(!re.test("arn:aws:iam::123456789012:root"));
  assert.ok(!re.test("arn:aws:iam::123456789012:user/someone"));
});

test("관찰 역할: 관리형은 ViewOnlyAccess 하나, 인라인에 금지 동작 0·쓰기 0", () => {
  const props = load().Resources.ObserveRole.Properties;
  assert.deepEqual(props.ManagedPolicyArns, [VIEW_ONLY_ARN]);
  assert.equal(props.Policies.length, 1);
  const stmts = props.Policies[0].PolicyDocument.Statement;
  const actions = stmts.flatMap((s: J) => arr(s.Action));
  const forbidden = [/^secretsmanager:GetSecretValue$/, /^ssm:GetParameter/, /^s3:GetObject/, /^kms:Decrypt$/, /\*$/, /^\*$/];
  for (const a of actions) assert.ok(!forbidden.some((r) => r.test(a)), `금지 동작 ${a}`);
  // 쓰기 동사(Create/Put/Update/Delete/Attach/Pass...) 0 — 읽기 동사만
  for (const a of actions) assert.match(a, /:(Describe|Get|List)/, `읽기 아님 ${a}`);
  for (const a of ["guardduty:ListDetectors", "guardduty:GetDetector", "guardduty:ListFindings", "guardduty:GetFindings", "guardduty:GetFindingsStatistics"])
    assert.ok(actions.includes(a), a);
  for (const s of stmts) assert.equal(s.Effect, "Allow");
});

test("실행 역할: 정책 문서가 infra/permissions와 같고 권한 경계 없음", () => {
  const t = load();
  assert.deepEqual(t.Resources.OperatePolicy.Properties.PolicyDocument, readJson("permissions/aws-operate-role-policy.json"));
  assert.deepEqual(t.Resources.BoundaryPolicy.Properties.PolicyDocument, readJson("permissions/aws-app-role-boundary.json"));
  assert.equal(t.Resources.BoundaryPolicy.Properties.ManagedPolicyName, "platform-app-boundary");
  assert.equal(t.Resources.BoundaryPolicy.Condition, "CreateBoundary");
  assert.equal(t.Resources.OperateRole.Properties.PermissionsBoundary, undefined);
  assert.deepEqual(t.Resources.OperateRole.Properties.ManagedPolicyArns, [{ Ref: "OperatePolicy" }]);
});

test("생성기와 동기: 정책 두 개로 다시 만든 템플릿 == 파일", () => {
  const rebuilt = buildAwsConnectTemplate(readJson("permissions/aws-operate-role-policy.json"), readJson("permissions/aws-app-role-boundary.json"));
  assert.deepEqual(load(), JSON.parse(JSON.stringify(rebuilt)));
});

test("EKS 접근 항목 2개·출력 2개", () => {
  const t = load();
  assert.equal(t.Resources.ObserveAccess.Type, "AWS::EKS::AccessEntry");
  assert.equal(t.Resources.OperateAccess.Type, "AWS::EKS::AccessEntry");
  assert.deepEqual(t.Resources.OperateAccess.Properties.KubernetesGroups, ["platform:operate"]);
  assert.equal(t.Resources.OperateAccess.Properties.AccessPolicies, undefined);
  assert.deepEqual(Object.keys(t.Outputs).sort(), ["ObserveRoleArn", "OperateRoleArn"]);
});

test("거부: Principal에 :root를 넣은 사본은 검사 함수가 거부", () => {
  const t = load();
  t.Resources.OperateRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal = { AWS: "arn:aws:iam::123456789012:root" };
  assert.ok(checkTemplate(t).length > 0);
});

test("거부: 신뢰 Action에서 TagSession이 빠진 사본은 거부", () => {
  const t = load();
  t.Resources.ObserveRole.Properties.AssumeRolePolicyDocument.Statement[0].Action = ["sts:AssumeRole"];
  assert.ok(checkTemplate(t).some((m) => m.includes("신뢰 Action")));
});
