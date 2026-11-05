// 고객 AWS 계정 연결 템플릿(CloudFormation JSON) 생성. 입력은 export-permissions.ts가 만든 정책 문서 두 개.
// 순수 함수(파일·네트워크 없음): 같은 입력이면 같은 템플릿. 실행 정책과 템플릿 속 정책이 어긋나지 않게 한 곳에서 만든다
// DRAFT(ai): 생성기 안에 두되 파일을 분리했다. 단독으로 실행·시험할 수 있게(의존성 0)

import { AWS_DATA_READ_ACTIONS } from "../src/discover/data.js";
import { AWS_COMMAND_ACTIONS, actionsOfCommands } from "../src/common/observe-permissions.js";
import { AWS_OBSERVE_PENDING } from "../src/common/observe-pending.js";
import { sourceDbLinkOperatePolicy } from "../src/aws/source-db-link.js";

type Json = Record<string, unknown>;

// DRAFT(ai): 역할 이름 고정. worker/src/platform.ts resolveEnv가 이 이름으로 ARN을 조립한다
export const OBSERVE_ROLE_NAME = "svc-observe";
export const OPERATE_ROLE_NAME = "svc-operate";
export const BOUNDARY_POLICY_NAME = "platform-app-boundary";
// DRAFT(ai): 관찰 역할 관리형 정책은 이 하나로 고정. ReadOnlyAccess는 S3·DynamoDB 데이터까지 읽어서 금지
export const VIEW_ONLY_ARN = "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess";
export const EKS_VIEW_POLICY_ARN = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy";
export const OPERATE_K8S_GROUP = "platform:operate";
// ID-1: Argo CD 허브가 고객 도착 클러스터에 앱을 쓰는 신원. 고객 계정 안 역할 svc-deploy (허브 역할이 빌림) → k8s 그룹 platform:deploy.
//   그룹 권한은 클러스터 전체가 아니라 앱 네임스페이스의 RoleBinding 으로만 (infra/permissions/eks-deploy-rbac.yaml)
export const DEPLOY_ROLE_NAME = "svc-deploy";
export const DEPLOY_K8S_GROUP = "platform:deploy";
// 역할 ARN만 허용(사용자·:root 거부)
// DRAFT(ai) PRINCIPALUSER: 플랫폼 주체 = IAM 역할 또는 IAM 사용자 (데모 계정은 사용자 키). :root·sts assumed-role 은 거부. API 설정 검사(contracts config.ts PLATFORM_PRINCIPAL_ARN)와 같은 규칙
export const PRINCIPAL_PATTERN = "^arn:aws:iam::\\d{12}:(role|user)/.+$";

// DRAFT(ai): 관찰 인라인 = GuardDuty 읽기 5 + EKS 읽기 3 + IAM 근거 읽기 6 + 데이터 자원 메타데이터 읽기 13 + 그 밖 모든 읽기 명령의 권한(표 원본 observe-permissions.ts). 쓰기 동작 0, 객체·메시지 내용 읽기 0
export const OBSERVE_EXTRA_ACTIONS: string[] = [...new Set([
  "guardduty:ListDetectors", "guardduty:GetDetector", "guardduty:ListFindings", "guardduty:GetFindings", "guardduty:GetFindingsStatistics",
  "eks:DescribeCluster", "eks:ListPodIdentityAssociations", "eks:DescribePodIdentityAssociation",
  "iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:GetPolicy", "iam:GetPolicyVersion",
  // OBSROLE: 데이터 자원(S3·SQS·ElastiCache) 메타데이터 읽기 13. 객체·메시지·버킷 정책 본문은 못 읽음. 목록 원본 = adapters/src/discover/data.ts
  ...AWS_DATA_READ_ACTIONS,
  // OBSROLE2: 플랫폼이 관찰 역할로 부르는 나머지 모든 읽기 명령의 권한 (표 원본 = adapters/src/common/observe-permissions.ts).
  //   ViewOnlyAccess 에 들어 있는지는 【미확인】이라 인라인에 직접 적는다 (중복은 무해). 시험이 소스의 모든 명령과 대조
  ...actionsOfCommands("aws", Object.keys(AWS_COMMAND_ACTIONS)),
  // DRAFT(ai) 관찰 권한 넓힘 (가져오기 갈래 요청, 읽기 전용). 목록 원본 = adapters/src/common/observe-pending.ts
  ...AWS_OBSERVE_PENDING,
  // 리허설 이미지 복사(worker rehearsal/image-mirror.ts)가 출발 ECR 에서 다이제스트로 받는 세 동작. 요청 원본 = security STEP_ROLES.image_mirror (시험이 대조)
  //   ViewOnlyAccess 에 들어 있는지 【미확인】이라 인라인에 직접 적는다. 받기만 하고 올리기·지우기는 없다
  "ecr:BatchGetImage", "ecr:GetAuthorizationToken", "ecr:GetDownloadUrlForLayer",
])];

