// 연결 템플릿 실행 역할의 중계기 권한: 정해진 12문장만 인라인으로 들어가고, 입력값이 필요한 문장은 빠져 있다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const tpl = read("../../../infra/onboarding/aws-connect.json");
const src = read("../../../infra/permissions/aws-relay-statements.json");
const inline = (name: string) => tpl.Resources.OperateRole.Properties.Policies.find((p: { PolicyName: string }) => p.PolicyName === name)?.PolicyDocument;

test("실행 역할 인라인 relay 에 원본 문장이 그대로 들어가고, 인라인 합계가 IAM 한도 안이다", () => {
  const doc = inline("relay");
  const want = src.Statement.filter((s: { Sid: string }) => s.Sid !== "SourceDbEgressToRelay");
  assert.equal(want.length, src.Statement.length - 1);
  assert.deepEqual(doc.Statement, want);
  const size = tpl.Resources.OperateRole.Properties.Policies.reduce((n: number, p: { PolicyDocument: unknown }) => n + JSON.stringify(p.PolicyDocument).length, 0);
  assert.ok(size < 10240, `인라인 합계 ${size}`);
});

test("거부: 보안 그룹 입력값 문장·자리표시자는 템플릿에 없고, 관찰 역할과 매개변수는 그대로다", () => {
  const all = JSON.stringify(tpl);
  assert.ok(!all.includes("SourceDbEgressToRelay"));
  assert.ok(!all.includes("SourceDbSecurityGroupId"));
  assert.ok(!JSON.stringify(tpl.Resources.ObserveRole).includes("ec2:RunInstances"));
  assert.equal(Object.keys(tpl.Parameters).length, 5);
});
