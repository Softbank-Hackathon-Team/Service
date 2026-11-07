// L7: GCP Cloud Shell 연결 링크 (순수 함수). 실클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionLink } from "@svc/contracts";
import { DEFAULT_GCP_CONNECT_REPO_URL, gcpCloudShellLink, gcpConnectSettings } from "../src/connect/link.js";

const SA = "t-0123456789abcdef0123456789ab@platform-prj.iam.gserviceaccount.com";

test("정상: 레포가 있으면 그 레포를 Cloud Shell 에 열고, 명령 한 줄에 회사 플랫폼 SA·프로젝트가 들어간다 (키 없음)", () => {
  const l = gcpCloudShellLink({ platformSa: SA, projectId: "cust-prj-1", repoUrl: "https://github.com/x/y.git", repoBranch: "main" });
  assert.match(l.url, /^https:\/\/shell\.cloud\.google\.com\/cloudshell\/editor\?cloudshell_git_repo=https%3A%2F%2Fgithub\.com%2Fx%2Fy\.git&cloudshell_git_branch=main&cloudshell_workspace=infra&shellonly=true$/);
  assert.equal(l.command, `PLATFORM_SA='${SA}' PROJECT_ID='cust-prj-1' TARGET_PROJECT_ID='' ROLE_DIR=./permissions bash onboarding/gcp-connect.sh`);
  ConnectionLink.parse({ kind: "gcp_cloud_shell", ...l, expiresAt: "2026-11-04T00:00:00.000Z" });
  assert.doesNotMatch(l.command + l.url, /key|json|credentials/i);
});

test("레포·프로젝트를 모르면 빈 Cloud Shell + PROJECT_ID 없는 명령 (스크립트가 gcloud 기본 프로젝트를 씀)", () => {
  const l = gcpCloudShellLink({ platformSa: SA });
  assert.equal(l.url, "https://shell.cloud.google.com/?show=terminal");
  assert.doesNotMatch(l.command, /(^| )PROJECT_ID=/);
  // 결정 3번 A안: 전용 프로젝트를 모르면 빈 값 → 스크립트가 아무것도 안 바꾸고 "TARGET_PROJECT_ID 필요" 로 멈춘다 (고객이 채움)
  assert.match(l.command, /TARGET_PROJECT_ID='' /);
});

test("A안: 전용 프로젝트를 알면 명령에 TARGET_PROJECT_ID 가 들어가고, 셸 따옴표로 감싼다", () => {
  const l = gcpCloudShellLink({ platformSa: SA, projectId: "cust-prj-1", targetProjectId: "cust-mig-1" });
  assert.equal(l.command, `PLATFORM_SA='${SA}' PROJECT_ID='cust-prj-1' TARGET_PROJECT_ID='cust-mig-1' ROLE_DIR=./permissions bash onboarding/gcp-connect.sh`);
  assert.match(gcpCloudShellLink({ platformSa: SA, targetProjectId: "a'b" }).command, /TARGET_PROJECT_ID='a'\\''b'/);
});

test("거부: GCP_PLATFORM_PROJECT 가 없거나 모양이 틀리면 설정 없음(null → 503), 따옴표가 든 값은 셸에서 안 깨짐", () => {
  assert.equal(gcpConnectSettings({}), null);
  assert.equal(gcpConnectSettings({ GCP_PLATFORM_PROJECT: "Bad_Project" }), null);
  // 레포 주소를 안 주면 기본 공개 레포 (빈 Cloud Shell 로 열려 스크립트가 없던 문제), none 이면 빈 Cloud Shell
  assert.deepEqual(gcpConnectSettings({ GCP_PLATFORM_PROJECT: "platform-prj" }), { platformProject: "platform-prj", repoUrl: DEFAULT_GCP_CONNECT_REPO_URL, repoBranch: null });
  assert.equal(gcpConnectSettings({ GCP_PLATFORM_PROJECT: "platform-prj", GCP_CONNECT_REPO_URL: "none" })!.repoUrl, null);
  assert.match(gcpCloudShellLink({ platformSa: SA, repoUrl: DEFAULT_GCP_CONNECT_REPO_URL }).url, /cloudshell_git_repo=https%3A%2F%2Fgithub\.com%2FSoftbank-Hackathon-Team%2FService\.git&cloudshell_workspace=infra/);
  assert.match(gcpCloudShellLink({ platformSa: SA, projectId: "a'b" }).command, /PROJECT_ID='a'\\''b'/);
});