// 두 역할 공통 신뢰 정책. TagSession·SetSourceIdentity가 없으면 발급기의 AssumeRole(Tags·SourceIdentity 항상 포함)이 AccessDenied
// FM-CON-06 (실측 2회차): 세 동작을 sts:ExternalId 조건 한 문장에 두면 TagSession·SetSourceIdentity 판정에는 ExternalId 키가 없어
//   거부됐다 (맥 확인: ExternalId 만 = 성공, +--tags = TagSession 거부, +--source-identity = SetSourceIdentity 거부).
//   → AssumeRole 은 ExternalId 조건 그대로, TagSession·SetSourceIdentity 는 같은 주체·조건 없이 따로. 두 동작만으로는 역할을 못 빌리니 혼동된 대리인 방어는 그대로
const trust = (): Json => ({
  Version: "2012-10-17",
  Statement: [{
    Sid: "AssumeWithExternalId",
    Effect: "Allow",
    Principal: { AWS: { Ref: "PlatformPrincipalArn" } },
    Action: "sts:AssumeRole",
    Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } } },
  }, {
    Sid: "SessionTagsAndSourceIdentity",
    Effect: "Allow",
    Principal: { AWS: { Ref: "PlatformPrincipalArn" } },
    Action: ["sts:TagSession", "sts:SetSourceIdentity"],
  }],
});

