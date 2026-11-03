// 검증 L3: 연결 템플릿의 빈틈 — 참조가 모두 풀리는지, 크기 한도, 하드코딩 계정 없음, 조건부 경계 정책, 파라미터 패턴의 경계값, 거부 사본
import { test } from "node:test";
import assert from "node:assert/strict";
import { configProblems } from "@svc/contracts";
import { readFileSync } from "node:fs";
import { buildAwsConnectTemplate } from "../scripts/aws-connect-template.js";

const path = new URL("../../../infra/onboarding/aws-connect.json", import.meta.url);
const raw = readFileSync(path, "utf8");
type J = any; // JSON 구조 시험이라 느슨하게
const load = (): J => JSON.parse(raw);

// 템플릿 안의 Ref / Fn::GetAtt / Condition 이름을 모은다
function refs(node: unknown, out: { ref: Set<string>; getatt: Set<string>; cond: Set<string> } = { ref: new Set(), getatt: new Set(), cond: new Set() }) {
  if (Array.isArray(node)) node.forEach((n) => refs(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "Ref" && typeof v === "string") out.ref.add(v);
      else if (k === "Fn::GetAtt" && Array.isArray(v)) out.getatt.add(String(v[0]));
      else if (k === "Condition" && typeof v === "string") out.cond.add(v);
      else refs(v, out);
    }
  }
  return out;
}

test("모든 Ref·GetAtt·Condition 이름이 파라미터·자원·조건으로 풀린다 (AWS 의사 파라미터 제외)", () => {
  const t = load();
  const r = refs(t);
  const known = new Set([...Object.keys(t.Parameters), ...Object.keys(t.Resources)]);
  for (const n of r.ref) assert.ok(known.has(n) || n.startsWith("AWS::"), `Ref ${n}`);
  for (const n of r.getatt) assert.ok(Object.keys(t.Resources).includes(n), `GetAtt ${n}`);
  for (const n of r.cond) assert.ok(n in t.Conditions, `Condition ${n}`);
});

test("크기·형식: --template-body 한도 51200바이트 아래, 계정 번호(12자리)·Fn::Sub 하드코딩 없음", () => {
  assert.ok(Buffer.byteLength(raw) < 51200, `${Buffer.byteLength(raw)} bytes`);
  // 플랫폼 계정은 파라미터로만. 정책 문서의 ${aws:PrincipalAccount} 는 IAM 이 푸는 변수라 Fn::Sub 이 건드리면 안 된다
  assert.doesNotMatch(raw.replace(/\\d\{12\}/g, ""), /\b\d{12}\b/);
  assert.ok(!raw.includes('"Fn::Sub"'), "Fn::Sub 쓰면 IAM 변수 이스케이프가 필요");
});

test("경계 정책은 조건부: CreateBoundaryPolicy=true 일 때만 만들고, 이름은 platform-app-boundary", () => {
  const t = load();
  assert.equal(t.Resources.BoundaryPolicy.Condition, "CreateBoundary");
  assert.deepEqual(t.Conditions.CreateBoundary, { "Fn::Equals": [{ Ref: "CreateBoundaryPolicy" }, "true"] });
  assert.equal(t.Resources.BoundaryPolicy.Properties.ManagedPolicyName, "platform-app-boundary");
  assert.equal(t.Parameters.CreateBoundaryPolicy.Default, "true");
  assert.deepEqual(t.Parameters.CreateBoundaryPolicy.AllowedValues, ["true", "false"]);
});

test("PlatformPrincipalArn 패턴: 역할·사용자 ARN은 통과, :root·assumed-role·12자리 아님·접두 없음은 거부", () => {
  const re = new RegExp(load().Parameters.PlatformPrincipalArn.AllowedPattern);
  assert.ok(re.test("arn:aws:iam::123456789012:role/svc-worker"));
  assert.ok(re.test("arn:aws:iam::123456789012:role/path/to/role"));
  assert.ok(re.test("arn:aws:iam::123456789012:user/jeong-cli"));
  for (const bad of ["arn:aws:iam::123456789012:root", "arn:aws:sts::123456789012:assumed-role/x/y", "arn:aws:iam::12345678901:role/x",
    "arn:aws:iam::1234567890123:role/x", "arn:aws:iam::123456789012:role/", "x-arn:aws:iam::123456789012:role/x", "*"])
    assert.ok(!re.test(bad), bad);
});

