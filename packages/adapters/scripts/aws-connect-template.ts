// 고객 AWS 계정 연결 템플릿(CloudFormation JSON) 생성. 입력은 export-permissions.ts가 만든 정책 문서 두 개.
// 순수 함수(파일·네트워크 없음): 같은 입력이면 같은 템플릿. 실행 정책과 템플릿 속 정책이 어긋나지 않게 한 곳에서 만든다
// DRAFT(ai): 생성기 안에 두되 파일을 분리했다. 단독으로 실행·시험할 수 있게(의존성 0)

import { AWS_DATA_READ_ACTIONS } from "../src/discover/data.js";

type Json = Record<string, unknown>;

// DRAFT(ai): 역할 이름 고정. worker/src/platform.ts resolveEnv가 이 이름으로 ARN을 조립한다
export const OBSERVE_ROLE_NAME = "svc-observe";
export const OPERATE_ROLE_NAME = "svc-operate";
export const BOUNDARY_POLICY_NAME = "platform-app-boundary";
// DRAFT(ai): 관찰 역할 관리형 정책은 이 하나로 고정. ReadOnlyAccess는 S3·DynamoDB 데이터까지 읽어서 금지
export const VIEW_ONLY_ARN = "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess";
export const EKS_VIEW_POLICY_ARN = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy";
export const OPERATE_K8S_GROUP = "platform:operate";
// 역할 ARN만 허용(사용자·:root 거부)
export const PRINCIPAL_PATTERN = "^arn:aws:iam::\\d{12}:role/.+$";

// DRAFT(ai): 관찰 인라인 = GuardDuty 읽기 5 + EKS 읽기 3 + IAM 근거 읽기 6 + 데이터 자원 메타데이터 읽기 12. 쓰기 동작 0, 객체·메시지 내용 읽기 0
// TODO(human): ecr:BatchGetImage 등 이미지 저장소 읽기는 ViewOnlyAccess에 없을 수 있음(미확인). 샌드박스 이미지 복사 때 추가
export const OBSERVE_EXTRA_ACTIONS = [
  "guardduty:ListDetectors", "guardduty:GetDetector", "guardduty:ListFindings", "guardduty:GetFindings", "guardduty:GetFindingsStatistics",
  "eks:DescribeCluster", "eks:ListPodIdentityAssociations", "eks:DescribePodIdentityAssociation",
  "iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:GetPolicy", "iam:GetPolicyVersion",
  // OBSROLE: 데이터 자원(S3·SQS·ElastiCache) 메타데이터 읽기 12. 객체·메시지·버킷 정책 본문은 못 읽음. 목록 원본 = adapters/src/discover/data.ts
  ...AWS_DATA_READ_ACTIONS,
];

// 두 역할 공통 신뢰 정책. TagSession·SetSourceIdentity가 없으면 발급기의 AssumeRole(Tags·SourceIdentity 항상 포함)이 AccessDenied
const trust = (): Json => ({
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: { AWS: { Ref: "PlatformPrincipalArn" } },
    Action: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
    Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } } },
  }],
});

export function buildAwsConnectTemplate(operatePolicy: Json, boundaryPolicy: Json): Json {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "플랫폼 연결: 관찰 역할(svc-observe)·실행 역할(svc-operate)과 EKS 접근 항목을 만든다 (자동 생성, 직접 고치지 않음)",
    Parameters: {
      ExternalId: {
        Type: "String", MinLength: 32, // NoEcho 쓰지 않음: NoEcho면 빠른 생성 링크로 못 넘김
        AllowedPattern: "^[A-Za-z0-9+=,.@:/-]+$",
        Description: "플랫폼이 알려 준 값 그대로. 역할을 빌릴 때 같이 내야 하는 비밀 아닌 확인값",
      },
      PlatformPrincipalArn: {
        Type: "String", AllowedPattern: PRINCIPAL_PATTERN,
        ConstraintDescription: "플랫폼 워커 역할 ARN(arn:aws:iam::<12자리>:role/...)만. 사용자·:root는 거부",
        Description: "역할을 빌릴 수 있는 플랫폼 쪽 역할 하나",
      },
      EksClusterName: { Type: "String", MinLength: 1, Description: "이전 대상 EKS 클러스터 이름" },
      CreateBoundaryPolicy: {
        Type: "String", Default: "true", AllowedValues: ["true", "false"],
        Description: "같은 계정에 platform-app-boundary 정책이 이미 있으면 false (이름 충돌 방지)",
      },
    },
    Conditions: { CreateBoundary: { "Fn::Equals": [{ Ref: "CreateBoundaryPolicy" }, "true"] } },
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
    },
    Outputs: {
      ObserveRoleArn: { Value: { "Fn::GetAtt": ["ObserveRole", "Arn"] } },
      OperateRoleArn: { Value: { "Fn::GetAtt": ["OperateRole", "Arn"] } },
    },
  };
}

// 직접 실행: node --experimental-strip-types aws-connect-template.ts <permissions 폴더> <출력 폴더>
// (export-permissions.ts가 같은 함수를 부른다)