export function buildAwsConnectTemplate(operatePolicy: Json, boundaryPolicy: Json): Json {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "플랫폼 연결: 관찰 역할(svc-observe)·실행 역할(svc-operate)과 EKS 접근 항목을 만든다 (자동 생성, 직접 고치지 않음)",
    Parameters: {
      ExternalId: {
        Type: "String", MinLength: 32, // NoEcho 쓰지 않음: NoEcho면 빠른 생성 링크로 못 넘김
        AllowedPattern: "^[A-Za-z0-9_+=,.@:/-]+$",
        Description: "플랫폼이 알려 준 값 그대로. 역할을 빌릴 때 같이 내야 하는 비밀 아닌 확인값",
      },
      PlatformPrincipalArn: {
        Type: "String", AllowedPattern: PRINCIPAL_PATTERN,
        ConstraintDescription: "플랫폼 워커 역할·사용자 ARN(arn:aws:iam::<12자리>:role/... 또는 :user/...)만. :root·assumed-role 은 거부",
        Description: "역할을 빌릴 수 있는 플랫폼 쪽 역할 하나",
      },
      EksClusterName: { Type: "String", MinLength: 1, Description: "이전 대상 EKS 클러스터 이름" },
      // ID-1 DRAFT(ai): 비우면 배포 역할을 안 만든다 (예전 템플릿과 같음). 값 = 플랫폼 Argo CD 허브 역할 ARN
      ArgoHubRoleArn: {
        Type: "String", Default: "", AllowedPattern: "^$|arn:aws:iam::\\d{12}:role/.+$", // Argo 허브는 역할만 (플랫폼 주체만 IAM 사용자 허용)
        ConstraintDescription: "비우거나 Argo CD 허브 역할 ARN(arn:aws:iam::<12자리>:role/...)만",
        Description: "도착 클러스터에 앱을 배포할 플랫폼 Argo CD 허브 역할 (비우면 배포 역할 없음)",
      },
      CreateBoundaryPolicy: {
        Type: "String", Default: "true", AllowedValues: ["true", "false"],
        Description: "같은 계정에 platform-app-boundary 정책이 이미 있으면 false (이름 충돌 방지)",
      },
    },
    Conditions: {
      CreateBoundary: { "Fn::Equals": [{ Ref: "CreateBoundaryPolicy" }, "true"] },
      HasArgoHub: { "Fn::Not": [{ "Fn::Equals": [{ Ref: "ArgoHubRoleArn" }, ""] }] },
    },
    Resources: {
      // 실행 정책이 앱 역할에 요구하는 권한 경계. svc-operate에는 붙이지 않는다(붙이면 실행 역할이 거의 아무것도 못 함)
      BoundaryPolicy: {
        Type: "AWS::IAM::ManagedPolicy", Condition: "CreateBoundary",
        Properties: { ManagedPolicyName: BOUNDARY_POLICY_NAME, PolicyDocument: boundaryPolicy },
      },
      // 문서에 ${aws:PrincipalAccount}가 있으나 Fn::Sub를 쓰지 않으므로 문자열 그대로 남고 IAM이 푼다
      OperatePolicy: {
        Type: "AWS::IAM::ManagedPolicy",
        Properties: { ManagedPolicyName: "svc-operate-policy", PolicyDocument: operatePolicy },
      },
      ObserveRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: OBSERVE_ROLE_NAME, MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: trust(),
          ManagedPolicyArns: [VIEW_ONLY_ARN],
          Policies: [{
            PolicyName: "observe-extra",
            PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: OBSERVE_EXTRA_ACTIONS, Resource: "*" }] },
          }],
        },
      },
      OperateRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: OPERATE_ROLE_NAME, MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: trust(),
          ManagedPolicyArns: [{ Ref: "OperatePolicy" }],
          // APP-22 (가): 출발 RDS 보안 그룹에 도착 나가는 IP 규칙 열기·닫기. 표시 태그(svc:source-db-link=open)가 붙은 그룹에서만.
          //   관리형 정책(svc-operate-policy)은 6,144자 한도에 거의 차서 인라인으로 (역할과 같이 지워짐 → cloud-zero 세기 바뀜 없음)
          Policies: [{ PolicyName: "source-db-link", PolicyDocument: sourceDbLinkOperatePolicy() }],
        },
      },
      // 관찰 = EKS 기본 보기 정책(클러스터 범위)
      // STUB: 정책 이름은 일반 지식 기반. cfn validate·실측으로 확인
      ObserveAccess: {
        Type: "AWS::EKS::AccessEntry",
        Properties: {
          ClusterName: { Ref: "EksClusterName" }, PrincipalArn: { "Fn::GetAtt": ["ObserveRole", "Arn"] },
          AccessPolicies: [{ PolicyArn: EKS_VIEW_POLICY_ARN, AccessScope: { Type: "cluster" } }],
        },
      },
      // 실행 = 그룹만. 권한은 infra/permissions/eks-operate-namespace-rbac.yaml(고객이 kubectl로 1회 적용)
      OperateAccess: {
        Type: "AWS::EKS::AccessEntry",
        Properties: {
          ClusterName: { Ref: "EksClusterName" }, PrincipalArn: { "Fn::GetAtt": ["OperateRole", "Arn"] },
          KubernetesGroups: [OPERATE_K8S_GROUP],
        },
      },
      // ID-1: Argo CD 허브가 빌리는 배포 역할. IAM 권한 0 (토큰 서명만 하므로 필요 없음), k8s 권한은 아래 접근 항목 그룹으로만.
      // DRAFT(ai): 신뢰 = 허브 역할 하나 + sts:AssumeRole 만. ExternalId 조건은 없다 — Argo CD 의 EKS 인증(awsAuthConfig.roleARN)은
      //   ExternalId 를 넘기지 못한다【추정】. 대신 플랫폼은 관찰 역할로(ExternalId 확인) 연결이 확인된 계정에만 클러스터를 등록한다.
      // TODO(human): 권한 회수 시점(이전 끝·롤백 창 끝에 RoleBinding 을 지울지, 연결 해제 때까지 둘지), ExternalId 없는 신뢰를 받아들일지
      DeployRole: {
        Type: "AWS::IAM::Role", Condition: "HasArgoHub",
        Properties: {
          RoleName: DEPLOY_ROLE_NAME, MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{
            Effect: "Allow", Principal: { AWS: { Ref: "ArgoHubRoleArn" } }, Action: "sts:AssumeRole",
          }] },
        },
      },
      // 배포 = 그룹만, 접근 정책(클러스터 범위) 없음. 앱 네임스페이스마다 RoleBinding(ClusterRole platform-deploy-app)으로 묶는다
      DeployAccess: {
        Type: "AWS::EKS::AccessEntry", Condition: "HasArgoHub",
        Properties: {
          ClusterName: { Ref: "EksClusterName" }, PrincipalArn: { "Fn::GetAtt": ["DeployRole", "Arn"] },
          KubernetesGroups: [DEPLOY_K8S_GROUP],
        },
      },
    },
    Outputs: {
      ObserveRoleArn: { Value: { "Fn::GetAtt": ["ObserveRole", "Arn"] } },
      OperateRoleArn: { Value: { "Fn::GetAtt": ["OperateRole", "Arn"] } },
      DeployRoleArn: { Condition: "HasArgoHub", Value: { "Fn::GetAtt": ["DeployRole", "Arn"] } },
    },
  };
}

// 직접 실행: node --experimental-strip-types aws-connect-template.ts <permissions 폴더> <출력 폴더>
// (export-permissions.ts가 같은 함수를 부른다)