test("ExternalId 패턴: STS 가 받는 글자만, 32자 미만 파라미터는 MinLength 로 막힘", () => {
  const p = load().Parameters.ExternalId;
  const re = new RegExp(p.AllowedPattern);
  assert.ok(re.test("a".repeat(32)));
  assert.ok(re.test("abc+=,.@:/-_".replace("_", "") + "0".repeat(24)));
  for (const bad of ["has space", "semi;colon", "한글", "a b"]) assert.ok(!re.test(bad), bad);
  assert.equal(p.MinLength, 32);
  assert.equal(p.NoEcho, undefined);
});

test("두 신뢰 정책은 Allow 한 줄뿐이고 Deny·NotPrincipal·와일드카드 Principal 없음", () => {
  const t = load();
  for (const key of ["ObserveRole", "OperateRole"]) {
    const st = t.Resources[key].Properties.AssumeRolePolicyDocument.Statement;
    assert.equal(st.length, 1);
    assert.equal(st[0].Effect, "Allow");
    assert.equal(st[0].NotPrincipal, undefined);
    assert.notEqual(st[0].Principal?.AWS, "*");
    assert.equal(st[0].Principal?.Service, undefined);
  }
});

test("관찰 접근은 ViewPolicy 하나만 클러스터 범위, 실행 접근은 정책 없이 그룹만", () => {
  const t = load();
  const o = t.Resources.ObserveAccess.Properties;
  assert.equal(o.AccessPolicies.length, 1);
  assert.deepEqual(o.AccessPolicies[0].AccessScope, { Type: "cluster" });
  assert.match(o.AccessPolicies[0].PolicyArn, /AmazonEKSViewPolicy$/);
  assert.equal(o.KubernetesGroups, undefined);
});

test("다시 만들어도 같은 글자: builder 출력의 직렬화가 파일과 한 글자도 안 다르다(줄 끝 포함)", () => {
  const t = load();
  const op = t.Resources.OperatePolicy.Properties.PolicyDocument;
  const bd = t.Resources.BoundaryPolicy.Properties.PolicyDocument;
  const again = buildAwsConnectTemplate(op, bd);
  assert.equal(JSON.stringify(again, null, 2).trimEnd(), raw.trimEnd());
});

// PRINCIPALUSER: 템플릿 AllowedPattern 과 API 설정 검사(PLATFORM_PRINCIPAL_ARN)가 같은 값을 받고 같은 값을 거부해야 한다
//   (11/3: 한쪽만 user 를 받아 실세션 connect 에서 api 가 시작을 거부함)
test("PRINCIPALUSER: 연결 템플릿 패턴 ↔ API 설정 검사 같은 판정", () => {
  const re = new RegExp(load().Parameters.PlatformPrincipalArn.AllowedPattern);
  const api = (v: string) => configProblems("api", { DATABASE_URL: "postgres://u@localhost:5432/d", PLATFORM_PRINCIPAL_ARN: v })
    .every((x) => !x.startsWith("PLATFORM_PRINCIPAL_ARN"));
  for (const v of ["arn:aws:iam::123456789012:role/svc-worker", "arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/ap-northeast-2/AWSReservedSSO_X",
    "arn:aws:iam::123456789012:user/jeong-cli", "arn:aws:iam::123456789012:root", "arn:aws:sts::123456789012:assumed-role/x/y",
    "arn:aws:iam::12345678901:role/x", "arn:aws:iam::123456789012:group/g", "x-arn:aws:iam::123456789012:role/x"])
    assert.equal(re.test(v), api(v), v);
});
