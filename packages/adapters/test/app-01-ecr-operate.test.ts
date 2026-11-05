// APP-01 (D 이미지 복사·aws root image_repos_json): 실행 역할 천장·연결 템플릿에 ECR 쓰기가 "우리 저장소 이름" 아래로만 있다. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
type St = { Sid: string; Action: string[] | string; Resource: string[] | string; Condition?: Record<string, Record<string, string>> };
const policy = json("infra/permissions/aws-operate-role-policy.json") as { Statement: St[] };
const sid = (s: string) => policy.Statement.find((x) => x.Sid === s)!;
const acts = (s: St) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

test("APP-01 천장: ECR 만들기·push 는 repository/platform/* 만, 지우기는 우리 태그만, 토큰만 *", () => {
  const repos = sid("AppImageRepos");
  for (const a of ["ecr:CreateRepository", "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchCheckLayerAvailability", "ecr:TagResource"])
    assert.ok(acts(repos).includes(a), a);
  assert.equal(repos.Resource, "arn:aws:ecr:*:*:repository/platform/*");
  const owned = sid("AppImageReposOwned");
  assert.deepEqual(acts(owned).sort(), ["ecr:BatchDeleteImage", "ecr:DeleteRepository"]);
  assert.equal(owned.Condition!.StringEquals!["aws:ResourceTag/managed-by"], "platform");
  assert.deepEqual(acts(sid("AppImageAuth")), ["ecr:GetAuthorizationToken"]);
  // 관리형 정책 한도 6,144자 (공백 빼고)
  assert.ok(JSON.stringify(policy).length <= 6144, String(JSON.stringify(policy).length));
});

test("APP-01 거부: ECR 쓰기·지우기가 다른 문장(Resource *)에 끼어 있지 않음, 연결 템플릿 실행 정책과 같음", () => {
  for (const s of policy.Statement) {
    if (s.Sid.startsWith("AppImage")) continue;
    assert.ok(!acts(s).some((a) => /^ecr:(Create|Put|Delete|BatchDelete|Upload|Initiate|Complete|Tag)/.test(a)), s.Sid);
  }
  const tpl = json("infra/onboarding/aws-connect.json");
  assert.deepEqual(tpl.Resources.OperatePolicy.Properties.PolicyDocument, policy);
});
