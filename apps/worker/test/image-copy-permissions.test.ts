// 배포 이미지 복사의 자격: 출발 관찰 역할은 그 클라우드의 받기 동작만 요청하고(최소 권한 검사 통과), 도착 실행 역할 apply 단계는 올리기 권한을 갖는다.
// 권한 파일(infra/permissions)·연결 스크립트(gcp-connect.sh DRY_RUN)와 대조한다. 클라우드 호출 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { AR_PULL_PERMISSIONS, ECR_PULL_ACTIONS, STEP_ROLES, checkLeastPrivilege, listedActions, loadPermissionSet, stepActions } from "@svc/security";

const root = new URL("../../../", import.meta.url);
const PERM_DIR = new URL("infra/permissions/", root).pathname;
const T = "11111111-2222-4333-8444-555555555555";
const [source, target] = STEP_ROLES.image_copy;

test("image_copy 출발 = 관찰 역할, 클라우드별 받기 동작만 (AWS ECR 3개 / GCP AR 1개), 둘 다 관찰 최소 권한 검사 통과, 온프레·Azure 는 묻지 않음", () => {
  assert.equal(source.side, "source");
  assert.equal(source.purpose, "observe");
  assert.deepEqual(listedActions(source.actions, "aws"), [...ECR_PULL_ACTIONS]);
  assert.deepEqual(listedActions(source.actions, "gcp"), ["artifactregistry.repositories.downloadArtifacts"]);
  assert.deepEqual(listedActions(source.actions, "onprem"), []);
  assert.deepEqual(listedActions(source.actions, "azure_mock"), []);
  for (const provider of ["aws", "gcp"] as const)
    assert.doesNotThrow(() => checkLeastPrivilege({ tenantId: T, envId: T, provider, purpose: "observe", actions: listedActions(source.actions, provider)!, ttlSec: 900 }));
  assert.throws(() => checkLeastPrivilege({ tenantId: T, envId: T, provider: "gcp", purpose: "observe", actions: ["artifactregistry.repositories.uploadArtifacts"], ttlSec: 900 }),
    /ROLE_OBSERVE_WRITE|쓰기/, "올리기는 여전히 관찰 역할에 못 넣는다");
});

// crane 이 ECR 에 올릴 때 부르는 API + 저장소 만들기(만들 때 태그) — AWS ECR 문서의 push 권한 목록
const ECR_PUSH = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:CreateRepository", "ecr:GetAuthorizationToken",
  "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:TagResource", "ecr:UploadLayerPart"];
test("image_copy 도착 = 실행 역할 apply: AWS apply 세션 정책(=요청 동작)에 ECR 올리기, plan·destroy 에는 없음. 실효 범위는 천장 platform/* 저장소", () => {
  assert.deepEqual({ side: target.side, purpose: target.purpose, stage: target.stage }, { side: "target", purpose: "operate", stage: "apply" });
  const perms = loadPermissionSet(PERM_DIR);
  const apply = stepActions(perms, "aws", "operate", "apply");
  assert.deepEqual(ECR_PUSH.filter((a) => !apply.includes(a)), []);
  for (const st of ["plan", "destroy"] as const) assert.deepEqual(stepActions(perms, "aws", "operate", st).filter((a) => a.startsWith("ecr:")), [], st);
  const role = JSON.parse(readFileSync(`${PERM_DIR}aws-operate-role-policy.json`, "utf8")) as { Statement: Array<{ Sid: string; Action: string | string[]; Resource: string }> };
  const writes = role.Statement.filter((s) => [s.Action].flat().some((a) => a.startsWith("ecr:") && a !== "ecr:GetAuthorizationToken"));
  assert.ok(writes.length > 0 && writes.every((s) => s.Resource === "arn:aws:ecr:*:*:repository/platform/*"), "ECR 쓰기는 platform/* 저장소만");
});

test("image_copy 도착 GCP: platform_operate 에 AR 올리기·받기(다이제스트 확인), apply 단계 요청에 들어감", () => {
  const perms = loadPermissionSet(PERM_DIR);
  const apply = stepActions(perms, "gcp", "operate", "apply");
  for (const p of ["artifactregistry.repositories.uploadArtifacts", "artifactregistry.repositories.downloadArtifacts"]) {
    assert.ok(perms.gcp.ceiling.includes(p), p);
    assert.ok(apply.includes(p), p);
  }
});

test("gcp-connect.sh: 원래 프로젝트 svc-observe 의 관찰 역할(platform_observe)에 AR 받기가 있고, 올리기는 없다", () => {
  const r = spawnSync("bash", [new URL("infra/onboarding/gcp-connect.sh", root).pathname], { encoding: "utf8",
    env: { PATH: process.env.PATH, DRY_RUN: "1", PLATFORM_SA: "t-0123456789abcdef0123456789ab@platform-prj.iam.gserviceaccount.com",
      PROJECT_ID: "cust-prj", TARGET_PROJECT_ID: "cust-mig", ROLE_DIR: PERM_DIR } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n").filter((l) => l.startsWith("+ gcloud"));
  const create = lines.find((l) => l.includes("iam roles create platform_observe ") && l.includes("--project=cust-prj "))!;
  const perms = /--permissions=(\S+)/.exec(create)![1]!.split(",");
  for (const p of AR_PULL_PERMISSIONS) assert.ok(perms.includes(p), p);
  assert.ok(!perms.some((p) => /uploadArtifacts|\.delete|\.create/.test(p)), "관찰 역할에 올리기·만들기·지우기 없음");
  assert.ok(lines.includes("+ gcloud projects add-iam-policy-binding cust-prj --member=serviceAccount:svc-observe@cust-prj.iam.gserviceaccount.com --role=projects/cust-prj/roles/platform_observe --condition=None"));
});
