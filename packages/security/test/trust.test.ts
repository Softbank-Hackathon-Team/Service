// Z47-04: 앱 역할(app-*) 신뢰 정책 검사
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAppRoleTrust, verifyAppRoleTrust } from "../src/index.js";

// infra/modules/aws/app/main.tf 의 aws_iam_role.app 과 같은 모양
const good = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "pods.eks.amazonaws.com" }, Action: ["sts:AssumeRole", "sts:TagSession"] }] };

test("Terraform 이 만드는 신뢰 정책은 통과 (객체·JSON·URL 인코딩 셋 다)", () => {
  assert.deepEqual(checkAppRoleTrust(good), { ok: true, violations: [] });
  assert.equal(checkAppRoleTrust(JSON.stringify(good)).ok, true);
  assert.equal(checkAppRoleTrust(encodeURIComponent(JSON.stringify(good))).ok, true);
});

test("외부 계정·아무나·다른 서비스·NotPrincipal·넓은 동작은 위반", () => {
  const bad = (st: Record<string, unknown>) => checkAppRoleTrust({ Statement: [st] });
  assert.ok(bad({ Effect: "Allow", Principal: { AWS: "arn:aws:iam::<외부 계정>:root" }, Action: "sts:AssumeRole" }).violations.includes("TRUST_PRINCIPAL_AWS#0"));
  assert.ok(bad({ Effect: "Allow", Principal: "*", Action: "sts:AssumeRole" }).violations.includes("TRUST_PRINCIPAL_ANY#0"));
  assert.ok(bad({ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }).violations.includes("TRUST_SERVICE#0"));
  assert.ok(bad({ Effect: "Allow", Principal: { Federated: "accounts.google.com" }, Action: "sts:AssumeRoleWithWebIdentity" }).violations.includes("TRUST_PRINCIPAL_FEDERATED#0"));
  assert.ok(bad({ Effect: "Allow", NotPrincipal: { Service: "pods.eks.amazonaws.com" }, Principal: { Service: "pods.eks.amazonaws.com" }, Action: "sts:AssumeRole" }).violations.includes("TRUST_NOT_PRINCIPAL#0"));
  assert.ok(bad({ Effect: "Allow", Principal: { Service: "pods.eks.amazonaws.com" }, Action: "sts:*" }).violations.includes("TRUST_ACTION#0"));
  assert.equal(checkAppRoleTrust("{not json").violations[0], "TRUST_UNPARSEABLE");
  assert.equal(checkAppRoleTrust({ Statement: [] }).violations[0], "TRUST_EMPTY");
});

test("좋은 문 + 뒷문 문이 같이 있으면 위반 (두 번째 문 번호로)", () => {
  const r = checkAppRoleTrust({ Statement: [good.Statement[0], { Effect: "Allow", Principal: { AWS: "*" }, Action: "sts:AssumeRole" }] });
  assert.equal(r.ok, false);
  assert.ok(r.violations.includes("TRUST_PRINCIPAL_AWS#1"));
});

test("verifyAppRoleTrust: GetRole 결과(URL 인코딩)로 판정, app- 아닌 이름은 거부", async () => {
  const iam = { getRole: async () => ({ Role: { AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(good)) } }) };
  assert.equal((await verifyAppRoleTrust(iam, "app-shop")).ok, true);
  assert.deepEqual((await verifyAppRoleTrust(iam, "svc-operate")).violations, ["TRUST_ROLE_NOT_APP"]);
});
