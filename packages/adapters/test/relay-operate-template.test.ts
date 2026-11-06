// 연결 템플릿 실행 역할의 중계기 권한: 원본 문장이 인라인으로 들어가고, RDS 보안 그룹 문장은 매개변수가 있을 때만 켜진다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const tpl = read("../../../infra/onboarding/aws-connect.json");
const src = read("../../../infra/permissions/aws-relay-statements.json");
const SID = "SourceDbEgressToRelay";
const SECRET_SID = "SourceDbMasterSecretRead";
const GATED = [SID, SECRET_SID];
const inline = (name: string) => tpl.Resources.OperateRole.Properties.Policies.find((p: { PolicyName: string }) => p.PolicyName === name)?.PolicyDocument;

test("실행 역할 인라인 relay 에 원본 문장이 그대로 들어가고, 인라인 합계가 IAM 한도 안이다", () => {
  const plain = inline("relay").Statement.filter((s: { Sid?: string }) => s.Sid);
  assert.deepEqual(plain, src.Statement.filter((s: { Sid: string }) => !GATED.includes(s.Sid)));
  assert.equal(plain.length, 14);   // + TargetDbRulesForRelay (GCP→AWS 도착 RDS 보안 그룹) + RelayReadOwnConsole (중계기 호스트 공개 키, 보안 12번)
  const size = tpl.Resources.OperateRole.Properties.Policies.reduce((n: number, p: { PolicyDocument: unknown }) => n + JSON.stringify(p.PolicyDocument).length, 0);
  assert.ok(size < 10240, `인라인 합계 ${size}`);
});

test("RDS 보안 그룹 문장: 매개변수로 하나만 열고, 비우면 빠진다", () => {
  const gated = inline("relay").Statement.find((s: Record<string, { 1: { Sid: string } }>) => s["Fn::If"]?.[1].Sid === SID);
  const [cond, stmt, off] = gated["Fn::If"];
  assert.equal(cond, "HasSourceDbSecurityGroup");
  assert.deepEqual(off, { Ref: "AWS::NoValue" });
  assert.equal(stmt.Sid, SID);
  assert.deepEqual(stmt.Resource, { "Fn::Join": ["", ["arn:aws:ec2:ap-northeast-2:", { Ref: "AWS::AccountId" }, ":security-group/", { Ref: "SourceDbSecurityGroupId" }, ""]] });
  assert.deepEqual(tpl.Conditions.HasSourceDbSecurityGroup, { "Fn::Not": [{ "Fn::Equals": [{ Ref: "SourceDbSecurityGroupId" }, ""] }] });
  assert.equal(tpl.Parameters.SourceDbSecurityGroupId.Default, "");
});

test("거부: 보안 그룹 ID 모양이 아니면 매개변수가 받지 않고, 관찰 역할에는 중계기 권한이 없다", () => {
  const re = new RegExp(tpl.Parameters.SourceDbSecurityGroupId.AllowedPattern);
  assert.ok(re.test("") && re.test("sg-0123456789abcdef0"));
  for (const bad of ["*", "sg-*", "sg-XYZ", "sg-12345678/x"]) assert.ok(!re.test(bad), bad);
  assert.ok(!JSON.stringify(tpl.Resources.ObserveRole).includes("ec2:RunInstances"));
  assert.equal(Object.keys(tpl.Parameters).length, 8);   // + RoleSuffix (한 계정에 환경 여럿, 0056)
});

test("출발 관리 비밀 읽기: 매개변수로 DB 하나의 RDS 관리 비밀만 (ARN 이 아니라 RDS 태그), 비우면 빠진다", () => {
  const gated = inline("relay").Statement.find((s: Record<string, { 1: { Sid: string } }>) => s["Fn::If"]?.[1].Sid === SECRET_SID);
  const [cond, stmt, off] = gated["Fn::If"];
  assert.equal(cond, "HasSourceDbInstance");
  assert.deepEqual(off, { Ref: "AWS::NoValue" });
  assert.deepEqual(stmt.Action, ["secretsmanager:GetSecretValue"]);
  assert.deepEqual(stmt.Resource, { "Fn::Join": ["", ["arn:aws:secretsmanager:ap-northeast-2:", { Ref: "AWS::AccountId" }, ":secret:rds!db-*"]] });
  assert.deepEqual(stmt.Condition.StringEquals["aws:ResourceTag/aws:rds:primaryDBInstanceArn"],
    { "Fn::Join": ["", ["arn:aws:rds:ap-northeast-2:", { Ref: "AWS::AccountId" }, ":db:", { Ref: "SourceDbInstanceId" }, ""]] });
  assert.deepEqual(tpl.Conditions.HasSourceDbInstance, { "Fn::Not": [{ "Fn::Equals": [{ Ref: "SourceDbInstanceId" }, ""] }] });
  assert.equal(tpl.Parameters.SourceDbInstanceId.Default, "");
});

test("거부: DB 식별자 모양이 아니면(와일드카드·ARN·경로) 매개변수가 받지 않고, 관찰 역할에는 비밀 읽기가 없다", () => {
  const re = new RegExp(tpl.Parameters.SourceDbInstanceId.AllowedPattern);
  assert.ok(re.test("") && re.test("sample-shop-db"));
  for (const bad of ["*", "db-*", "1abc", "arn:aws:rds:ap-northeast-2:123456789012:db:x", "a/b", "a".repeat(64)]) assert.ok(!re.test(bad), bad);
  assert.ok(!JSON.stringify(tpl.Resources.ObserveRole).includes("secretsmanager:GetSecretValue"));
});

test("권한: TargetDbRulesForRelay = 보안 그룹 규칙 더하기·빼기만, 플랫폼이 만든(managed-by=platform·tenant 태그) 보안 그룹에만, 연결 템플릿 relay 정책에도 있다", () => {
  const doc = src as { Statement: { Sid: string; Action: string[]; Resource: string; Condition?: Record<string, Record<string, string>> }[] };
  const s = doc.Statement.find((x) => x.Sid === "TargetDbRulesForRelay")!;
  assert.deepEqual(s.Action, ["ec2:AuthorizeSecurityGroupEgress", "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress"]);
  assert.equal(s.Resource, "arn:aws:ec2:ap-northeast-2:*:security-group/*");
  assert.equal(s.Condition?.StringEquals?.["aws:ResourceTag/managed-by"], "platform");
  assert.equal(s.Condition?.Null?.["aws:ResourceTag/tenant"], "false");
  assert.deepEqual(inline("relay").Statement.find((x: { Sid?: string }) => x.Sid === "TargetDbRulesForRelay"), s, "연결 템플릿(export-permissions 생성) relay 정책에 같은 문장 (매개변수 없이 늘 켜짐)");
});
