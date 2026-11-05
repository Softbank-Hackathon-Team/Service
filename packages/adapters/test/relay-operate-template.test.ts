// 연결 템플릿 실행 역할의 중계기 권한: 원본 문장이 인라인으로 들어가고, RDS 보안 그룹 문장은 매개변수가 있을 때만 켜진다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const tpl = read("../../../infra/onboarding/aws-connect.json");
const src = read("../../../infra/permissions/aws-relay-statements.json");
const SID = "SourceDbEgressToRelay";
const inline = (name: string) => tpl.Resources.OperateRole.Properties.Policies.find((p: { PolicyName: string }) => p.PolicyName === name)?.PolicyDocument;

test("실행 역할 인라인 relay 에 원본 문장이 그대로 들어가고, 인라인 합계가 IAM 한도 안이다", () => {
  const plain = inline("relay").Statement.filter((s: { Sid?: string }) => s.Sid);
  assert.deepEqual(plain, src.Statement.filter((s: { Sid: string }) => s.Sid !== SID));
  assert.equal(plain.length, 12);
  const size = tpl.Resources.OperateRole.Properties.Policies.reduce((n: number, p: { PolicyDocument: unknown }) => n + JSON.stringify(p.PolicyDocument).length, 0);
  assert.ok(size < 10240, `인라인 합계 ${size}`);
});

test("RDS 보안 그룹 문장: 매개변수로 하나만 열고, 비우면 빠진다", () => {
  const [gated] = inline("relay").Statement.filter((s: Record<string, unknown>) => s["Fn::If"]);
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
  assert.equal(Object.keys(tpl.Parameters).length, 6);
});
