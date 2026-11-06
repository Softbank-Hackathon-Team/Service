import type { Provider } from "@svc/contracts";
import { actionsOfPolicy, type PermissionSet, type Stage } from "./permissions.js";
import { AR_PULL_PERMISSIONS, type RolePolicy } from "./temp-role.js";

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

export function stepActions(p: PermissionSet | null, provider: Provider, purpose: "observe" | "operate", stage?: Stage, policy?: RolePolicy): string[] {
  const cap = (xs: string[]) => [...new Set(xs)].sort();
  if (provider === "azure_mock") return purpose === "observe" ? AZURE_OBSERVE : [];
  if (!p) return [];
  // 중계기: 고객 실행 역할에 따로 붙인 중계기 문 묶음의 동작 전부 (AWS 만, 파일이 없으면 빈 목록 → 발급이 거부된다)
  if (policy === "relay") return provider === "aws" && purpose === "operate" ? cap(p.aws.relay?.ceiling ?? []) : [];
  // B-2 환경 층: svc-env 역할의 동작 전부 (읽기 + 만들기. GCP 만, 파일이 없으면 빈 목록 → 발급이 거부된다)
  if (policy === "env_layer") return provider === "gcp" && purpose === "operate" ? cap(p.gcp.env?.ceiling ?? []) : [];
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
// 출발 클라우드 → 이미지 받기 동작. GCP 는 고객 관찰 SA 역할(infra/onboarding/gcp-connect.sh OBSERVE_PERMS)에도 있어야 한다 (시험이 대조)
export const IMAGE_PULL_ACTIONS = { aws: ECR_PULL_ACTIONS, gcp: AR_PULL_PERMISSIONS } as const satisfies Partial<Record<Provider, readonly string[]>>;

// 단계 → 어느 환경에서 무슨 목적으로 빌리나. 작업 단계 배선(worker jobs/_roles.ts)이 이 표를 따른다
export const STEP_ROLES = {
  precheck: [{ side: "source", purpose: "observe" }, { side: "target", purpose: "observe" }],
  plan: [{ side: "target", purpose: "operate", stage: "plan" }],
  apply: [{ side: "target", purpose: "operate", stage: "apply" }],
  // VDEPLOYNONK8S: ECS·Cloud Run·VM 도착의 배포 확인은 도착 관찰 역할을 빌려 읽는다(상태 읽기만). 안 빌리면 워커 자기 자격으로 조회하게 된다
  deploy: [{ side: "target", purpose: "observe" }],
  // 커밋 전 도착 비밀 그릇에 값이 있나 (worker gitops/secret-values.ts). 값은 안 읽는다. 관찰 역할엔 버전 메타데이터 권한이 없어 실행 역할(읽기만 부름)을 빌린다
  secret_check: [{ side: "target", purpose: "operate", stage: "apply" }],
  // 배포 이미지 복사 (worker jobs/image-copy.ts, GitOps 커밋 직전). 출발 관찰 역할로 다이제스트 그대로 받고(출발 클라우드의 받기 동작만),
  //   도착 실행 역할 apply 단계로 도착 레지스트리에 올린다 (ECR 저장소 만들기·올리기 = apply 세션 정책, AR 올리기 = platform_operate)
  image_copy: [{ side: "source", purpose: "observe", actions: IMAGE_PULL_ACTIONS }, { side: "target", purpose: "operate", stage: "apply" }],
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
  // 리허설 이미지 복사 (worker rehearsal/image-mirror.ts). 출발 ECR·Artifact Registry 에서 다이제스트로 받기만 한다. 관찰 천장 전체가 아니라 출발 클라우드의 받기 동작만 요청
  image_mirror: [{ side: "source", purpose: "observe", actions: IMAGE_PULL_ACTIONS }],
  // 온프레 이전 중계기 (worker relay/relay-step.ts): 출발 AWS 계정에 중계 EC2·보안 그룹을 만들고(apply) 정리 때 지운다.
  //   출발 실행 역할을 빌리되 세션 정책은 중계기 동작만 (policy relay). stage apply 는 장부 칸(0009 CHECK)용
  // DRAFT(ai): 만들기·지우기를 한 세션 정책으로 (지우기 전용으로 더 좁히지 않음). 지우는 대상은 코드가 두 태그로 한 번 더 거른다
  relay: [{ side: "source", purpose: "operate", stage: "apply", policy: "relay" }],
  // GCP 출발 → AWS 도착 중계기 (worker relay/gcp-aws.ts): 중계기는 도착 AWS 계정에 산다 → 도착 실행 역할을 같은 relay 정책으로 (만들기·지우기)
  relay_target: [{ side: "target", purpose: "operate", stage: "apply", policy: "relay" }],
  // 같은 중계기의 출발 Cloud SQL 읽기 (공개·나가는 IP·서버 CA, gcloud sql instances describe). 출발 관찰 역할 (가져오기·사전 점검과 같은 읽기만).
  //   지우기는 이 역할을 안 빌린다 (출발 연결이 끊겨도 도착 중계기는 지울 수 있게)
  relay_source_read: [{ side: "source", purpose: "observe" }],
  // GCP ↔ 온프레 중계기 (worker relay/gcp-relay.ts): Cloud SQL 이 있는 쪽 VPC 에 GCE VM·방화벽 규칙을 만들고(apply) 정리 때 지운다.
  //   GCP 토큰은 범위를 못 좁힌다 → svc-operate 토큰 그대로 (gcpTargetFor: plan·env_layer 가 아니면 svc-operate). stage apply 는 장부 칸(0009 CHECK)용
  //   relay_gcp = 출발 쪽(gcp-onprem, 중계기 = 출발 Cloud SQL VPC), relay_gcp_target = 도착 쪽(onprem-gcp, 중계기 = 도착 이전 전용 프로젝트)
  // DRAFT(ai): AWS relay 와 같이 만들기·지우기를 한 줄로. 지우는 대상은 코드가 라벨·이름·설명으로 한 번 더 거른다
  // TODO(human): 출발 프로젝트에는 연결 스크립트가 실행 권한을 안 준다 (gcp-connect.sh: 원래 프로젝트는 svc-observe 만). gcp-onprem 은 지금 손으로 준 권한에 기댄다.
  //   감사 로그로 필요한 Compute 동작을 뽑은 뒤 중계기 전용 역할(platform_relay)을 연결 스크립트·권한 묶음에 둘지 정한다
  relay_gcp: [{ side: "source", purpose: "operate", stage: "apply" }],
  relay_gcp_target: [{ side: "target", purpose: "operate", stage: "apply" }],
  // B-2: 도착 GCP 환경 층(VPC·GKE·AR·ESO 설치) 만들기 (worker env-layer.ts). apply 단계 안에서 만들 때만 따로 빌린다.
  //   발급기는 svc-operate 대신 고객 svc-env 를 빌린다 (gcp-cli.ts gcpTargetFor). stage apply 는 장부 칸(0009 CHECK)용
  env_layer: [{ side: "target", purpose: "operate", stage: "apply", policy: "env_layer" }],
} as const satisfies Record<string, ReadonlyArray<{ side: "source" | "target"; purpose: "observe" | "operate"; stage?: Stage; actions?: StepActionList; policy?: RolePolicy }>>;
export type RoleStep = keyof typeof STEP_ROLES;

/** 단계 표에 적는 동작: 클라우드와 상관없는 목록, 또는 클라우드별 목록 (표에 없는 클라우드는 빌리지 않는다) */
export type StepActionList = readonly string[] | Partial<Record<Provider, readonly string[]>>;
const isList = (a: StepActionList): a is readonly string[] => Array.isArray(a);
/** 단계 줄에 적은 동작 중 이 클라우드 것. 적지 않았으면 null (→ stepActions 가 권한 파일에서 뽑는다) */
export function listedActions(actions: StepActionList | undefined, provider: Provider): string[] | null {
  if (!actions) return null;
  return [...(isList(actions) ? actions : actions[provider] ?? [])];
}
