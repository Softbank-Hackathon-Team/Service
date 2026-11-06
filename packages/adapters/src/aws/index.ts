import type { EnvironmentAdapter } from "@svc/contracts";
import { actionsFor, type PermTable, type Purpose } from "../common/actions.js";
import { sourceImport, platformImageRef, type PermNeeds } from "../common/base.js";
import { AdapterError } from "../common/errors.js";
import { envRef, regionOf, type Target } from "../common/target.js";

// Z44: 예전 이름 그대로 보이게 (aws.repoName). 본체는 common/target.ts
export { repoName } from "../common/target.js";

// 자원 종류 → 권한. infra/modules/aws/app/main.tf가 만드는 종류와 계약 테스트로 맞춘다.
// DRAFT(ai): 권한 목록은 문서 기준 추정. 실계정 AccessDenied 로그로 확인 필요
export const PERMS: PermTable = {
  "data.aws_eks_cluster": {
    read: ["eks:DescribeCluster"], write: [], remove: [] },
  // 토큰은 로컬에서 서명만 함 (STS GetCallerIdentity 미리 서명) → IAM 권한 불필요
  "data.aws_eks_cluster_auth": { read: [], write: [], remove: [] },
  // k8s API 호출 → IAM이 아니라 EKS access entry로 허용 (실행 역할에 네임스페이스 create/delete).
  // DRAFT(ai): 좁게 채택 — access entry는 k8s 그룹 platform:operate만 주고, 그 그룹은 네임스페이스 get/create/patch/delete만
  // (infra/permissions/eks-operate-namespace-rbac.yaml). AmazonEKSAdminPolicy(넓게)는 비상용 대안
  kubernetes_namespace_v1: { read: [], write: [], remove: [] },
  aws_db_instance: {
    read: ["rds:DescribeDBInstances", "rds:ListTagsForResource"],
    write: ["rds:CreateDBInstance", "rds:ModifyDBInstance", "rds:AddTagsToResource"],
    remove: ["rds:DeleteDBInstance"] },
  aws_db_parameter_group: {
    read: ["rds:DescribeDBParameterGroups", "rds:DescribeDBParameters"],
    write: ["rds:CreateDBParameterGroup", "rds:ModifyDBParameterGroup", "rds:AddTagsToResource"],
    remove: ["rds:DeleteDBParameterGroup"] },
  aws_db_subnet_group: {
    read: ["rds:DescribeDBSubnetGroups"],
    write: ["rds:CreateDBSubnetGroup", "rds:AddTagsToResource"],
    remove: ["rds:DeleteDBSubnetGroup"] },
  // TA12 DRAFT(ai): 데이터 자원 종류 권한. 【미확인】 infra/permissions 정책 파일에는 아직 없음(경계 밖 TODO) — 실 apply 전에 정책 파일에 같은 동작을 넣어야 함
  aws_elasticache_replication_group: {
    // VTA12b DRAFT(ai): 【추정】 terraform aws_elasticache_replication_group 읽기는 멤버 클러스터(DescribeCacheClusters)도 부른다 — 빠지면 plan 이 AccessDenied. 읽기 전용이라 천장에 추가. 첫 맥 실측으로 확인
    read: ["elasticache:DescribeCacheClusters", "elasticache:DescribeReplicationGroups", "elasticache:ListTagsForResource"],
    write: ["elasticache:CreateReplicationGroup", "elasticache:ModifyReplicationGroup", "elasticache:AddTagsToResource"],
    remove: ["elasticache:DeleteReplicationGroup"] },
  aws_elasticache_subnet_group: {
    read: ["elasticache:DescribeCacheSubnetGroups"],
    write: ["elasticache:CreateCacheSubnetGroup", "elasticache:AddTagsToResource"],
    remove: ["elasticache:DeleteCacheSubnetGroup"] },
  // ID-6 DRAFT(ai): 【추정】 Terraform AWS provider 는 aws_s3_bucket 을 읽을 때 정책·ACL·웹사이트·가속·요청자 지불·로그·복제·객체 잠금 설정도 부른다.
  //   빠지면 빌린 자격 plan 이 AccessDenied. 읽기라 천장에 더함. 첫 실측(CloudTrail 실제 호출 목록)으로 확인
  aws_s3_bucket: {
    read: ["s3:GetBucketLocation", "s3:GetBucketTagging", "s3:ListBucket",
      "s3:GetBucketPolicy", "s3:GetBucketAcl", "s3:GetBucketWebsite", "s3:GetAccelerateConfiguration", "s3:GetBucketRequestPayment",
      "s3:GetBucketLogging", "s3:GetReplicationConfiguration", "s3:GetBucketObjectLockConfiguration"],
    write: ["s3:CreateBucket", "s3:PutBucketTagging"],
    remove: ["s3:DeleteBucket"] },
  aws_s3_bucket_public_access_block: {
    read: ["s3:GetBucketPublicAccessBlock"], write: ["s3:PutBucketPublicAccessBlock"], remove: ["s3:PutBucketPublicAccessBlock"] },
  aws_s3_bucket_server_side_encryption_configuration: {
    read: ["s3:GetEncryptionConfiguration"], write: ["s3:PutEncryptionConfiguration"], remove: ["s3:PutEncryptionConfiguration"] },
  aws_s3_bucket_versioning: {
    read: ["s3:GetBucketVersioning"], write: ["s3:PutBucketVersioning"], remove: ["s3:PutBucketVersioning"] },
  aws_s3_bucket_lifecycle_configuration: {
    read: ["s3:GetLifecycleConfiguration"], write: ["s3:PutLifecycleConfiguration"], remove: ["s3:PutLifecycleConfiguration"] },
  // B-2 DRAFT(ai): 공개 버킷일 때만 만드는 정책. TODO(human): 실행 역할 천장(infra/permissions)엔 아직 안 넣음 (보안 승인 몫)
  aws_s3_bucket_policy: {
    read: ["s3:GetBucketPolicy"], write: ["s3:PutBucketPolicy"], remove: ["s3:DeleteBucketPolicy"] },
  aws_s3_bucket_cors_configuration: {
    read: ["s3:GetBucketCORS"], write: ["s3:PutBucketCORS"], remove: ["s3:PutBucketCORS"] },
  aws_sqs_queue: {
    read: ["sqs:GetQueueAttributes", "sqs:ListQueueTags", "sqs:GetQueueUrl"],
    write: ["sqs:CreateQueue", "sqs:SetQueueAttributes", "sqs:TagQueue"],
    remove: ["sqs:DeleteQueue"] },
  aws_sns_topic: {
    read: ["sns:GetTopicAttributes", "sns:ListTagsForResource"],
    write: ["sns:CreateTopic", "sns:SetTopicAttributes", "sns:TagResource"],
    remove: ["sns:DeleteTopic"] },
  aws_security_group: {
    read: ["ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules"],
    write: ["ec2:CreateSecurityGroup", "ec2:AuthorizeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupEgress", "ec2:CreateTags"],
    remove: ["ec2:DeleteSecurityGroup"] },
  aws_secretsmanager_secret: {
    read: ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"],
    write: ["secretsmanager:CreateSecret", "secretsmanager:TagResource"],
    remove: ["secretsmanager:DeleteSecret"] },
  aws_iam_role: {
    read: ["iam:GetRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"],
    write: ["iam:CreateRole", "iam:TagRole"],
    // ID-6 DRAFT(ai): 【추정】 역할을 지우기 전에 provider 가 인스턴스 프로파일 목록을 본다
    remove: ["iam:DeleteRole", "iam:ListInstanceProfilesForRole"] },
  aws_iam_role_policy: {
    read: ["iam:GetRolePolicy"],
    write: ["iam:PutRolePolicy"],
    remove: ["iam:DeleteRolePolicy"] },
  aws_eks_pod_identity_association: {
    read: ["eks:DescribePodIdentityAssociation"],
    // 2026-11-07 온프레 → AWS 실측: app 루트 모듈 provider default_tags 가 연결에 태그를 붙여 eks:TagResource 가 없으면 AccessDenied
    write: ["eks:CreatePodIdentityAssociation", "eks:TagResource", "iam:PassRole"],
    remove: ["eks:DeletePodIdentityAssociation"] },
  // TA13 DRAFT(ai): 관리형 컨테이너(ECS Fargate) 도착 — root(service_json) + kinds/service-ecs 가 만드는 종류.
  //   TODO(human): 실행 역할 천장(infra/permissions/aws-operate-role-policy.json)·세션 정책엔 아직 안 넣음 (PassRole 대상 ecs-tasks, 보안 승인 몫)
  "data.aws_caller_identity": { read: ["sts:GetCallerIdentity"], write: [], remove: [] },
  aws_ecs_cluster: {
    read: ["ecs:DescribeClusters"], write: ["ecs:CreateCluster", "ecs:TagResource"], remove: ["ecs:DeleteCluster"] },
  aws_service_discovery_http_namespace: {
    read: ["servicediscovery:GetNamespace", "servicediscovery:ListTagsForResource"],
    write: ["servicediscovery:CreateHttpNamespace", "servicediscovery:GetOperation", "servicediscovery:TagResource"],
    remove: ["servicediscovery:DeleteNamespace"] },
  aws_cloudwatch_log_group: {
    read: ["logs:DescribeLogGroups", "logs:ListTagsForResource"],
    write: ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:TagResource"], remove: ["logs:DeleteLogGroup"] },
  aws_ecs_task_definition: {
    read: ["ecs:DescribeTaskDefinition"], write: ["ecs:RegisterTaskDefinition", "iam:PassRole"], remove: ["ecs:DeregisterTaskDefinition"] },
  aws_ecs_service: {
    read: ["ecs:DescribeServices"], write: ["ecs:CreateService", "ecs:UpdateService", "iam:PassRole"], remove: ["ecs:DeleteService"] },
  // JOBMOD DRAFT(ai): 예약 잡(EventBridge Scheduler → ECS RunTask). kinds/job 이 만드는 종류. 천장 파일엔 아직 안 넣음 (TA13 과 같은 이유, 보안 승인 몫)
  aws_scheduler_schedule: {
    read: ["scheduler:GetSchedule", "scheduler:ListTagsForResource"],
    write: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:TagResource", "iam:PassRole"], remove: ["scheduler:DeleteSchedule"] },
  // RUNTIMEMAP v2 DRAFT(ai): VM 도착(EC2) — kinds/vm 이 만드는 종류. 천장 파일엔 아직 안 넣음 (TA13 과 같은 이유, 보안 승인 몫)
  //   인스턴스 프로파일 = iam:PassRole(역할) + iam:AddRoleToInstanceProfile. AMI 는 SSM 공개 매개변수(AL2023) 읽기
  "data.aws_ssm_parameter": { read: ["ssm:GetParameter"], write: [], remove: [] },
  aws_iam_instance_profile: {
    read: ["iam:GetInstanceProfile", "iam:ListInstanceProfileTags"],
    write: ["iam:CreateInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:TagInstanceProfile", "iam:PassRole"],
    remove: ["iam:DeleteInstanceProfile", "iam:RemoveRoleFromInstanceProfile"] },
  aws_instance: {
    read: ["ec2:DescribeInstances", "ec2:DescribeInstanceAttribute", "ec2:DescribeInstanceTypes", "ec2:DescribeVolumes", "ec2:DescribeTags", "ec2:DescribeInstanceCreditSpecifications"],
    write: ["ec2:RunInstances", "ec2:CreateTags", "ec2:ModifyInstanceAttribute", "ec2:StopInstances", "ec2:StartInstances", "iam:PassRole"],
    remove: ["ec2:TerminateInstances"] },
  aws_appautoscaling_target: {
    read: ["application-autoscaling:DescribeScalableTargets"],
    write: ["application-autoscaling:RegisterScalableTarget"], remove: ["application-autoscaling:DeregisterScalableTarget"] },
  aws_appautoscaling_policy: {
    read: ["application-autoscaling:DescribeScalingPolicies"],
    write: ["application-autoscaling:PutScalingPolicy"], remove: ["application-autoscaling:DeleteScalingPolicy"] },
};

// DECISION(team): 도착 컴퓨트는 출발과 같은 종류 — 출발이 쿠버네티스면 쿠버네티스(AWS=EKS, GKE·k3s와 같은 Helm 차트), 출발이 ECS(관리형 컨테이너)면 ECS(GCP 도착이면 Cloud Run) (2026-10-31 EKS 결정, 2026-11-02 ECS 추가)
export function resourceTypes(need: PermNeeds): string[] {
  const t = ["data.aws_eks_cluster", "data.aws_eks_cluster_auth", "kubernetes_namespace_v1", "aws_iam_role", "aws_iam_role_policy", "aws_eks_pod_identity_association"];
  if (need.secrets) t.push("aws_secretsmanager_secret");
  if (need.database) t.push("aws_db_instance", "aws_db_parameter_group", "aws_db_subnet_group", "aws_security_group");
  return t.sort();
}

export const operateActions = (need: PermNeeds, purpose: Purpose) => actionsFor(PERMS, resourceTypes(need), purpose);

// 실행 역할을 AssumeRole 할 때 붙이는 세션 정책 (호출마다 더 좁힘). AWS 제한 2,048자
export function sessionPolicy(need: PermNeeds, purpose: Purpose): string {
  const doc = JSON.stringify({ Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: operateActions(need, purpose), Resource: "*" }] });
  if (doc.length > 2048) throw new AdapterError("SESSION_POLICY_TOO_LONG", `세션 정책 ${doc.length}자 > 2048`);
  return doc;
}

