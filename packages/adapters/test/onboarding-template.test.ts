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
      // FM-CON-06/08: AssumeRole 문장만 ExternalId 조건, TagSession·SetSourceIdentity 문장은 조건 없음 (한 문장에 두면 실 AWS 가 거부)
      const acts = arr(s.Action);
      if (acts.includes("sts:AssumeRole")) {
        if (acts.length !== 1) bad.push(`${key}: AssumeRole 문장에 다른 동작이 섞임`);
        if (JSON.stringify(s.Condition?.StringEquals?.["sts:ExternalId"]) !== JSON.stringify({ Ref: "ExternalId" })) bad.push(`${key}: ExternalId 조건`);
      } else {
        if (JSON.stringify([...acts].sort()) !== JSON.stringify(["sts:SetSourceIdentity", "sts:TagSession"])) bad.push(`${key}: 세션 동작 문장`);
        if (s.Condition !== undefined) bad.push(`${key}: 세션 동작 문장에 조건`);
      }
    }
    const all = (props?.AssumeRolePolicyDocument?.Statement ?? []).flatMap((s: J) => arr(s.Action));
    if (JSON.stringify([...all].sort()) !== JSON.stringify([...TRUST_ACTIONS].sort())) bad.push(`${key}: 신뢰 Action`);
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
  assert.ok(re.test("arn:aws:iam::123456789012:user/someone"));   // PRINCIPALUSER: 사용자 키 계정도 받음
});

test("관찰 역할: 관리형은 ViewOnlyAccess 하나, 인라인에 금지 동작 0·쓰기 0", () => {
  const props = load().Resources.ObserveRole.Properties;
  assert.deepEqual(props.ManagedPolicyArns, [VIEW_ONLY_ARN]);
  // PERM-GATE: 인라인 둘 = 읽기(observe-extra) + 흉내 평가(observe-permcheck: iam:SimulatePrincipalPolicy 하나, 이 계정 svc-* 역할만. 정책을 읽어 판정만 돌려준다)
  assert.deepEqual(props.Policies.map((p: J) => p.PolicyName), ["observe-extra", "observe-permcheck"]);
  assert.deepEqual(props.Policies[1].PolicyDocument.Statement, [{ Effect: "Allow", Action: ["iam:SimulatePrincipalPolicy"],
    Resource: { "Fn::Join": ["", ["arn:aws:iam::", { Ref: "AWS::AccountId" }, ":role/svc-*"]] } }]);
  const stmts = props.Policies[0].PolicyDocument.Statement;
  const actions = stmts.flatMap((s: J) => arr(s.Action));
  const forbidden = [/^secretsmanager:GetSecretValue$/, /^ssm:GetParameter/, /^s3:GetObject/, /^kms:Decrypt$/, /\*$/, /^\*$/];
  for (const a of actions) assert.ok(!forbidden.some((r) => r.test(a)), `금지 동작 ${a}`);
  // 쓰기 동사(Create/Put/Update/Delete/Attach/Pass...) 0 — 읽기 동사만
  for (const a of actions) assert.match(a, /:(Describe|Get|List|BatchGet)/, `읽기 아님 ${a}`);
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
  // ID-1: 배포 역할 출력은 ArgoHubRoleArn 을 줄 때만 (Condition HasArgoHub)
  assert.deepEqual(Object.keys(t.Outputs).sort(), ["DeployRoleArn", "ObserveRoleArn", "OperateRoleArn"]);
  assert.equal(t.Outputs.DeployRoleArn.Condition, "HasArgoHub");
});

