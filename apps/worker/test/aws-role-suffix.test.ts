// 한 AWS 계정에 환경 여럿 (0056 environments.aws_role_suffix): 플랫폼이 고객 역할 ARN 을 조립하는 곳이 모두 환경 꼬리를 쓴다.
//   옛 환경(꼬리 NULL)은 예전 고정 이름 그대로 (고객이 할 일 없음). DB 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { awsRoleName, awsRoleSuffixFor } from "@svc/contracts";
import { stubRoleIssuer } from "@svc/security";
import { roleRefFor } from "../src/platform.js";

const NEW = "783df2ef-0000-4000-8000-000000000001", OTHER = "a1b2c3d4-0000-4000-8000-000000000002";
const row = (o: Record<string, unknown> = {}) => ({ provider: "aws", account_id: "111122223333", external_id: "e".repeat(64), ...o });

test("정상: 새 AWS 환경은 svc-observe·svc-operate 뒤에 환경 꼬리, ExternalId 는 그대로", () => {
  const suffix = awsRoleSuffixFor(NEW);
  assert.equal(suffix, "-783df2ef");
  assert.deepEqual(roleRefFor(row({ aws_role_suffix: suffix }), NEW, "observe"),
    { roleRef: "arn:aws:iam::111122223333:role/svc-observe-783df2ef", externalId: "e".repeat(64) });
  assert.equal(roleRefFor(row({ aws_role_suffix: suffix }), NEW, "operate").roleRef, "arn:aws:iam::111122223333:role/svc-operate-783df2ef");
});

test("같은 계정 두 환경: 역할 ARN 이 서로 다르다 (예전엔 둘 다 svc-observe 라 두 번째 스택이 AlreadyExists)", () => {
  const a = roleRefFor(row({ aws_role_suffix: awsRoleSuffixFor(NEW) }), NEW, "operate").roleRef;
  const b = roleRefFor(row({ aws_role_suffix: awsRoleSuffixFor(OTHER) }), OTHER, "operate").roleRef;
  assert.notEqual(a, b);
  assert.equal(b, "arn:aws:iam::111122223333:role/svc-operate-a1b2c3d4");
});

test("옛 환경: 꼬리 NULL·칸 없음 → 예전 이름 그대로 (이미 연결된 스택이 계속 열린다)", () => {
  for (const r of [row({ aws_role_suffix: null }), row()]) {
    assert.equal(roleRefFor(r, NEW, "observe").roleRef, "arn:aws:iam::111122223333:role/svc-observe");
    assert.equal(roleRefFor(r, NEW, "operate").roleRef, "arn:aws:iam::111122223333:role/svc-operate");
  }
});

test("거부: 꼬리 모양이 틀리면 붙이지 않는다 (ARN 에 다른 글자가 끼지 않게)", () => {
  for (const bad of ["783df2ef", "-783DF2EF", "-*", "/../x", "-783df2ef/x"]) {
    assert.equal(awsRoleName("svc-observe", bad), "svc-observe", bad);
    assert.equal(roleRefFor(row({ aws_role_suffix: bad }), NEW, "observe").roleRef, "arn:aws:iam::111122223333:role/svc-observe", bad);
  }
});

test("GCP·온프레는 꼬리와 상관없다 (GCP 연결 스크립트는 그대로)", () => {
  assert.equal(roleRefFor({ provider: "gcp", account_id: "cust-proj-123", external_id: null, aws_role_suffix: "-783df2ef" }, NEW, "observe").roleRef,
    "svc-observe@cust-proj-123.iam.gserviceaccount.com");
  assert.equal(roleRefFor({ provider: "onprem", account_id: null, external_id: null, aws_role_suffix: "-783df2ef" }, NEW, "operate").roleRef,
    `agent://${NEW}/svc-operate`);
});

test("흉내 발급기(stubRoleIssuer)도 같은 규칙: 꼬리가 있으면 붙이고 없으면 옛 이름", async () => {
  const req = { tenantId: "11111111-1111-4111-8111-111111111111", envId: NEW, provider: "aws" as const, purpose: "observe" as const, actions: ["eks:ListClusters"], ttlSec: 900 };
  const withSuffix = await stubRoleIssuer(() => "111122223333", (id) => awsRoleSuffixFor(id)).issue(req, new Date());
  assert.equal(withSuffix.roleRef, "arn:aws:iam::111122223333:role/svc-observe-783df2ef");
  const old = await stubRoleIssuer(() => "111122223333").issue(req, new Date());
  assert.equal(old.roleRef, "arn:aws:iam::111122223333:role/svc-observe");
});
