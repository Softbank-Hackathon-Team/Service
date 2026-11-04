import type { Provider } from "@svc/contracts";
import { actionsOfPolicy, type PermissionSet, type Stage } from "./permissions.js";

// 작업 단계가 임시 역할을 빌릴 때 "무슨 동작을 달라고 할지" (작업 Z39). 순수 함수.
// 동작 목록을 손으로 다시 쓰지 않고 최소 권한 파일(infra/permissions)에서 뽑는다 → 파일이 바뀌면 요청도 같이 바뀐다
//   AWS 실행: 그 단계의 세션 정책 동작 그대로 (중개자가 다시 세션 정책으로 좁힌다)
//   GCP·온프레 실행: 천장에서 단계에 맞는 동사만 (plan = 읽기, apply = 지우기 뺀 전부, destroy = 읽기 + 지우기)
//   관찰: 천장의 읽기 동작만
// ID-8: 예전 상한 50개는 AWS apply 세션 정책(66개)을 잘라 장부·감사에 앞 50개만 남겼다(실제 권한은 세션 정책 원문이라 영향 없음).
// DRAFT(ai): 상한 200개(TempRoleRequest 와 같음). 넘으면 자르지 않고 그대로 내보내 발급이 거부되게 한다 (조용히 잘린 장부보다 낫다). 시험이 "안 잘림"을 확인

export const STEP_ROLE_MAX_ACTIONS = 200;
const READ_VERB = /^(describe|list|get|batchget|watch|lookup|search)/i;
const DELETE_VERB = /^(delete|deletecollection|remove|destroy)/i;
const verbOf = (a: string) => a.split(/[:.]/).pop() ?? "";
const isRead = (a: string) => READ_VERB.test(verbOf(a));
const isDelete = (a: string) => DELETE_VERB.test(verbOf(a));

// Azure 는 Mock 전용이라 천장 파일이 없다. 관찰 요청 모양만 맞춘다
const AZURE_OBSERVE = ["resources.list", "resourcegroups.get"];

export function stepActions(p: PermissionSet | null, provider: Provider, purpose: "observe" | "operate", stage?: Stage): string[] {
  const cap = (xs: string[]) => [...new Set(xs)].sort();
  if (provider === "azure_mock") return purpose === "observe" ? AZURE_OBSERVE : [];
  if (!p) return [];
  const ceiling = provider === "aws" ? p.aws.ceiling : provider === "gcp" ? p.gcp.ceiling : p.onprem.ceiling;
  if (purpose === "observe") return cap(ceiling.filter(isRead));
  const st = stage ?? "plan";
  if (provider === "aws") return cap(actionsOfPolicy(JSON.parse(p.aws.sessionPolicies[st])));
  if (st === "plan") return cap(ceiling.filter(isRead));
  if (st === "destroy") return cap(ceiling.filter((a) => isRead(a) || isDelete(a)));
  return cap(ceiling.filter((a) => !isDelete(a)));
}

// ECR 이미지 받기 (토큰 + 매니페스트 + 층). 고객 관찰 역할 인라인(infra/onboarding/aws-connect.json)에도 같은 세 동작이 있어야 한다 (시험이 대조)
export const ECR_PULL_ACTIONS = ["ecr:BatchGetImage", "ecr:GetAuthorizationToken", "ecr:GetDownloadUrlForLayer"] as const;

// 단계 → 어느 환경에서 무슨 목적으로 빌리나. 작업 단계 배선(worker jobs/_roles.ts)이 이 표를 따른다
export const STEP_ROLES = {
  precheck: [{ side: "source", purpose: "observe" }, { side: "target", purpose: "observe" }],
  plan: [{ side: "target", purpose: "operate", stage: "plan" }],
  apply: [{ side: "target", purpose: "operate", stage: "apply" }],
  // VDEPLOYNONK8S: ECS·Cloud Run·VM 도착의 배포 확인은 도착 관찰 역할을 빌려 읽는다(상태 읽기만). 안 빌리면 워커 자기 자격으로 조회하게 된다
  deploy: [{ side: "target", purpose: "observe" }],
  // ID-4·ID-8: 정리 단계는 출발 쪽 destroy 자격을 빌리지 않는다. 지금 정리는 자격으로 아무것도 안 하고(cleanup.ts STUB),
  //   출발 destroy 자격은 고객 원래 자원(롤백 기준 출발 DB)을 지울 수 있는 자격이라 쓰지 않을 때 빌리면 위험만 남는다.
  //   또 빌린 자격을 일 중간에 revokeForMigration 으로 회수해 재발급 고리가 CRED_RENEW_FAILED 로 멈출 수 있었다.
  // TODO(human): 출발 자원을 실제로 지우기로 정하면(고객 동의 범위) 그때 다시 넣는다
  cleanup: [],
  rollback: [{ side: "target", purpose: "operate", stage: "destroy" }],
  // 이전 중 도착 GKE 업그레이드 멈춤·풀기 (worker jobs/gke-freeze.ts). container.clusters.update = 지우기 아닌 쓰기 → apply 단계 동작
  gke_freeze: [{ side: "target", purpose: "operate", stage: "apply" }],
  // APP-22 (가): Terraform 이 앱을 띄우는 도착의 앱 DB 주소 바꾸기(컷오버·롤백 때 같은 입력으로 다시 apply). apply 와 같은 천장
  db_writer: [{ side: "target", purpose: "operate", stage: "apply" }],
  // 리허설 이미지 복사 (worker rehearsal/image-mirror.ts). 출발 ECR 에서 다이제스트로 받기만 한다. 관찰 천장 전체가 아니라 이 세 동작만 요청
  image_mirror: [{ side: "source", purpose: "observe", actions: ECR_PULL_ACTIONS }],
} as const satisfies Record<string, ReadonlyArray<{ side: "source" | "target"; purpose: "observe" | "operate"; stage?: Stage; actions?: readonly string[] }>>;
export type RoleStep = keyof typeof STEP_ROLES;