// ID-1: Argo CD 허브 배포 신원. 값이 있을 때만 만들고, IAM 권한 0 + k8s 그룹만(클러스터 범위 접근 정책 없음)
test("ID-1 정상: 배포 역할·접근 항목은 ArgoHubRoleArn 이 있을 때만, 그룹 platform:deploy 만, IAM 정책 없음", () => {
  const t = load();
  assert.equal(t.Parameters.ArgoHubRoleArn.Default, "");
  for (const k of ["DeployRole", "DeployAccess"]) assert.equal(t.Resources[k].Condition, "HasArgoHub", k);
  const role = t.Resources.DeployRole.Properties;
  assert.equal(role.RoleName, "svc-deploy");
  assert.equal(role.ManagedPolicyArns, undefined);
  assert.equal(role.Policies, undefined);
  // 신뢰 = 허브 역할 하나에게 AssumeRole, 같은 주체에게 TagSession 따로 (Pod Identity 세션 태그). 다른 주체·동작 없음
  assert.deepEqual(role.AssumeRolePolicyDocument.Statement.map((s: { Principal: unknown; Action: unknown; Effect: string }) => [s.Effect, s.Principal, s.Action]), [
    ["Allow", { AWS: { Ref: "ArgoHubRoleArn" } }, "sts:AssumeRole"],
    ["Allow", { AWS: { Ref: "ArgoHubRoleArn" } }, "sts:TagSession"],
  ]);
  assert.deepEqual(t.Resources.DeployAccess.Properties.KubernetesGroups, ["platform:deploy"]);
  assert.equal(t.Resources.DeployAccess.Properties.AccessPolicies, undefined);
});
test("ID-1 거부: ArgoHubRoleArn 패턴은 빈 값·역할 ARN 만 받고 사용자·:root 는 거부", () => {
  const re = new RegExp(load().Parameters.ArgoHubRoleArn.AllowedPattern);
  assert.ok(re.test(""));
  assert.ok(re.test("arn:aws:iam::123456789012:role/argocd-hub"));
  assert.ok(!re.test("arn:aws:iam::123456789012:root"));
  assert.ok(!re.test("arn:aws:iam::123456789012:user/x"));
});
test("ID-1: 배포 RBAC 은 ClusterRoleBinding 없음, Secret·RBAC 쓰기 없음, 실행 그룹 bind 는 platform-deploy-app 하나", () => {
  const rbac = readFileSync(new URL("permissions/eks-deploy-rbac.yaml", root), "utf8");
  assert.ok(!/kind:\s*ClusterRoleBinding/.test(rbac));
  assert.ok(!/"secrets"/.test(rbac) && !/rbac\.authorization/.test(rbac.replace(/^apiVersion:.*$/gm, "")));
  const op = readFileSync(new URL("permissions/eks-operate-namespace-rbac.yaml", root), "utf8");
  assert.match(op, /resourceNames: \["platform-deploy-app"\]\n\s+verbs: \["bind"\]/);
  assert.equal((op.match(/"bind"/g) ?? []).length, 1);
  // 울타리: 실행 그룹의 RoleBinding·네임스페이스 지우기를 managed-by=platform 으로 막는 내장 정책이 같이 있다
  assert.match(op, /kind: ValidatingAdmissionPolicy\n/);
  assert.match(op, /kind: ValidatingAdmissionPolicyBinding[\s\S]*validationActions: \["Deny"\]/);
  assert.match(op, /'platform:operate' in request.userInfo.groups/);
  for (const m of ["네임스페이스에만 RoleBinding", "platform-deploy-app 하나", "그룹 platform:deploy 만", "지우지 않는다", "새로 붙이지 않는다"]) assert.ok(op.includes(m), m);
});

test("거부: Principal에 :root를 넣은 사본은 검사 함수가 거부", () => {
  const t = load();
  t.Resources.OperateRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal = { AWS: "arn:aws:iam::123456789012:root" };
  assert.ok(checkTemplate(t).length > 0);
});

test("거부: 신뢰 Action에서 TagSession이 빠진 사본은 거부", () => {
  const t = load();
  t.Resources.ObserveRole.Properties.AssumeRolePolicyDocument.Statement[1].Action = ["sts:SetSourceIdentity"];
  assert.ok(checkTemplate(t).some((m) => m.includes("신뢰 Action")));
});

test("거부(FM-CON-06): 세 동작을 ExternalId 조건 한 문장에 다시 합친 사본은 거부 (실 AWS 가 TagSession·SetSourceIdentity 를 거부한 모양)", () => {
  const t = load();
  const st = t.Resources.OperateRole.Properties.AssumeRolePolicyDocument.Statement;
  t.Resources.OperateRole.Properties.AssumeRolePolicyDocument.Statement = [{ ...st[0], Action: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"] }];
  assert.ok(checkTemplate(t).some((m) => m.includes("AssumeRole 문장에 다른 동작")));
});

// FM-CON-08: 발급기(awsStsIssuer)가 AssumeRole 에 실제로 붙이는 것(Tags → sts:TagSession, SourceIdentity → sts:SetSourceIdentity)마다
//   신뢰 정책에 ExternalId 조건 없는 Allow 가 있어야 한다. 가짜 STS 시험은 신뢰 정책을 평가하지 않아 이 대조가 없으면 실측에서야 터진다
test("FM-CON-08: 발급기가 보내는 세션 동작마다 조건 없는 Allow, AssumeRole 은 ExternalId 조건 (생성기 = 파일)", async () => {
  const { assumeRoleInput } = await import("@svc/security");
  const sent = assumeRoleInput({ req: { tenantId: "11111111-1111-4111-8111-111111111111", envId: "22222222-2222-4222-8222-222222222222", provider: "aws",
    purpose: "observe", actions: ["eks:ListClusters"], ttlSec: 900 } as never, now: new Date(), roleRef: "arn:aws:iam::111122223333:role/svc-observe",
    sessionName: "svc-verify", externalId: "x".repeat(64) }) as unknown as Record<string, unknown>;
  const needed = [...(Array.isArray(sent.Tags) && sent.Tags.length ? ["sts:TagSession"] : []), ...(sent.SourceIdentity ? ["sts:SetSourceIdentity"] : [])];
  assert.ok(needed.length > 0, `발급기가 Tags·SourceIdentity 를 안 보냄: ${Object.keys(sent).join(",")}`);
  const t: J = load();
  assert.deepEqual(structuredClone(t), buildAwsConnectTemplate(t.Resources.OperatePolicy.Properties.PolicyDocument, t.Resources.BoundaryPolicy.Properties.PolicyDocument));
  for (const key of ["ObserveRole", "OperateRole"]) {
    const st = t.Resources[key].Properties.AssumeRolePolicyDocument.Statement as J[];
    for (const a of needed) assert.ok(st.some((s) => s.Effect === "Allow" && arr(s.Action).includes(a) && s.Condition === undefined), `${key}: ${a} 조건 없는 Allow 없음`);
    assert.ok(st.some((s) => arr(s.Action).includes("sts:AssumeRole") && s.Condition?.StringEquals?.["sts:ExternalId"]), `${key}: AssumeRole ExternalId 조건`);
  }
});