// 앱 역할의 권한 경계 = 앱 역할이 가질 수 있는 최대치. 플랫폼이 만든 시크릿 읽기만 (위협 모델 A-4).
// infra/modules/aws/env 가 이 내용(infra/permissions/aws-app-role-boundary.json)으로 정책을 만든다
export const BOUNDARY_NAME = "platform-app-boundary";
// A8fix DRAFT(ai): 옮긴 IAM 권한(A8 grants)이 실제로 먹게, 플랫폼이 만든 데이터 자원(이름 "app-" 접두어, target/data.ts)의
//   데이터 동작만 경계에 더한다. 관리 동작(버킷 정책·큐 삭제 등)·RDS·ElastiCache 는 안 넣음 → 그런 grants 는 precheck warn 이 남음
// TODO(human): 경계 확대 범위 확인 (위협 모델 A-4: 앱 역할 최대치가 "자기 시크릿 읽기" → "+ app- 버킷·큐 데이터 읽기·쓰기")
export const BOUNDARY_GRANT_ACTIONS = {
  s3: ["s3:AbortMultipartUpload", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:GetBucketLocation", "s3:GetObject", "s3:GetObjectVersion",
    "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:ListBucketVersions", "s3:ListMultipartUploadParts", "s3:PutObject"],
  sqs: ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ReceiveMessage", "sqs:SendMessage"],
} as const;
export function appRoleBoundary(region: string) {
  return { Version: "2012-10-17", Statement: [{
    Sid: "OwnSecretsOnly", Effect: "Allow",
    Action: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
    Resource: [`arn:aws:secretsmanager:${region}:*:secret:platform/*`, `arn:aws:secretsmanager:${region}:*:secret:rds!*`],
  }, {
    Sid: "MigratedDataGrants", Effect: "Allow",
    Action: [...BOUNDARY_GRANT_ACTIONS.s3, ...BOUNDARY_GRANT_ACTIONS.sqs],
    Resource: ["arn:aws:s3:::app-*", "arn:aws:s3:::app-*/*", `arn:aws:sqs:${region}:*:app-*`],
  }] };
}

export const awsAdapter: EnvironmentAdapter = {
  provider: "aws",
  version: "aws@0.5.0",
  capabilities: () => ["workload.container", "arch.amd64", "arch.arm64", "ingress.cloudflared", "ingress.alb",
    "secrets.external", "db.postgres.15", "db.postgres.16", "db.postgres.17"],
  // Z88: 진짜 읽기 = aws CLI(현재 자격·AWS_PROFILE)로 EKS 앱·RDS·VPC·ALB·ECR·Secrets Manager. MOCK_SEED=1 이면 데모 원본
  ...sourceImport("aws"),
  imageRef: (src: string, t: Target) =>
    platformImageRef(`${t.accountId ?? envRef("accountId")}.dkr.ecr.${regionOf(t)}.amazonaws.com`, t, src),
};
